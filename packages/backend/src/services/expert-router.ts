
import { nanoid } from 'nanoid';
import { expertRoutingConfigDb, expertRoutingLogDb, expertRoutingSessionBindingDb, expertRoutingTrainingRecordDb } from '../db/index.js';
import { memoryLogger } from './logger.js';
import { ExpertRoutingConfig } from '../types/index.js';
import { ExpertTarget } from '../types/expert-routing.js';
import crypto from 'crypto';
import { isEligibleExpertRoutingLabel, EXPERT_ROUTING_MODEL_REPO } from '@llm-gateway/shared';

import { SignalBuilder } from './expert-router/preprocess/index.js';
import { LLMJudge } from './expert-router/decision/llm-judge.js';
import { resolveModelConfig, matchExpert } from './expert-router/resolve.js';
import { RouteDecision, ProxyRequest } from './expert-router/types.js';
import { extractExpertRoutingSessionId } from './expert-router/session-binding.js';
import { resolveBindingScope, type SessionBindingKey } from '../db/repositories/expert-routing-session-binding.repository.js';
import { classifyWithLocalOnnx, type LocalClassifyResult } from './expert-router/local/classifier.js';
import { isLocalClassifierReady, loadLocalClassifierAssets } from './expert-router/local/model-assets.js';

interface RoutingContext {
  modelId?: string;
  virtualKeyId?: string;
}

interface ExpertRoutingResult {
  provider: any;
  providerId: string;
  modelOverride?: string;
  category: string;
  expert: ExpertTarget;
  classificationTime: number;
  expertType: 'virtual' | 'real';
  expertName: string;
  expertModelId?: string;
  thinking_enabled?: boolean;
  enable_adaptive_thinking?: boolean;
}

const LOCAL_CLASSIFIER_MODEL_NAME = `onnx/${EXPERT_ROUTING_MODEL_REPO}`;

export class ExpertRouter {
  /**
   * Core Expert Routing flow:
   *   1. (session) read durable binding → if valid, route directly without inference
   *   2. local ONNX classify → eligible+passing+mapped expert (local_onnx)
   *   3. LLM second pass when local rejects / returns ineligible / unmapped / errored
   *   4. fallback when no expert resolves
   *   5. persist a durable binding only for a resolved local_onnx/llm_second_pass expert
   *
   * See FR-1..FR-15 and NFR-3/NFR-4 for the binding and policy semantics.
   */
  async route(
    request: ProxyRequest,
    expertRoutingId: string,
    context: RoutingContext
  ): Promise<ExpertRoutingResult> {
    const startTime = Date.now();

    const expertRoutingConfig = await expertRoutingConfigDb.getById(expertRoutingId);
    if (!expertRoutingConfig || expertRoutingConfig.enabled !== 1) {
      throw new Error('Expert routing config not found or disabled');
    }

    const config: ExpertRoutingConfig = JSON.parse(expertRoutingConfig.config);
    const sessionId = extractExpertRoutingSessionId(request);
    const scope = resolveBindingScope(context.virtualKeyId);
    const bindingKey: SessionBindingKey = {
      expertRoutingId,
      virtualKeyScope: scope,
      sessionId: sessionId || '',
    };

    if (config.experts && config.experts.length > 0) {
      const expertsInfo = config.experts
        .map((e) => `[${e.id}] ${e.category}=${e.type}:${e.model_id || e.provider_id}`)
        .join('; ');
      memoryLogger.info(`Expert routing experts | total=${config.experts.length} | ${expertsInfo}`, 'ExpertRouter');
    }

    // 1. Durable session binding read (FR-6, FR-7).
    if (sessionId) {
      const binding = await expertRoutingSessionBindingDb.getActiveBinding(
        bindingKey,
        config.session_binding_policy.idle_ttl_seconds
      );
      if (binding) {
        const boundExpert = findExpertById(config.experts, binding.expert_id);
        if (boundExpert) {
          try {
            memoryLogger.info(
              `Expert routing session hit | session=${sessionId} | expertId=${binding.expert_id} | source=${binding.route_source}`,
              'ExpertRouter'
            );
            return await this.resolveExpert(boundExpert, {
              category: boundExpert.category,
              confidence: 1,
              source: 'session',
              metadata: { sessionId, sessionRouteSource: binding.route_source },
            }, 0, expertRoutingId, context, request, 'session', config, undefined);
          } catch (e) {
            // FR-9: bound expert no longer resolvable → drop binding and classify fresh.
            await expertRoutingSessionBindingDb.deleteBinding(bindingKey);
            memoryLogger.warn(
              `Expert routing session binding dropped (resolve failed) | session=${sessionId} | expertId=${binding.expert_id}`,
              'ExpertRouter'
            );
          }
        } else {
          // FR-9: binding references a removed/disabled expert.
          await expertRoutingSessionBindingDb.deleteBinding(bindingKey);
          memoryLogger.info(
            `Expert routing session binding invalidated (expert gone) | session=${sessionId} | expertId=${binding.expert_id}`,
            'ExpertRouter'
          );
        }
      }
    }

    // 2. Build routing signal (preprocessing).
    let signal;
    try {
      signal = await SignalBuilder.buildRoutingSignal(request, config.preprocessing);
    } catch (e: any) {
      throw new Error(`Failed to build routing signal: ${e.message}`);
    }

    if (signal.stats) {
      const s = signal.stats;
      if (typeof s.originalTokens === 'number' && typeof s.cleanedTokens === 'number') {
        const pct = typeof s.removedTokensPct === 'number' ? (s.removedTokensPct * 100).toFixed(1) : '0.0';
        memoryLogger.debug(
          `Preprocess: intentTokens=${s.originalTokens}->${s.cleanedTokens} (removed=${s.removedTokens ?? 0}, ${pct}%) promptTokens=${s.promptTokens}`,
          'ExpertRouter'
        );
      }
    }

    // 3. Local ONNX classification (local_onnx) when assets are ready.
    let candidateExpert: ExpertTarget | null = null;
    let candidateSource: RouteDecision['source'] = 'local_onnx';
    let candidateMeta: Record<string, any> = {};
    let localResult: LocalClassifyResult | null = null;

    if (isLocalClassifierReady()) {
      try {
        localResult = await classifyWithLocalOnnx(signal.intentText, config.local_classifier.max_tokens);
        candidateMeta.local = {
          revision: localResult.revision,
          latencyMs: localResult.latencyMs,
          seqLen: localResult.seqLen,
          truncated: localResult.truncated,
          top1: localResult.policy.top1,
          top2: localResult.policy.top2,
          rejected: localResult.policy.rejected,
          rejectionReason: localResult.policy.rejectionReason,
          matchedKeywordIntent: localResult.policy.matchedKeywordIntent,
          appliedFlip: localResult.policy.appliedFlip,
          chosenLabel: localResult.policy.chosenLabel,
        };
        // Make the local classifier request auditable; otherwise the log field renders as '{}'.
        candidateMeta.classifierRequest = {
          model: LOCAL_CLASSIFIER_MODEL_NAME,
          input: signal.intentText,
          max_tokens: config.local_classifier.max_tokens,
        };

        const chosen = localResult.policy.chosenLabel;
        const eligible = !localResult.policy.rejected && isEligibleExpertRoutingLabel(chosen);
        memoryLogger.debug(
          `Local ONNX | chosen=${chosen} | top1=${localResult.policy.top1?.label}:${(localResult.policy.top1?.score ?? 0).toFixed(3)} | rejected=${localResult.policy.rejected}(${localResult.policy.rejectionReason ?? ''}) | eligible=${eligible}`,
          'ExpertRouter'
        );

        if (eligible) {
          const expert = matchExpert(chosen, config.experts);
          if (expert) {
            candidateExpert = expert;
            candidateSource = 'local_onnx';
          } else {
            memoryLogger.info(`Local ONNX label "${chosen}" has no mapped expert → LLM second pass`, 'ExpertRouter');
          }
        } else {
          memoryLogger.info(
            `Local ONNX ineligible/rejected ("${chosen}") → LLM second pass`,
            'ExpertRouter'
          );
        }
      } catch (e: any) {
        memoryLogger.error(`Local ONNX classifier failed: ${e.message} → LLM second pass`, 'ExpertRouter');
        candidateMeta.localError = e?.message || String(e);
      }
    } else {
      candidateMeta.localUnavailable = true;
      memoryLogger.warn('Local ONNX classifier not ready → LLM second pass', 'ExpertRouter');
    }

    // 4. LLM second pass when local did not resolve a candidate (FR-5).
    let llmJudgeFailedRequest: any = null;
    if (!candidateExpert) {
      if (signal.intentText && signal.intentText.trim().length > 0) {
        try {
          const decision = await LLMJudge.decide(signal, config.llm_second_pass);
          candidateMeta.llm = decision.metadata;
          const expert = isEligibleExpertRoutingLabel(decision.category)
            ? matchExpert(decision.category, config.experts)
            : null;
          await this.archiveLlmDecision(
            expertRoutingId,
            signal.intentText,
            localResult,
            decision,
            expert?.id
          );
          if (expert) {
            candidateExpert = expert;
            candidateSource = 'llm_second_pass';
            candidateMeta.llmCategory = decision.category;
            candidateMeta.thinking_enabled = decision.thinking_enabled;
            memoryLogger.debug(`LLM second pass resolved expert | category=${decision.category} | expertId=${expert.id}`, 'ExpertRouter');
          } else {
            memoryLogger.warn(`LLM second pass category "${decision.category}" has no mapped expert → fallback`, 'ExpertRouter');
          }
        } catch (e: any) {
          memoryLogger.error(`LLM second pass failed: ${e.message} → fallback`, 'ExpertRouter');
          llmJudgeFailedRequest = (e as any).classifierRequest || null;
          candidateMeta.llmError = e?.message || String(e);
        }
      } else {
        memoryLogger.warn('No intent text for LLM second pass → fallback', 'ExpertRouter');
      }
    }

    // 5. Resolve candidate expert or fall back.
    if (candidateExpert) {
      const classificationTime = Date.now() - startTime;
      const classifierModelName = candidateSource === 'local_onnx'
        ? `${LOCAL_CLASSIFIER_MODEL_NAME}`
        : await this.llmSecondPassModelName(config);

      const result = await this.resolveExpert(
        candidateExpert,
        {
          category: candidateExpert.category,
          confidence: candidateSource === 'local_onnx' ? (localResult?.policy.top1.score ?? 0) : 1,
          source: candidateSource,
          metadata: candidateMeta,
          thinking_enabled: candidateMeta.thinking_enabled,
        },
        classificationTime,
        expertRoutingId,
        context,
        request,
        candidateSource,
        config,
        signal.stats,
        classifierModelName
      );

      // FR-8 / NFR-3: persist a durable binding only on a successful
      // local_onnx or llm_second_pass resolution, using first-writer-wins.
      if (sessionId) {
        await this.persistBindingRaceSafe(
          bindingKey,
          candidateExpert,
          candidateSource,
          config,
          classificationTime
        );
      }

      return result;
    }

    // No candidate resolved → fallback. No binding is persisted (FR-8).
    return await this.resolveFallback(
      config.fallback,
      'routing_failed',
      startTime,
      expertRoutingId,
      context,
      request,
      signal.stats,
      llmJudgeFailedRequest,
      candidateMeta
    );
  }

  /**
   * First-writer-wins binding persistence (NFR-3). On a lost race the persisted
   * row is authoritative for SUBSEQUENT requests; the current request still
   * returns its own already-resolved candidate (the result was computed before
   * this call). A divergent race is recorded as an observability log line only
   * — it is NOT written to expert_routing_logs, so one physical request never
   * produces two analytics rows.
   */
  private async persistBindingRaceSafe(
    bindingKey: SessionBindingKey,
    candidate: ExpertTarget,
    candidateSource: RouteDecision['source'],
    config: ExpertRoutingConfig,
    classificationTime: number
  ): Promise<void> {
    try {
      const { row, winner } = await expertRoutingSessionBindingDb.createOrSelectBinding(
        bindingKey,
        { expertId: candidate.id, routeSource: candidateSource },
        config.session_binding_policy.idle_ttl_seconds,
        config.session_binding_policy.absolute_ttl_seconds
      );

      if (winner) {
        memoryLogger.info(
          `Expert routing session binding created | session=${bindingKey.sessionId} | expertId=${candidate.id} | source=${candidateSource}`,
          'ExpertRouter'
        );
        return;
      }

      // Lost the race: the persisted row is authoritative for later requests.
      // If it diverges from this request's candidate, record it for
      // observability only (no analytics row — see JSDoc).
      if (row.expert_id !== candidate.id) {
        memoryLogger.info(
          `Expert routing session race lost | session=${bindingKey.sessionId} | candidate=${candidate.id} | persistedWinner=${row.expert_id} | persistedSource=${row.route_source} | classificationTime=${classificationTime}`,
          'ExpertRouter'
        );
      }
    } catch (e: any) {
      // Binding persistence must never break routing.
      memoryLogger.warn(`Expert routing session binding persistence failed: ${e?.message || e}`, 'ExpertRouter');
    }
  }

  private async resolveExpert(
    expert: ExpertTarget,
    decision: RouteDecision,
    classificationTime: number,
    expertRoutingId: string,
    context: RoutingContext,
    request: ProxyRequest,
    routeSource: RouteDecision['source'],
    config: ExpertRoutingConfig,
    stats?: { promptTokens: number; cleanedLength: number },
    classifierModelName?: string
  ): Promise<ExpertRoutingResult> {
    const resolved = await resolveModelConfig(expert, 'Expert');
    const requestHash = this.generateRequestHash(request);
    const modelName = classifierModelName ?? (routeSource === 'local_onnx' ? LOCAL_CLASSIFIER_MODEL_NAME : 'expert');

    await expertRoutingLogDb.create({
      id: nanoid(),
      virtual_key_id: context.virtualKeyId || null,
      expert_routing_id: expertRoutingId,
      request_hash: requestHash,
      classifier_model: modelName,
      classification_result: decision.category,
      selected_expert_id: expert.id,
      selected_expert_type: expert.type,
      selected_expert_name: resolved.expertName,
      classification_time: classificationTime,
      original_request: JSON.stringify(
        (request.body as any)?.messages ??
        (request.body as any)?.input ??
        (request.body as any)?.text ??
        []
      ),
      classifier_request: JSON.stringify(decision.metadata?.classifierRequest || {}),
      classifier_response: JSON.stringify(decision.metadata || {}),
      route_source: routeSource,
      prompt_tokens: stats?.promptTokens ?? 0,
      cleaned_content_length: stats?.cleanedLength ?? 0,
    });

    return {
      provider: resolved.provider!,
      providerId: expert.provider_id!,
      modelOverride: resolved.modelOverride,
      category: decision.category,
      expert,
      classificationTime,
      expertType: resolved.expertType,
      expertName: resolved.expertName,
      expertModelId: resolved.expertModelId,
      thinking_enabled: decision.thinking_enabled,
      enable_adaptive_thinking: config.llm_second_pass.enable_adaptive_thinking,
    };
  }

  private async resolveFallback(
    fallback: ExpertRoutingConfig['fallback'],
    category: string,
    startTime: number,
    expertRoutingId: string,
    context: RoutingContext,
    request: ProxyRequest,
    stats?: { promptTokens: number; cleanedLength: number },
    llmJudgeFailedRequest?: any,
    extraMeta?: Record<string, any>
  ): Promise<ExpertRoutingResult> {
    if (!fallback) {
      throw new Error('No fallback configured');
    }

    const resolved = await resolveModelConfig(fallback, 'Fallback');
    const classificationTime = Date.now() - startTime;
    const requestHash = this.generateRequestHash(request);
    const classifierRequest = llmJudgeFailedRequest ? JSON.stringify(llmJudgeFailedRequest) : 'fallback';

    try {
      await expertRoutingLogDb.create({
        id: nanoid(),
        virtual_key_id: context.virtualKeyId || null,
        expert_routing_id: expertRoutingId,
        request_hash: requestHash,
        classifier_model: 'fallback',
        classification_result: category,
        selected_expert_id: 'fallback',
        selected_expert_type: fallback.type,
        selected_expert_name: resolved.expertName,
        classification_time: classificationTime,
        original_request: JSON.stringify(
          (request.body as any)?.messages ??
          (request.body as any)?.input ??
          (request.body as any)?.text ??
          []
        ),
        classifier_request: classifierRequest,
        classifier_response: JSON.stringify({
          ...(extraMeta || {}),
          fallback: llmJudgeFailedRequest ? 'llm_second_pass_failed' : 'triggered',
        }),
        route_source: 'fallback',
        prompt_tokens: stats?.promptTokens ?? 0,
        cleaned_content_length: stats?.cleanedLength ?? 0,
      });
    } catch (e: any) {
      memoryLogger.warn(`Failed to write fallback routing log: ${e?.message || e}`, 'ExpertRouter');
    }

    return {
      provider: resolved.provider!,
      providerId: fallback.provider_id!,
      modelOverride: resolved.modelOverride,
      category,
      expert: {
        id: 'fallback',
        category: 'fallback',
        type: fallback.type,
        model_id: fallback.model_id,
        provider_id: fallback.provider_id,
        model: fallback.model,
        description: 'Fallback expert',
      },
      classificationTime,
      expertType: resolved.expertType,
      expertName: resolved.expertName,
      expertModelId: resolved.expertModelId,
    };
  }

  private async llmSecondPassModelName(config: ExpertRoutingConfig): Promise<string> {
    const cfg = config.llm_second_pass;
    if (cfg.type === 'virtual') return cfg.model_id || 'llm_second_pass';
    return `${cfg.provider_id}/${cfg.model}`;
  }

  private async archiveLlmDecision(
    expertRoutingId: string,
    inputText: string,
    localResult: LocalClassifyResult | null,
    decision: RouteDecision,
    expertId?: string
  ): Promise<void> {
    try {
      await expertRoutingTrainingRecordDb.createOrIncrement({
        id: nanoid(),
        expert_routing_id: expertRoutingId,
        input_hash: crypto.createHash('sha256').update(inputText).digest('hex'),
        input_text: inputText,
        local_result: localResult ? JSON.stringify({
          top1: localResult.policy.top1,
          top2: localResult.policy.top2,
          rejected: localResult.policy.rejected,
          rejectionReason: localResult.policy.rejectionReason,
          chosenLabel: localResult.policy.chosenLabel,
        }) : undefined,
        classifier_revision: localResult?.revision,
        judge_prompt_version: String(decision.metadata?.promptVersion || 'unknown'),
        judge_model: decision.metadata?.classifierModel,
        judge_intent_label: decision.category,
        judge_confidence: decision.confidence,
        judge_reason: decision.metadata?.reason,
        final_intent_label: decision.category,
        final_expert_id: expertId,
        status: 'pending_review',
      });
    } catch (e: any) {
      memoryLogger.warn(`Failed to archive LLM routing decision: ${e?.message || e}`, 'ExpertRouter');
    }
  }

  private generateRequestHash(request: ProxyRequest): string {
    const body: any = request.body || {};
    let content: string;
    if (body.input !== undefined || typeof body.text === 'string') {
      content = JSON.stringify({ input: body.input ?? body.text, instructions: body.instructions });
    } else {
      const messages = body.messages || [];
      content = JSON.stringify(messages);
    }
    return crypto.createHash('md5').update(content).digest('hex');
  }
}

function findExpertById(experts: ExpertTarget[], expertId: string): ExpertTarget | null {
  return experts.find((e) => e.id === expertId) || null;
}

export const expertRouter = new ExpertRouter();

/**
 * Ensure local ONNX assets are loaded (best-effort, non-fatal). Called at
 * startup so readiness reflects asset availability (FR-15); failures degrade
 * Expert Routing to LLM second pass / fallback rather than crashing the process.
 */
export async function initLocalClassifier(): Promise<void> {
  try {
    await loadLocalClassifierAssets();
  } catch {
    // Error already logged inside the loader.
  }
}

/**
 * Periodically delete expired session bindings in bounded batches (NFR-4).
 */
export function startSessionBindingCleanup(intervalMs = 5 * 60 * 1000): NodeJS.Timeout {
  const run = async () => {
    try {
      const deleted = await expertRoutingSessionBindingDb.cleanupExpired();
      if (deleted > 0) {
        memoryLogger.info(`Expert routing session binding cleanup | expired=${deleted}`, 'ExpertRouter');
      }
    } catch (e: any) {
      memoryLogger.warn(`Session binding cleanup failed: ${e?.message || e}`, 'ExpertRouter');
    }
  };
  return setInterval(run, intervalMs);
}
