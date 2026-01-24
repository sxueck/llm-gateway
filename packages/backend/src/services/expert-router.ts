
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
  private semanticRouters = new Map<string, SemanticRouter>();

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
    const routingMode = config.routing?.mode || 'hybrid'; // Default to hybrid if not set (or llm if strict backward compat needed? Plan says hybrid)

    // 1. Build Routing Signal
    let signal;
    try {
        signal = await SignalBuilder.buildRoutingSignal(request);
    } catch (e: any) {
        throw new Error(`Failed to build routing signal: ${e.message}`);
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
    if (!decision) {
        // If mode is strictly semantic, we might fail here?
        // Plan says: "L1 uncertain -> L3". Even if mode is semantic?
        // Usually 'semantic' mode implies ONLY semantic. But let's assume 'hybrid' is default and we want L3 fallback.
        // If mode is 'semantic' and L1 failed, do we fall back to L3?
        // Plan: "L1 返回不确定，交给 L3 兜底" (L1 returns uncertain, pass to L3).
        // This implies L3 is the ultimate fallback unless explicitly disabled.
        
        if (routingMode !== 'semantic') { // If mode is 'semantic', we should probably NOT call LLM?
                                        // But typically we want high availability.
                                        // I'll assume if mode is 'semantic' we skip LLM. 
                                        // But if mode is 'hybrid' or 'llm', we use LLM.
             try {
                 decision = await LLMJudge.decide(signal, config.classifier);
                 memoryLogger.debug(`L2 LLM matched: ${decision.category}`, 'ExpertRouter');
             } catch (e: any) {
                 memoryLogger.error(`L3 LLM Judge failed: ${e.message}`, 'ExpertRouter');
                 // If L3 fails, we go to global fallback below
             }
        }
    }

    if (!decision) {
        memoryLogger.warn('All routing layers failed to determine category', 'ExpertRouter');
        if (config.fallback) {
            return await this.resolveFallback(config.fallback, 'routing_failed', startTime, expertRoutingId, context);
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
        return await this.resolveFallback(config.fallback, decision.category, startTime, expertRoutingId, context);
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
      config.classifier
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

      let router = this.semanticRouters.get(expertRoutingId);
      
      // TODO: Check if config hash changed to trigger rebuild.
      // For now, we assume if it exists we use it. 
      // Ideally we need a way to detect config updates.
      // A simple way is to store the routes hash/length with the router?
      
      if (!router) {
          router = new SemanticRouter({
              model: config.routing.semantic.model || 'bge-small-zh-v1.5',
              routes: config.routing.semantic.routes,
              threshold: config.routing.semantic.threshold,
              margin: config.routing.semantic.margin
          });
          this.semanticRouters.set(expertRoutingId, router);
          // Async init (don't await if we want to not block? But first request needs it?)
          // Plan says "Warmup async... L1 returns uncertain if not ready".
          // So we call init and return the router. Router.decide will check isReady.
          router.init().catch(e => {
              memoryLogger.error(`Async init of SemanticRouter failed: ${e.message}`, 'ExpertRouter');
          });
      }
      
      return router;
  }

  private async resolveExpert(
    expert: ExpertTarget,
    decision: RouteDecision,
    classificationTime: number,
    expertRoutingId: string,
    context: RoutingContext,
    request: ProxyRequest,
    classifierConfig: ExpertRoutingConfig['classifier']
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
    _expertRoutingId: string,
    _context: RoutingContext
  ): Promise<ExpertRoutingResult> {
    if (!fallback) {
      throw new Error('No fallback configured');
    }

    const resolved = await resolveModelConfig(fallback, 'Fallback');
    const classificationTime = Date.now() - startTime;

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
    if (decision.source === 'l2_heuristic') {
        return 'heuristic';
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
