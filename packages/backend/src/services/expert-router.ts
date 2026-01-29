
import { nanoid } from 'nanoid';
import { expertRoutingConfigDb, expertRoutingLogDb } from '../db/index.js';
import { memoryLogger } from './logger.js';
import { ExpertRoutingConfig } from '../types/index.js';
import { ExpertTarget } from '../types/expert-routing.js';
import crypto from 'crypto';

import { SignalBuilder } from './expert-router/preprocess/index.js';
import { LLMJudge } from './expert-router/decision/llm-judge.js';
import { resolveModelConfig, matchExpert } from './expert-router/resolve.js';
import { RouteDecision, ProxyRequest } from './expert-router/types.js';

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
}

export class ExpertRouter {
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

    // 1. Build Routing Signal (preprocessing)
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
                `Preprocess: intentTokens=${s.originalTokens}->${s.cleanedTokens} (removed=${s.removedTokens ?? 0}, ${pct}%) promptTokens=${s.promptTokens} tokenizer=${s.tokenizer || 'unknown'}`,
                'ExpertRouter'
            );
        }
    }

    if (!signal.intentText && signal.toolSignals.length === 0) {
        throw new Error('No valid intent text or signals found in request');
    }

    let decision: RouteDecision | null = null;
    let llmJudgeFailedRequest: any = null;

    // 2. LLM Judge Classification
    try {
        decision = await LLMJudge.decide(signal, config.classifier, config.experts);
        memoryLogger.debug(`LLM classified: ${decision.category}`, 'ExpertRouter');
    } catch (e: any) {
        memoryLogger.error(`LLM Judge failed: ${e.message}`, 'ExpertRouter');
        llmJudgeFailedRequest = (e as any).classifierRequest || null;
    }

    if (!decision) {
        memoryLogger.warn('Classification failed', 'ExpertRouter');
        if (config.fallback) {
            return await this.resolveFallback(config.fallback, 'routing_failed', startTime, expertRoutingId, context, request, signal.stats, llmJudgeFailedRequest);
        }
        throw new Error('Routing failed and no fallback configured');
    }

    // 3. Select Expert
    const expert = matchExpert(decision.category, config.experts);

    if (!expert) {
      memoryLogger.warn(
        `No expert found for category: "${decision.category}"`,
        'ExpertRouter'
      );

      if (config.fallback) {
        return await this.resolveFallback(config.fallback, decision.category, startTime, expertRoutingId, context, request, signal.stats);
      }

      throw new Error(`No expert found for category: ${decision.category}`);
    }

    const classificationTime = Date.now() - startTime;

    // 4. Resolve Expert
    return await this.resolveExpert(
      expert,
      decision,
      classificationTime,
      expertRoutingId,
      context,
      request,
      config.classifier,
      signal.stats
    );
  }

  private async resolveExpert(
    expert: ExpertTarget,
    decision: RouteDecision,
    classificationTime: number,
    expertRoutingId: string,
    context: RoutingContext,
    request: ProxyRequest,
    classifierConfig: ExpertRoutingConfig['classifier'],
    stats?: { promptTokens: number; cleanedLength: number }
  ): Promise<ExpertRoutingResult> {
    const resolved = await resolveModelConfig(expert, 'Expert');
    const requestHash = this.generateRequestHash(request);
    const classifierModelName = this.generateClassifierModelName(classifierConfig);

    await expertRoutingLogDb.create({
      id: nanoid(),
      virtual_key_id: context.virtualKeyId || null,
      expert_routing_id: expertRoutingId,
      request_hash: requestHash,
      classifier_model: classifierModelName,
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
      route_source: decision.source,
      prompt_tokens: stats?.promptTokens ?? 0,
      cleaned_content_length: stats?.cleanedLength ?? 0,
      semantic_score: null
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
    llmJudgeFailedRequest?: any
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
        classifier_response: llmJudgeFailedRequest ? 'llm_judge_failed' : 'fallback_triggered',
        route_source: 'fallback',
        prompt_tokens: stats?.promptTokens ?? 0,
        cleaned_content_length: stats?.cleanedLength ?? 0,
        semantic_score: null
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

  private generateRequestHash(request: ProxyRequest): string {
    const body: any = request.body || {};
    let content: string;
    if (body.input !== undefined || typeof body.text === 'string') {
      content = JSON.stringify({
        input: body.input ?? body.text,
        instructions: body.instructions
      });
    } else {
      const messages = body.messages || [];
      content = JSON.stringify(messages);
    }
    return crypto.createHash('md5').update(content).digest('hex');
  }

  private generateClassifierModelName(
      classifierConfig: ExpertRoutingConfig['classifier']
  ): string {
    if (classifierConfig.type === 'virtual') {
      return classifierConfig.model_id!;
    } else {
      return `${classifierConfig.provider_id}/${classifierConfig.model}`;
    }
  }
}

export const expertRouter = new ExpertRouter();
