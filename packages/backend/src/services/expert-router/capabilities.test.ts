import { describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getModelById: vi.fn(),
}));
vi.mock("../../db/index.js", () => ({ modelDb: { getByProviderId: vi.fn() } }));
vi.mock("../hot-config-cache.js", () => ({
  hotConfigCache: mocks,
}));

import {
  capabilitySatisfied,
  detectRequestCapabilities,
  resolveExpertCapabilities,
} from "./capabilities.js";

describe("detectRequestCapabilities", () => {
  test("OpenAI image_url content requires vision", () => {
    expect(
      detectRequestCapabilities({
        messages: [
          { role: "user", content: [{ type: "text", text: "看图" }, { type: "image_url", image_url: { url: "data:..." } }] },
        ],
      }),
    ).toEqual({ hasImages: true, hasTools: false });
  });

  test("Anthropic image block and tool_use message", () => {
    expect(
      detectRequestCapabilities({
        messages: [
          { role: "user", content: [{ type: "image", source: { type: "base64" } }] },
          { role: "assistant", content: null, tool_calls: [{ id: "1" }] },
        ],
      }),
    ).toEqual({ hasImages: true, hasTools: true });
  });

  test("body.tools definitions and Gemini inline_data", () => {
    expect(detectRequestCapabilities({ tools: [{ type: "function" }] })).toEqual({
      hasImages: false,
      hasTools: true,
    });
    expect(
      detectRequestCapabilities({ contents: [{ role: "user", parts: [{ inline_data: { mimeType: "image/png" } }] }] }),
    ).toEqual({ hasImages: true, hasTools: false });
  });

  test("Responses function_call and plain text", () => {
    expect(
      detectRequestCapabilities({ input: [{ type: "message", role: "user", content: "hi" }] }),
    ).toEqual({ hasImages: false, hasTools: false });
    expect(
      detectRequestCapabilities({ input: [{ type: "function_call", name: "ls" }] }),
    ).toEqual({ hasImages: false, hasTools: true });
  });
});

describe("capabilitySatisfied", () => {
  const req = { hasImages: false, hasTools: false };

  test("unknown metadata never filters", () => {
    expect(capabilitySatisfied(undefined, { hasImages: true, hasTools: true }, 1e9)).toBe(true);
  });

  test("vision and tool constraints", () => {
    expect(capabilitySatisfied({ supportsVision: false }, { hasImages: true, hasTools: false }, undefined)).toBe(false);
    expect(capabilitySatisfied({ supportsVision: true }, { hasImages: true, hasTools: false }, undefined)).toBe(true);
    expect(capabilitySatisfied({ supportsToolCalling: false }, { hasImages: false, hasTools: true }, undefined)).toBe(false);
    // Tool declarations alone don't block a vision-less model.
    expect(capabilitySatisfied({ supportsVision: false }, { hasImages: false, hasTools: true }, undefined)).toBe(true);
  });

  test("context overflow forces escalation", () => {
    expect(capabilitySatisfied({ contextWindow: 8000 }, req, 9000)).toBe(false);
    expect(capabilitySatisfied({ contextWindow: 8000 }, req, 8000)).toBe(true);
    // Unknown window never filters.
    expect(capabilitySatisfied({}, req, 1e9)).toBe(true);
    // Zero/undefined token estimates skip the check.
    expect(capabilitySatisfied({ contextWindow: 100 }, req, 0)).toBe(true);
    expect(capabilitySatisfied({ contextWindow: 100 }, req, undefined)).toBe(true);
  });
});

describe("resolveExpertCapabilities", () => {
  test("virtual experts read attributes through the hot cache", async () => {
    mocks.getModelById.mockResolvedValue({
      id: "m1",
      model_attributes: JSON.stringify({
        context_window: 32000,
        supports_vision: false,
        supports_function_calling: true,
      }),
    });
    const caps = await resolveExpertCapabilities({ type: "virtual", model_id: "m1" });
    expect(caps).toEqual({ contextWindow: 32000, supportsVision: false, supportsToolCalling: true });
    expect(mocks.getModelById).toHaveBeenCalledWith("m1");
  });

  test("missing model rows or invalid JSON degrade to unknown", async () => {
    mocks.getModelById.mockResolvedValue(undefined);
    expect(await resolveExpertCapabilities({ type: "virtual", model_id: "gone" })).toEqual({});
    mocks.getModelById.mockResolvedValue({ model_attributes: "not-json" });
    expect(await resolveExpertCapabilities({ type: "virtual", model_id: "bad" })).toEqual({});
    expect(await resolveExpertCapabilities({ type: "virtual" })).toEqual({});
  });
});
