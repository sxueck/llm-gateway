import { modelDb } from "../../db/index.js";
import { hotConfigCache } from "../hot-config-cache.js";
import type { ExpertTarget } from "../../types/expert-routing.js";

/**
 * §5.4 capability-constraint detection: candidates must survive a capability
 * filter before tier selection — images require vision, tools require function
 * calling, and oversized prompts force escalation to larger context windows.
 */

export interface RequestCapabilities {
  hasImages: boolean;
  hasTools: boolean;
}

function contentHasImage(content: unknown): boolean {
  if (Array.isArray(content)) {
    return content.some((part) => contentHasImage(part));
  }
  if (content && typeof content === "object") {
    const part = content as any;
    // OpenAI: { type: "image_url", image_url: {...} }; Anthropic: { type: "image", source: {...} }
    if (part.type === "image_url" || part.type === "image") return true;
    if (part.image_url) return true;
  }
  return false;
}

/** Detect vision/tool requirements from any request protocol shape. */
export function detectRequestCapabilities(body: any): RequestCapabilities {
  let hasImages = false;
  let hasTools = false;
  if (!body || typeof body !== "object") return { hasImages, hasTools };

  if (Array.isArray(body.tools) && body.tools.length > 0) hasTools = true;

  const scanMessage = (message: any) => {
    if (!message || typeof message !== "object") return;
    if (contentHasImage(message.content)) hasImages = true;
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) hasTools = true;
  };

  if (Array.isArray(body.messages)) {
    for (const message of body.messages) scanMessage(message);
  }
  if (Array.isArray(body.contents)) {
    // Gemini native: contents[].parts[].inline_data
    for (const content of body.contents) {
      const parts = Array.isArray(content?.parts) ? content.parts : [];
      if (parts.some((p: any) => p?.inline_data || p?.inlineData)) hasImages = true;
    }
  }
  if (Array.isArray(body.input)) {
    for (const item of body.input) scanMessage(item);
    if (item0HasToolCall(body.input)) hasTools = true;
  }
  return { hasImages, hasTools };
}

function item0HasToolCall(input: any[]): boolean {
  return input.some(
    (item: any) =>
      item &&
      typeof item === "object" &&
      (item.type === "function_call" || item.type === "custom_tool_call"),
  );
}

export interface ExpertCapabilities {
  /** Undefined when the model row/pricing metadata is unavailable. */
  contextWindow?: number;
  supportsVision?: boolean;
  supportsToolCalling?: boolean;
}

/** Resolve capability metadata from the referenced model's attributes. */
export async function resolveExpertCapabilities(
  expert: Pick<ExpertTarget, "type" | "model_id" | "provider_id" | "model">,
): Promise<ExpertCapabilities> {
  try {
    let attributes: unknown;
    if (expert.type === "virtual") {
      if (!expert.model_id) return {};
      const model = await hotConfigCache.getModelById(expert.model_id);
      attributes = model?.model_attributes;
    } else {
      if (!expert.provider_id || !expert.model) return {};
      const models = await modelDb.getByProviderId(expert.provider_id);
      const match = (models as any[] | undefined)?.find(
        (candidate) =>
          candidate.is_virtual !== 1 &&
          (candidate.model_identifier === expert.model ||
            candidate.name === expert.model),
      );
      attributes = match?.model_attributes;
    }
    if (typeof attributes !== "string" || !attributes) return {};
    const parsed = JSON.parse(attributes) as any;
    const contextWindow = Number(
      parsed?.context_window ?? parsed?.context_length ?? parsed?.max_tokens,
    );
    return {
      contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined,
      supportsVision: parsed?.supports_vision === undefined ? undefined : Boolean(parsed.supports_vision),
      supportsToolCalling:
        parsed?.supports_function_calling === undefined
          ? undefined
          : Boolean(parsed.supports_function_calling),
    };
  } catch {
    return {};
  }
}

/**
 * Whether a candidate satisfies the request's constraints. Unknown metadata
 * never filters (fail-open) — an over-filtering gateway would strand requests.
 */
export function capabilitySatisfied(
  caps: ExpertCapabilities | undefined,
  request: RequestCapabilities,
  promptTokens: number | undefined,
): boolean {
  if (!caps) return true;
  if (request.hasImages && caps.supportsVision === false) return false;
  if (request.hasTools && caps.supportsToolCalling === false) return false;
  if (
    promptTokens !== undefined &&
    promptTokens > 0 &&
    caps.contextWindow !== undefined &&
    promptTokens > caps.contextWindow
  ) {
    return false;
  }
  return true;
}
