import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateVirtualKey: vi.fn(),
  classifyWithLocalOnnx: vi.fn(),
  isLocalClassifierReady: vi.fn(),
  isLocalClassifierDisabled: vi.fn(),
  getLocalClassifierError: vi.fn(),
  intentClassifyLogCreate: vi.fn(),
}));

vi.mock("./proxy/auth.js", () => ({
  extractVirtualKeyAuthHeader: (headers: Record<string, any>) =>
    headers.authorization || headers["x-api-key"]
      ? `Bearer ${(headers.authorization || headers["x-api-key"]).replace(/^Bearer\s*/, "")}`
      : undefined,
  authenticateVirtualKey: mocks.authenticateVirtualKey,
}));

vi.mock("../services/expert-router/local/classifier.js", () => ({
  classifyWithLocalOnnx: mocks.classifyWithLocalOnnx,
}));

vi.mock("../services/expert-router/local/model-assets.js", () => ({
  isLocalClassifierReady: mocks.isLocalClassifierReady,
  isLocalClassifierDisabled: mocks.isLocalClassifierDisabled,
  getLocalClassifierError: mocks.getLocalClassifierError,
}));

vi.mock("../services/logger.js", () => ({
  memoryLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../db/index.js", () => ({
  intentClassifyLogDb: { create: mocks.intentClassifyLogCreate },
}));

import { intentRoutes } from "./intent.js";

const AUTH_OK = {
  virtualKey: { id: "vk-1", enabled: 1 },
  virtualKeyValue: "vk-test-12345678",
};

function createFastifyStub() {
  const routes = new Map<string, Function>();
  return {
    routes,
    fastify: {
      post: vi.fn((path: string, handler: Function) =>
        routes.set(path, handler),
      ),
      get: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    } as any,
  };
}

function createReplyStub() {
  const reply: any = {
    statusCode: 200,
    body: undefined,
    headers: {} as Record<string, string>,
    code(c: number) {
      reply.statusCode = c;
      return reply;
    },
    header(k: string, v: string) {
      reply.headers[k] = v;
      return reply;
    },
    send(b: any) {
      reply.body = b;
      return reply;
    },
  };
  return reply;
}

function makeClassifyResult(overrides: Record<string, any> = {}) {
  return {
    policy: {
      chosenLabel: "coding",
      rejected: false,
      top1: { label: "coding", score: 0.9 },
      top2: { label: "general_control", score: 0.05 },
    },
    ranked: [
      { label: "coding", score: 0.9 },
      { label: "general_control", score: 0.05 },
      { label: "data_analysis", score: 0.03 },
    ],
    revision: "ce71b323",
    latencyMs: 12,
    seqLen: 8,
    truncated: false,
    ...overrides,
  };
}

async function callHandler(
  body: any,
  headers: Record<string, string> = {
    authorization: "Bearer vk-test-12345678",
  },
) {
  const { routes, fastify } = createFastifyStub();
  await intentRoutes(fastify);
  const handler = routes.get("/classify")!;
  const reply = createReplyStub();
  await handler({ headers, body } as any, reply);
  return reply;
}

describe("intentRoutes POST /classify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateVirtualKey.mockResolvedValue(AUTH_OK);
    mocks.isLocalClassifierReady.mockReturnValue(true);
    mocks.isLocalClassifierDisabled.mockReturnValue(false);
    mocks.getLocalClassifierError.mockReturnValue(undefined);
    mocks.classifyWithLocalOnnx.mockResolvedValue(makeClassifyResult());
    mocks.intentClassifyLogCreate.mockResolvedValue(undefined);
  });

  it("rejects missing authentication with 401", async () => {
    mocks.authenticateVirtualKey.mockResolvedValue({
      error: {
        code: 401,
        body: {
          error: {
            message: "Missing authentication",
            type: "invalid_request_error",
            param: null,
            code: "missing_authorization",
          },
        },
      },
    });

    const reply = await callHandler({ input: "hello" }, {});
    expect(reply.statusCode).toBe(401);
    expect((reply.body as any).error.code).toBe("missing_authorization");
  });

  it("rejects a disabled virtual key with 403", async () => {
    mocks.authenticateVirtualKey.mockResolvedValue({
      error: {
        code: 403,
        body: {
          error: {
            message: "Virtual key has been disabled",
            type: "invalid_request_error",
            param: null,
            code: "api_key_disabled",
          },
        },
      },
    });

    const reply = await callHandler({ input: "hello" });
    expect(reply.statusCode).toBe(403);
    expect((reply.body as any).error.code).toBe("api_key_disabled");
  });

  it("rejects an empty input with 400", async () => {
    const reply = await callHandler({ input: "" });
    expect(reply.statusCode).toBe(400);
    expect((reply.body as any).error.code).toBe("validation_error");
    expect(mocks.classifyWithLocalOnnx).not.toHaveBeenCalled();
  });

  it("rejects out-of-range top_n / max_tokens with 400", async () => {
    const badTopN = await callHandler({ input: "x", top_n: 0 });
    expect(badTopN.statusCode).toBe(400);

    const badMaxTokens = await callHandler({ input: "x", max_tokens: 4096 });
    expect(badMaxTokens.statusCode).toBe(400);
  });

  it("returns 503 when the local classifier is not ready", async () => {
    mocks.isLocalClassifierReady.mockReturnValue(false);
    mocks.getLocalClassifierError.mockReturnValue("assets missing");

    const reply = await callHandler({ input: "帮我写个快排" });
    expect(reply.statusCode).toBe(503);
    expect((reply.body as any).error.code).toBe("classifier_not_ready");
    expect((reply.body as any).error.message).toContain("assets missing");
    expect(mocks.classifyWithLocalOnnx).not.toHaveBeenCalled();
  });

  it("returns 503 classifier_disabled when the classifier is disabled by env", async () => {
    mocks.isLocalClassifierDisabled.mockReturnValue(true);

    const reply = await callHandler({ input: "帮我写个快排" });
    expect(reply.statusCode).toBe(503);
    expect((reply.body as any).error.code).toBe("classifier_disabled");
    expect((reply.body as any).error.message).toContain(
      "LOCAL_INTENT_CLASSIFIER=off",
    );
    expect(mocks.isLocalClassifierReady).not.toHaveBeenCalled();
    expect(mocks.classifyWithLocalOnnx).not.toHaveBeenCalled();
    expect(mocks.intentClassifyLogCreate).not.toHaveBeenCalled();
  });

  it("returns the full ranked distribution by default", async () => {
    const reply = await callHandler({ input: "帮我写个快排" });
    expect(reply.statusCode).toBe(200);
    const body = reply.body as any;
    expect(body.object).toBe("intent_classification");
    expect(body.model).toBe("onnx/snival/intent-router-zh-setfit-v1");
    expect(body.labels).toHaveLength(3);
    expect(body.labels[0]).toEqual({ label: "coding", score: 0.9 });
    expect(body.total_labels).toBe(3);
    expect(body.seq_len).toBe(8);
    expect(body.input_truncated).toBe(false);
    expect(body.latency_ms).toBe(12);
    expect(mocks.classifyWithLocalOnnx).toHaveBeenCalledWith(
      "帮我写个快排",
      1024,
    );
    expect(mocks.intentClassifyLogCreate).toHaveBeenCalledTimes(1);
    expect(mocks.intentClassifyLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        virtual_key_id: "vk-1",
        top_label: "coding",
        latency_ms: 12,
        seq_len: 8,
        input_truncated: false,
      }),
    );
  });

  it("slices the distribution to top_n while keeping total_labels", async () => {
    const reply = await callHandler({ input: "帮我写个快排", top_n: 2 });
    expect(reply.statusCode).toBe(200);
    const body = reply.body as any;
    expect(body.labels).toHaveLength(2);
    expect(body.labels.map((l: any) => l.label)).toEqual([
      "coding",
      "general_control",
    ]);
    expect(body.total_labels).toBe(3);
  });

  it("clamps top_n beyond the label count to the full distribution", async () => {
    const reply = await callHandler({ input: "帮我写个快排", top_n: 99 });
    expect(reply.statusCode).toBe(200);
    expect((reply.body as any).labels).toHaveLength(3);
  });

  it("returns 500 and does not log when inference throws", async () => {
    mocks.classifyWithLocalOnnx.mockRejectedValue(
      new Error("onnx session failed"),
    );

    const reply = await callHandler({ input: "帮我写个快排" });
    expect(reply.statusCode).toBe(500);
    expect((reply.body as any).error.code).toBe("classification_error");
    expect((reply.body as any).error.message).toContain("onnx session failed");
    expect(mocks.intentClassifyLogCreate).not.toHaveBeenCalled();
  });
});
