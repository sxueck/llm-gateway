import { z } from "zod";
import { upstreamFetch } from "../../utils/upstream-fetch.js";

const DEFAULT_TIMEOUT_MS = 5000;

const responseSchema = z.object({
  object: z.literal("intent.classification"),
  model: z.string().min(1),
  revision: z.string().min(1),
  latency_ms: z.number().finite(),
  stats: z.object({
    batch_size: z.number().int().positive(),
    cache_hits: z.number().int().nonnegative(),
    inference_ms: z.number().finite(),
  }),
  data: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        truncated: z.boolean(),
        token_count: z.number().int().nonnegative(),
        labels: z.array(
          z.object({
            label: z.string().min(1),
            domain: z.string().min(1),
            score: z.number().finite(),
          }),
        ),
        route: z.object({
          intent: z.string().min(1),
          domain: z.string().min(1),
          rejected: z.boolean(),
          reason: z.string().min(1),
          top1_score: z.number().finite(),
          matched_keyword_intent: z.string().min(1).nullable().optional(),
          flipped_from: z.string().min(1).nullable().optional(),
        }),
      }),
    )
    .min(1),
});

export type IntentRouterResponse = z.infer<typeof responseSchema>;

export class IntentRouterApiError extends Error {
  constructor(
    message: string,
    readonly configured: boolean,
  ) {
    super(message);
    this.name = "IntentRouterApiError";
  }
}

function getEndpoint(): URL {
  const baseUrl = process.env.INTENT_ROUTER_API_URL?.trim();
  if (!baseUrl) {
    throw new IntentRouterApiError(
      "INTENT_ROUTER_API_URL is not configured",
      false,
    );
  }

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new IntentRouterApiError(
      "INTENT_ROUTER_API_URL must be an absolute HTTP(S) URL",
      false,
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new IntentRouterApiError(
      "INTENT_ROUTER_API_URL must use HTTP or HTTPS",
      false,
    );
  }

  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/intent`;
  url.search = "";
  url.hash = "";
  return url;
}

function getTimeoutMs(): number {
  const value = Number(process.env.INTENT_ROUTER_API_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_TIMEOUT_MS;
}

export async function classifyIntent(
  input: string,
  topN?: number,
): Promise<IntentRouterResponse> {
  const endpoint = getEndpoint();
  const apiKey = process.env.INTENT_ROUTER_API_KEY?.trim();
  const response = await upstreamFetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      input,
      ...(topN ? { top_n: topN } : {}),
    }),
    timeoutMs: getTimeoutMs(),
  }).catch((error: unknown) => {
    const detail = error instanceof Error ? error.message : String(error);
    throw new IntentRouterApiError(
      `Intent Router API request failed: ${detail}`,
      true,
    );
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => response.statusText);
    throw new IntentRouterApiError(
      `Intent Router API returned HTTP ${response.status}: ${detail.slice(0, 200)}`,
      true,
    );
  }

  const payload = await response.json().catch(() => {
    throw new IntentRouterApiError(
      "Intent Router API returned invalid JSON",
      true,
    );
  });
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new IntentRouterApiError(
      `Intent Router API returned an invalid response: ${parsed.error.issues[0]?.message ?? "unknown schema error"}`,
      true,
    );
  }

  if (parsed.data.data[0].index !== 0) {
    throw new IntentRouterApiError(
      "Intent Router API response is missing the requested input result",
      true,
    );
  }

  return parsed.data;
}
