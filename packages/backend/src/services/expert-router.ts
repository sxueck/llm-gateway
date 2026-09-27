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
import { isContinuationTurn } from "./expert-router/turns.js";
import {
  capabilitySatisfied,
  detectRequestCapabilities,
  resolveExpertCapabilities,
} from "./expert-router/capabilities.js";
import { resolveModelConfig } from "./expert-router/resolve.js";
import type { ProxyRequest } from "./expert-router/types.js";
import { extractExpertRoutingSessionId } from "./expert-router/session-binding.js";
import { chooseDifficulty } from "./expert-router/jev-client.js";
import {
  BAND_ORDER,
  difficultyToBand,
  resolveBandCandidates,
} from "./expert-router/bands.js";
import type {
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

interface RoutingMeta {
  verdictBand?: RoutingBand;
  verdictConfidence?: number;
  difficulty?: DifficultyLevel;
  failOpen?: FailOpenMode;
  verdictReused?: boolean;
  classifierTimeMs?: number | null;
  /** §5.2: agent tool-result / assistant continuation turn. */
  continuation?: boolean;
  /** §5.4: capability constraints removed at least one candidate. */
  capabilityFiltered?: boolean;
}

interface ExpertRoutingResult {
  provider: any;
  providerId: string;
  modelOverride?: string;
  tier: RoutingBand;
  routeSource: "jev" | "session" | "fallback" | "fail_open";
  logId: string | null;
  expert: ExpertTarget;
  classificationTime: number;
  expertType: "virtual" | "real";
  expertName: string;
  expertModelId?: string;
}

/** v2: band is mandatory; array order decides priority within a band. */
export function groupByBand(experts: ExpertTarget[]): ExpertRoutingBands {
  const bands: ExpertRoutingBands = { low: [], medium: [], high: [] };
  for (const expert of experts) {
    if (!(BAND_ORDER as readonly string[]).includes(expert.band)) {
      throw new Error(
        `Expert routing candidate ${expert.id} has no valid band (legacy config; rerun the expert_routing_config_v2 migration)`,
      );
    }
    bands[expert.band].push(expert);
  }
  return bands;
}

export class ExpertRouter {
  /**
   * §5.4: capability check for the reuse path. Only image/tool constraints
   * apply here (synchronous caps + one metadata lookup when relevant); the
   * context-window check needs token counting and runs on the classify path.
   */
  private async reuseBlockedByCapabilities(
    expert: ExpertTarget,
    caps: { hasImages: boolean; hasTools: boolean },
  ): Promise<boolean> {
    if (!caps.hasImages && !caps.hasTools) return false;
    const metadata = await resolveExpertCapabilities(expert);
    return !capabilitySatisfied(metadata, caps, undefined);
  }

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
    const failOpen: FailOpenMode =
      config.fail_open === "parent" || config.fail_open === "error"
        ? config.fail_open
        : "fallback";
    // Hard fail on legacy configs: a missing band is a deployment bug the v2
    // migration should have fixed — fail-open here would silently route wrong.
    // (Result unused: tier selection re-groups the capability-filtered pool.)
    groupByBand(config.experts);
    const sessionId = extractExpertRoutingSessionId(request);
    const bindingKey: SessionBindingKey = {
      expertRoutingId,
      virtualKeyScope: resolveBindingScope(context.virtualKeyId),
      sessionId: sessionId || "",
    };
    const policy = config.session_policy ??
      config.session_binding_policy ?? {
        mode: "escalate_only" as const,
        idle_ttl_seconds: DEFAULT_SESSION_IDLE_TTL_SECONDS,
        absolute_ttl_seconds: DEFAULT_SESSION_ABSOLUTE_TTL_SECONDS,
      };
    // per_turn skips bindings entirely; sticky/escalate_only reuse them.
    const useBindings = Boolean(sessionId) && policy.mode !== "per_turn";
    // §5.2: continuation turns (tool results / assistant follow-ups) must
    // never re-classify while a binding exists; without any stored decision
    // (per_turn or expired binding) classification is the only fallback.
    const continuationTurn = isContinuationTurn(request.body);
    // §5.4: vision/tool constraints from the request shape (cheap, sync).
    const caps = detectRequestCapabilities(request.body);

    let binding: Awaited<ReturnType<typeof expertRoutingSessionBindingDb.getActiveBinding>> = null;
    if (useBindings) {
      binding = await expertRoutingSessionBindingDb.getActiveBinding(
        bindingKey,
        policy.idle_ttl_seconds,
      );
    }
    const boundExpert = binding
      ? config.experts.find((item) => item.id === binding!.expert_id)
      : undefined;
    if (binding && !boundExpert) {
      await expertRoutingSessionBindingDb.deleteBinding(bindingKey);
      binding = null;
    }
    const bindingDifficulty =
      binding && typeof binding.difficulty === "string" && binding.difficulty
        ? (binding.difficulty as DifficultyLevel)
        : undefined;
    const boundTier: RoutingBand | undefined = binding
      ? binding.tier === "low" || binding.tier === "medium" || binding.tier === "high"
        ? binding.tier
        : difficultyToBand(bindingDifficulty)
      : undefined;

    // §5.1 sticky / §5.2 continuation: reuse the bound expert as-is.
    // escalate_only re-classifies only on fresh user turns.
    const reuseWithoutClassification =
      Boolean(binding && boundExpert) &&
      (policy.mode !== "escalate_only" || continuationTurn);
    if (binding && boundExpert && reuseWithoutClassification) {
      if (await this.reuseBlockedByCapabilities(boundExpert, caps)) {
        // §5.4: the bound model no longer satisfies the request (e.g. a new
        // image turn on a text-only model) — drop the binding and re-classify.
        await expertRoutingSessionBindingDb.deleteBinding(bindingKey);
        binding = null;
      } else {
        try {
          return await this.resolveAndLog(boundExpert, "session", 1, null, [], startTime, expertRoutingId, context, request, undefined, undefined, {
            failOpen,
            verdictReused: true,
            difficulty: bindingDifficulty,
            verdictBand: boundExpert.band,
            classifierTimeMs: null,
            continuation: continuationTurn,
          });
        } catch {
          await expertRoutingSessionBindingDb.deleteBinding(bindingKey);
        }
      }
    }

    const signal = await SignalBuilder.buildRoutingSignal(request, config.preprocessing);
    let model: string | null = null;
    let ranked: Array<{ expertId: string; probability: number }> = [];
    let verdictBand: RoutingBand = "low";
    let verdictConfidence = 0;
    let difficulty: DifficultyLevel | undefined;
    let failure = "empty_input";
    let classifierTimeMs: number | null = null;

    let classified = false;
    if (signal.intentText?.trim()) {
      const jevStart = performance.now();
      try {
        const decision = await chooseDifficulty(signal.intentText);
        model = decision.model;
        ranked = decision.ranked;
        difficulty = decision.verdict;
        verdictConfidence = decision.confidence;
        verdictBand = difficultyToBand(decision.verdict);
        classified = true;
        failure = "low_probability";
      } catch (error) {
        failure = "jev_unavailable";
        memoryLogger.warn(`Jev decision failed: ${error}`, "ExpertRouter");
      } finally {
        classifierTimeMs = Math.round(performance.now() - jevStart);
      }
    }

    // §5.1 escalate_only with an existing binding: keep the bound tier unless
    // the fresh verdict is strictly higher (downgrades would drop prompt-cache
    // and break mid-loop context consistency).
    const escalateActive = policy.mode === "escalate_only" && Boolean(binding && boundExpert);
    if (escalateActive && !classified) {
      // Classifier down on a fresh turn: serve the bound tier (never degrade
      // to the fail-open low band just because the classifier is unavailable).
      return await this.resolveAndLog(boundExpert!, "session", 1, model, ranked, startTime, expertRoutingId, context, request, signal.stats, undefined, {
        failOpen,
        verdictReused: true,
        difficulty: bindingDifficulty,
        verdictBand: boundTier ?? boundExpert!.band,
        classifierTimeMs,
        continuation: continuationTurn,
      });
    }
    const verdictRank = BAND_ORDER.indexOf(verdictBand);
    const boundRank = boundTier !== undefined ? BAND_ORDER.indexOf(boundTier) : -1;
    const keepBoundTier = escalateActive && classified && verdictRank <= boundRank;
    const effectiveBand: RoutingBand = keepBoundTier ? boundTier! : verdictBand;

    try {
      // §5.4 capability filter runs BEFORE tier selection: drop candidates that
      // cannot serve the request (vision/tools/context window; unknown metadata
      // never filters), then tier-select among the survivors so an oversized or
      // image-bearing prompt escalates to a capable tier instead of erroring.
      const promptTokens = signal.stats?.promptTokens;
      let pool = config.experts;
      let capabilityFiltered = false;
      if (caps.hasImages || caps.hasTools || (promptTokens ?? 0) > 0) {
        const capCache = new Map(
          await Promise.all(
            config.experts.map(async (expert) => {
              return [expert.id, await resolveExpertCapabilities(expert)] as const;
            }),
          ),
        );
        const survivors = pool.filter((expert) =>
          capabilitySatisfied(capCache.get(expert.id), caps, promptTokens),
        );
        capabilityFiltered = survivors.length < pool.length;
        pool = survivors;
      }
      let candidates: ExpertTarget[] = [];
      if (pool.length > 0) {
        candidates = resolveBandCandidates(groupByBand(pool), effectiveBand);
        if (keepBoundTier && boundExpert) {
          // Fresh verdict confirmed the incumbent tier: prefer the bound expert
          // (stable model choice within the tier) over re-picking by order.
          const at = candidates.findIndex((candidate) => candidate.id === boundExpert.id);
          if (at > 0) {
            const [incumbent] = candidates.splice(at, 1);
            candidates.unshift(incumbent);
          }
        }
      } else {
        failure = "capability_filtered";
      }
      // fail_open 仅表示分类器失败；低置信但成功分类仍算 jev 判定
      const routeSource: "jev" | "fail_open" = classified ? "jev" : "fail_open";
      const meta: RoutingMeta = {
        verdictBand: effectiveBand,
        verdictConfidence,
        difficulty,
        failOpen,
        verdictReused: keepBoundTier,
        classifierTimeMs,
        continuation: continuationTurn,
        capabilityFiltered,
      };

      for (const expert of candidates) {
        try {
          await resolveModelConfig(expert, "Expert");
          let selected = expert;
          if (useBindings) {
            try {
              if (
                escalateActive &&
                classified &&
                verdictRank > boundRank &&
                effectiveBand !== boundTier
              ) {
                // Tier promotion: update the binding in place; a vanished row
                // (expired mid-flight) falls back to a fresh first-writer insert.
                const updated = await expertRoutingSessionBindingDb.escalateBindingTier(
                  bindingKey,
                  { expertId: expert.id, tier: effectiveBand, difficulty, routeSource },
                );
                if (!updated) {
                  await expertRoutingSessionBindingDb.createOrSelectBinding(
                    bindingKey,
                    { expertId: expert.id, routeSource, difficulty, tier: effectiveBand },
                    policy.idle_ttl_seconds,
                    policy.absolute_ttl_seconds,
                  );
                }
              } else if (!binding) {
                const race = await expertRoutingSessionBindingDb.createOrSelectBinding(
                  bindingKey,
                  { expertId: expert.id, routeSource, difficulty, tier: effectiveBand },
                  policy.idle_ttl_seconds,
                  policy.absolute_ttl_seconds,
                );
                if (!race.winner) {
                  const winner = config.experts.find((candidate) => candidate.id === race.row.expert_id);
                  if (!winner) throw new Error("Bound expert no longer exists");
                  selected = winner;
                }
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
            if (useBindings) await expertRoutingSessionBindingDb.deleteBinding(bindingKey);
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
        band: "high",
        ...config.fallback,
      };
      try {
        return await this.resolveAndLog(
          fallback, "fallback", 0, model, ranked, startTime,
          expertRoutingId, context, request, signal.stats, failure,
          { failOpen, verdictReused: false, difficulty, classifierTimeMs },
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
      const logId = nanoid();
      await expertRoutingLogDb.create({
        id: logId,
        virtual_key_id: context.virtualKeyId || null,
        expert_routing_id: expertRoutingId,
        request_hash: requestHash,
        classifier_model: model,
        difficulty: meta?.difficulty ?? null,
        band: meta?.verdictBand ?? null,
        verdict_reused: source === "session" || meta?.verdictReused === true,
        classifier_time_ms: meta?.classifierTimeMs ?? null,
        classification_result: meta?.difficulty ?? expert.band,
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
      return {
        provider: resolved.provider!,
        providerId: resolved.providerId || "",
        modelOverride: resolved.modelOverride,
        tier: expert.band,
        routeSource: source,
        logId,
        expert,
        classificationTime: Date.now() - startTime,
        expertType: resolved.expertType,
        expertName: resolved.expertName,
        expertModelId: resolved.expertModelId,
      };
    } catch (error) {
      memoryLogger.warn(`Expert routing log persistence failed: ${error}`, "ExpertRouter");
    }
    return {
      provider: resolved.provider!,
      providerId: resolved.providerId || "",
      modelOverride: resolved.modelOverride,
      tier: expert.band,
      routeSource: source,
      logId: null,
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
