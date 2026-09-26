import { nanoid } from "nanoid";
import crypto from "node:crypto";
import {
  expertRoutingConfigDb,
  expertRoutingLogDb,
  expertRoutingSessionBindingDb,
} from "../db/index.js";
import { memoryLogger } from "./logger.js";
import type { ExpertRoutingConfig } from "../types/index.js";
import type { ExpertTarget } from "../types/expert-routing.js";
import {
  DEFAULT_SESSION_IDLE_TTL_SECONDS,
  DEFAULT_SESSION_ABSOLUTE_TTL_SECONDS,
} from "@llm-gateway/shared";
import { SignalBuilder } from "./expert-router/preprocess/index.js";
import { resolveModelConfig } from "./expert-router/resolve.js";
import type { ProxyRequest } from "./expert-router/types.js";
import { extractExpertRoutingSessionId } from "./expert-router/session-binding.js";
import { chooseExpert } from "./expert-router/jev-client.js";
import {
  resolveBindingScope,
  type SessionBindingKey,
} from "../db/repositories/expert-routing-session-binding.repository.js";

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
  expertType: "virtual" | "real";
  expertName: string;
  expertModelId?: string;
}

export class ExpertRouter {
  async route(
    request: ProxyRequest,
    expertRoutingId: string,
    context: RoutingContext,
  ): Promise<ExpertRoutingResult> {
    const startTime = Date.now();
    const row = await expertRoutingConfigDb.getById(expertRoutingId);
    if (!row || row.enabled !== 1) {
      throw new Error("Expert routing config not found or disabled");
    }
    let config: ExpertRoutingConfig;
    try {
      config = JSON.parse(row.config) as ExpertRoutingConfig;
    } catch {
      throw new Error("Expert routing config is invalid JSON");
    }
    if (!Array.isArray(config.experts) || config.experts.length === 0) {
      throw new Error("Expert routing has no candidate models");
    }
    const sessionId = extractExpertRoutingSessionId(request);
    const bindingKey: SessionBindingKey = {
      expertRoutingId,
      virtualKeyScope: resolveBindingScope(context.virtualKeyId),
      sessionId: sessionId || "",
    };
    const policy = config.session_binding_policy ?? {
      idle_ttl_seconds: DEFAULT_SESSION_IDLE_TTL_SECONDS,
      absolute_ttl_seconds: DEFAULT_SESSION_ABSOLUTE_TTL_SECONDS,
    };

    if (sessionId && policy) {
      const binding = await expertRoutingSessionBindingDb.getActiveBinding(
        bindingKey,
        policy.idle_ttl_seconds,
      );
      if (binding) {
        const expert = config.experts.find((item) => item.id === binding.expert_id);
        if (expert) {
          try {
            return await this.resolveAndLog(expert, "session", 1, "jev", [], startTime, expertRoutingId, context, request);
          } catch {
            await expertRoutingSessionBindingDb.deleteBinding(bindingKey);
          }
        } else {
          await expertRoutingSessionBindingDb.deleteBinding(bindingKey);
        }
      }
    }

    const signal = await SignalBuilder.buildRoutingSignal(request, config.preprocessing);
    const threshold = config.choice_threshold ?? 0.6;
    let model = "jev";
    let ranked: Array<{ expertId: string; probability: number }> = [];
    let failure = "empty_input";
    if (signal.intentText?.trim()) {
      try {
        const decision = await chooseExpert(signal.intentText, config.experts);
        model = decision.model;
        ranked = decision.ranked;
        failure = "low_probability";
        if (ranked[0]?.probability >= threshold) {
          for (const entry of ranked) {
            const expert = config.experts.find((candidate) => candidate.id === entry.expertId);
            if (!expert) continue;
            try {
              await resolveModelConfig(expert, "Expert");
              let selected = expert;
              if (sessionId && policy) {
                try {
                  const binding = await expertRoutingSessionBindingDb.createOrSelectBinding(
                    bindingKey,
                    { expertId: expert.id, routeSource: "jev" },
                    policy.idle_ttl_seconds,
                    policy.absolute_ttl_seconds,
                  );
                  if (!binding.winner) {
                    const winner = config.experts.find((candidate) => candidate.id === binding.row.expert_id);
                    if (!winner) throw new Error("Bound expert no longer exists");
                    selected = winner;
                  }
                } catch (error) {
                  memoryLogger.warn(`Expert binding persistence failed: ${error}`, "ExpertRouter");
                }
              }
              try {
                return await this.resolveAndLog(
                  selected, "jev", ranked.find((item) => item.expertId === selected.id)?.probability ?? entry.probability,
                  model, ranked, startTime, expertRoutingId, context, request, signal.stats,
                );
              } catch (error) {
                if (sessionId && policy) await expertRoutingSessionBindingDb.deleteBinding(bindingKey);
                throw error;
              }
            } catch (error) {
              memoryLogger.warn(`Expert candidate ${expert.id} unavailable: ${error}`, "ExpertRouter");
              failure = "candidate_unavailable";
            }
          }
        }
      } catch (error) {
        failure = "jev_unavailable";
        memoryLogger.warn(`Jev decision failed: ${error}`, "ExpertRouter");
      }
    }

    if (!config.fallback) throw new Error(`Expert routing failed (${failure}): no fallback configured`);
    const fallback: ExpertTarget = {
      id: "fallback",
      category: "fallback",
      ...config.fallback,
    };
    return this.resolveAndLog(
      fallback, "fallback", 0, model, ranked, startTime,
      expertRoutingId, context, request, signal.stats, failure,
    );
  }

  private async resolveAndLog(
    expert: ExpertTarget,
    source: "jev" | "session" | "fallback",
    probability: number,
    model: string,
    ranked: Array<{ expertId: string; probability: number }>,
    startTime: number,
    expertRoutingId: string,
    context: RoutingContext,
    request: ProxyRequest,
    stats?: { promptTokens: number; cleanedLength: number },
    failure?: string,
  ): Promise<ExpertRoutingResult> {
    const resolved = await resolveModelConfig(expert, source === "fallback" ? "Fallback" : "Expert");
    const body = request.body || {};
    const requestHash = crypto.createHash("sha256").update(JSON.stringify(
      body.input ?? body.text ?? body.messages ?? [],
    )).digest("hex");
    try {
      await expertRoutingLogDb.create({
        id: nanoid(),
        virtual_key_id: context.virtualKeyId || null,
        expert_routing_id: expertRoutingId,
        request_hash: requestHash,
        classifier_model: model,
        classification_result: expert.category,
        selected_expert_id: expert.id,
        selected_expert_type: expert.type,
        selected_expert_name: resolved.expertName,
        classification_time: Date.now() - startTime,
        original_request: undefined,
        classifier_request: undefined,
        classifier_response: JSON.stringify({ ranked, probability, failure }),
        route_source: source,
        prompt_tokens: stats?.promptTokens ?? 0,
        cleaned_content_length: stats?.cleanedLength ?? 0,
      });
    } catch (error) {
      memoryLogger.warn(`Expert routing log persistence failed: ${error}`, "ExpertRouter");
    }
    return {
      provider: resolved.provider!,
      providerId: resolved.providerId || "",
      modelOverride: resolved.modelOverride,
      category: expert.category,
      expert,
      classificationTime: Date.now() - startTime,
      expertType: resolved.expertType,
      expertName: resolved.expertName,
      expertModelId: resolved.expertModelId,
    };
  }
}

export const expertRouter = new ExpertRouter();

export function startSessionBindingCleanup(intervalMs = 5 * 60 * 1000): void {
  const timer = setInterval(() => {
    expertRoutingSessionBindingDb.cleanupExpired(1000).catch((error: unknown) => {
      memoryLogger.warn(`Expert binding cleanup failed: ${error}`, "ExpertRouter");
    });
  }, intervalMs);
  timer.unref();
}
