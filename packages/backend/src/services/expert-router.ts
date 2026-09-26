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
import { chooseExpert, chooseDifficulty } from "./expert-router/jev-client.js";
import {
  BAND_ORDER,
  buildBands,
  difficultyToBand,
  resolveBandCandidates,
} from "./expert-router/bands.js";
import { resolveExpertCost } from "./expert-router/cost.js";
import type {
  ClassificationMode,
  CostInput,
  DifficultyLevel,
  ExpertRoutingBands,
  FailOpenMode,
  RoutingBand,
} from "../types/expert-routing.js";
import {
  resolveBindingScope,
  type SessionBindingKey,
} from "../db/repositories/expert-routing-session-binding.repository.js";

interface RoutingContext {
  modelId?: string;
  virtualKeyId?: string;
}

interface BandIndex {
  bands: ExpertRoutingBands;
  bandOf: Map<string, RoutingBand>;
  costOf: Map<string, CostInput | undefined>;
}

interface RoutingMeta {
  mode?: ClassificationMode;
  verdictBand?: RoutingBand;
  verdictConfidence?: number;
  difficulty?: DifficultyLevel;
  failOpen?: FailOpenMode;
  verdictReused?: boolean;
  classifierTimeMs?: number | null;
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
  ): Promise<ExpertRoutingResult | null> {
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
    const classificationMode: ClassificationMode =
      config.classification_mode === "difficulty" ? "difficulty" : "expert";
    const failOpen: FailOpenMode =
      config.fail_open === "parent" || config.fail_open === "error"
        ? config.fail_open
        : "fallback";
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
            const bindingDifficulty =
              typeof binding.difficulty === "string" && binding.difficulty
                ? (binding.difficulty as DifficultyLevel)
                : undefined;
            return await this.resolveAndLog(expert, "session", 1, null, [], startTime, expertRoutingId, context, request, undefined, undefined, {
              mode: classificationMode,
              failOpen,
              verdictReused: true,
              difficulty: bindingDifficulty,
              verdictBand: bindingDifficulty ? difficultyToBand(bindingDifficulty) : undefined,
              classifierTimeMs: null,
            });
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
    let model: string | null = null;
    let ranked: Array<{ expertId: string; probability: number }> = [];
    let verdictExpertId: string | undefined;
    let verdictBand: RoutingBand = "low";
    let verdictConfidence = 0;
    let difficulty: DifficultyLevel | undefined;
    let failure = "empty_input";
    let classifierTimeMs: number | null = null;

    let classified = false;
    if (signal.intentText?.trim()) {
      const jevStart = performance.now();
      try {
        if (classificationMode === "difficulty") {
          const decision = await chooseDifficulty(signal.intentText);
          model = decision.model;
          ranked = decision.ranked;
          difficulty = decision.verdict;
          verdictConfidence = decision.confidence;
          verdictBand = difficultyToBand(decision.verdict);
        } else {
          const decision = await chooseExpert(signal.intentText, config.experts);
          model = decision.model;
          ranked = decision.ranked;
          verdictConfidence = ranked[0]?.probability ?? 0;
          verdictExpertId = ranked[0]?.expertId;
        }
        classified = true;
        failure = "low_probability";
      } catch (error) {
        failure = "jev_unavailable";
        memoryLogger.warn(`Jev decision failed: ${error}`, "ExpertRouter");
      } finally {
        classifierTimeMs = Math.round(performance.now() - jevStart);
      }
    }

    try {
      const bandIndex = await this.buildBandIndex(config.experts);
      if (classified && classificationMode !== "difficulty") {
        verdictBand =
          (verdictExpertId && bandIndex.bandOf.get(verdictExpertId)) || "low";
      }
      const ordered = resolveBandCandidates(
        bandIndex.bands,
        verdictBand,
        (expert) => bandIndex.costOf.get(expert.id),
      );
      if (verdictExpertId && verdictConfidence >= threshold) {
        const at = ordered.findIndex((candidate) => candidate.id === verdictExpertId);
        if (at > 0) {
          const [verdict] = ordered.splice(at, 1);
          ordered.unshift(verdict);
        }
      }
      // fail_open 仅表示分类器失败；低置信但成功分类仍算 jev 判定
      const routeSource: "jev" | "fail_open" = classified ? "jev" : "fail_open";
      const meta: RoutingMeta = {
        mode: classificationMode,
        verdictBand,
        verdictConfidence,
        difficulty,
        failOpen,
        verdictReused: false,
        classifierTimeMs,
      };

      for (const expert of ordered) {
        try {
          await resolveModelConfig(expert, "Expert");
          let selected = expert;
          if (sessionId && policy) {
            try {
              const binding = await expertRoutingSessionBindingDb.createOrSelectBinding(
                bindingKey,
                { expertId: expert.id, routeSource, difficulty },
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
              selected, routeSource, ranked.find((item) => item.expertId === selected.id)?.probability ?? verdictConfidence,
              model, ranked, startTime, expertRoutingId, context, request, signal.stats, undefined, meta,
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
    } catch (error) {
      failure = "band_resolution_failed";
      memoryLogger.warn(`Expert band resolution failed: ${error}`, "ExpertRouter");
    }

    if (failOpen !== "parent" && config.fallback) {
      const fallback: ExpertTarget = {
        id: "fallback",
        category: "fallback",
        ...config.fallback,
      };
      try {
        return await this.resolveAndLog(
          fallback, "fallback", 0, model, ranked, startTime,
          expertRoutingId, context, request, signal.stats, failure,
          { mode: classificationMode, failOpen, verdictReused: false, difficulty, classifierTimeMs },
        );
      } catch (error) {
        memoryLogger.warn(`Configured fallback unavailable: ${error}`, "ExpertRouter");
      }
    }
    if (failOpen === "error") {
      throw new Error(`Expert routing failed (${failure}): no fallback configured`);
    }
    memoryLogger.warn(
      `Expert routing exhausted (fail_open=${failOpen}, failure=${failure}); delegating to parent routing`,
      "ExpertRouter",
    );
    return null;
  }

  /**
   * Hydrate per-expert token costs from the referenced model attributes and
   * build the price bands (explicit band first, remainder auto-split).
   * Cost lookup failures degrade to unknown (Infinity) pricing.
   */
  private async buildBandIndex(experts: ExpertTarget[]): Promise<BandIndex> {
    const costOf = new Map<string, CostInput | undefined>();
    for (const expert of experts) {
      costOf.set(expert.id, await resolveExpertCost(expert));
    }
    const bands = buildBands(experts, (expert) => costOf.get(expert.id));
    const bandOf = new Map<string, RoutingBand>();
    for (const band of BAND_ORDER) {
      for (const expert of bands[band]) bandOf.set(expert.id, band);
    }
    return { bands, bandOf, costOf };
  }

  private async resolveAndLog(
    expert: ExpertTarget,
    source: "jev" | "session" | "fallback" | "fail_open",
    probability: number,
    model: string | null,
    ranked: Array<{ expertId: string; probability: number }>,
    startTime: number,
    expertRoutingId: string,
    context: RoutingContext,
    request: ProxyRequest,
    stats?: { promptTokens: number; cleanedLength: number },
    failure?: string,
    meta?: RoutingMeta,
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
        difficulty: meta?.difficulty ?? null,
        band: meta?.verdictBand ?? null,
        verdict_reused: source === "session",
        classifier_time_ms: meta?.classifierTimeMs ?? null,
        classification_result: expert.category,
        selected_expert_id: expert.id,
        selected_expert_type: expert.type,
        selected_expert_name: resolved.expertName,
        classification_time: Date.now() - startTime,
        original_request: undefined,
        classifier_request: undefined,
        classifier_response: JSON.stringify({ ranked, probability, failure, ...meta }),
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
