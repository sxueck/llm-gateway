
import { nanoid } from 'nanoid';
import { expertRoutingConfigDb, expertRoutingLogDb } from '../db/index.js';
import { memoryLogger } from './logger.js';
import { ExpertRoutingConfig } from '../types/index.js';
import { ExpertTarget } from '../types/expert-routing.js';
import crypto from 'crypto';

import { SignalBuilder } from './expert-router/preprocess/index.js';
import { SemanticRouter } from './expert-router/decision/semantic.js';
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
  // Cache semantic routers per expertRoutingId to avoid re-initializing pipeline or index
  private semanticRouters = new Map<string, { router: SemanticRouter; hash: string }>();

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
    // UI uses 'pipeline' to represent the multi-layer flow; treat it as 'hybrid' at runtime.
    const routingMode = (config.routing?.mode === 'pipeline' ? 'hybrid' : config.routing?.mode) || 'hybrid';

    // 1. Build Routing Signal
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

    // 2. L1 Semantic Router
    if (!decision && (routingMode === 'semantic' || routingMode === 'hybrid')) {
        try {
            const l1Router = await this.getSemanticRouter(expertRoutingId, config);
            if (l1Router) {
                decision = await l1Router.decide(signal);
                if (decision) {
                    memoryLogger.debug(`L1 Semantic matched: ${decision.category} (score=${decision.confidence.toFixed(3)})`, 'ExpertRouter');
                }
            }
        } catch (e: any) {
            memoryLogger.warn(`L1 Semantic failed: ${e.message}`, 'ExpertRouter');
        }
    }

    // 3. L2 LLM Judge (Fallback or Primary if mode=llm)
    let llmJudgeFailedRequest: any = null;
    if (!decision) {

        if (routingMode !== 'semantic') {
              try {
                  decision = await LLMJudge.decide(signal, config.classifier, config.experts);
                  memoryLogger.debug(`L2 LLM matched: ${decision.category}`, 'ExpertRouter');
              } catch (e: any) {
                  memoryLogger.error(`L3 LLM Judge failed: ${e.message}`, 'ExpertRouter');
                  // If L3 fails, we go to global fallback below
                  // Capture the failed classifier request if available in error context
                  llmJudgeFailedRequest = (e as any).classifierRequest || null;
              }
        }
    }

    if (!decision) {
        memoryLogger.warn('All routing layers failed to determine category', 'ExpertRouter');
        if (config.fallback) {
            return await this.resolveFallback(config.fallback, 'routing_failed', startTime, expertRoutingId, context, request, signal.stats, llmJudgeFailedRequest);
        }
        throw new Error('Routing failed and no fallback configured');
    }

    // 4. Select Expert
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

    // 5. Resolve Expert
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

  private async getSemanticRouter(expertRoutingId: string, config: ExpertRoutingConfig): Promise<SemanticRouter | null> {
      // Check if configured
      if (!config.routing?.semantic?.routes || config.routing.semantic.routes.length === 0) {
          // If no routes configured, we can't use semantic router
          // Maybe we should check if we should clear existing router?
          if (this.semanticRouters.has(expertRoutingId)) {
              this.semanticRouters.delete(expertRoutingId);
          }
          return null;
      }

      const semanticCfg = config.routing.semantic;
      const cfgHash = crypto
        .createHash('sha1')
        .update(
          JSON.stringify({
            model: semanticCfg.model || 'bge-small-zh-v1.5',
            threshold: semanticCfg.threshold,
            margin: semanticCfg.margin,
            routes: semanticCfg.routes,
          })
        )
        .digest('hex');

      const cached = this.semanticRouters.get(expertRoutingId);
      if (cached && cached.hash !== cfgHash) {
        // Config changed at runtime; rebuild to avoid stale embeddings.
        this.semanticRouters.delete(expertRoutingId);
      }

      let entry = this.semanticRouters.get(expertRoutingId);

      if (!entry) {
        const router = new SemanticRouter({
          model: semanticCfg.model || 'bge-small-zh-v1.5',
          routes: semanticCfg.routes,
          threshold: semanticCfg.threshold,
          margin: semanticCfg.margin,
        });

        entry = { router, hash: cfgHash };
        this.semanticRouters.set(expertRoutingId, entry);

        // NOTE: If we don't await init, early requests can miss L1 entirely and fall through.
        // For reliability (avoid unexpected fallback), initialize on first use.
        try {
          await router.init();
        } catch (e: any) {
          memoryLogger.error(`Init of SemanticRouter failed: ${e.message}`, 'ExpertRouter');
          this.semanticRouters.delete(expertRoutingId);
          return null;
        }
      }

      return entry.router;
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
    const classifierModelName = this.generateClassifierModelName(classifierConfig, decision);

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
      classifier_request: decision.source === 'l3_llm' ? JSON.stringify(decision.metadata?.classifierRequest) : decision.source,
      classifier_response: JSON.stringify(decision.metadata || {}),
      route_source: decision.source,
      prompt_tokens: stats?.promptTokens ?? 0,
      cleaned_content_length: stats?.cleanedLength ?? 0,
      semantic_score: decision.source === 'l1_semantic' ? decision.confidence : null
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

    // Determine classifier request: use actual failed request if available, otherwise 'fallback'
    const classifierRequest = llmJudgeFailedRequest ? JSON.stringify(llmJudgeFailedRequest) : 'fallback';

    // Log fallback execution (best-effort; fallback must not fail due to logging issues)
    try {
      await expertRoutingLogDb.create({
        id: nanoid(),
        virtual_key_id: context.virtualKeyId || null,
        expert_routing_id: expertRoutingId,
        request_hash: requestHash,
        classifier_model: 'fallback',
        classification_result: category, // 'routing_failed' or category that had no expert
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
      classifierConfig: ExpertRoutingConfig['classifier'],
      decision: RouteDecision
  ): string {
    if (decision.source === 'l1_semantic') {
        return `semantic/${decision.metadata?.model || 'default'}`;
    }
    // L3
    if (classifierConfig.type === 'virtual') {
      return classifierConfig.model_id!;
    } else {
      return `${classifierConfig.provider_id}/${classifierConfig.model}`;
    }
  }
}

export const expertRouter = new ExpertRouter();
