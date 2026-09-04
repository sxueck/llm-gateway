import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateVirtualKey: vi.fn(),
  classifyIntent: vi.fn(),
  intentClassifyLogCreate: vi.fn(),
}));

vi.mock("./proxy/auth.js", () => ({
  extractVirtualKeyAuthHeader: (headers: Record<string, string>) =>
    headers.authorization,
  authenticateVirtualKey: mocks.authenticateVirtualKey,
}));
vi.mock("../services/expert-router/intent-router-client.js", () => ({
  classifyIntent: mocks.classifyIntent,
  IntentRouterApiError: class IntentRouterApiError extends Error {
    constructor(
      message: string,
      readonly configured: boolean,
    ) {
      super(message);
    }
  },
}));
vi.mock("../services/logger.js", () => ({
  memoryLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("../db/index.js", () => ({
  intentClassifyLogDb: { create: mocks.intentClassifyLogCreate },
}));

import { intentRoutes } from "./intent.js";

const AUTH_OK = {
  virtualKey: { id: "vk-1" },
  virtualKeyValue: "vk-test-12345678",
};
const REMOTE_RESULT = {
  object: "intent.classification",
  model: "snival/intent-router-zh-setfit-v2",
  revision: "revision",
  latency_ms: 12.5,
  stats: { batch_size: 1, cache_hits: 0, inference_ms: 10 },
  data: [
    {
      index: 0,
      truncated: false,
      token_count: 8,
      labels: [{ label: "code_review", domain: "coding", score: 0.9 }],
      route: {
        intent: "code_review",
        domain: "coding",
        rejected: false,
        reason: "argmax",
        top1_score: 0.9,
      },
    },
  ],
};

function createFastifyStub() {
  const routes = new Map<string, Function>();
  return {
    routes,
    fastify: {
      post: vi.fn((path: string, handler: Function) =>
        routes.set(path, handler),
      ),
    } as any,
  };
}
function createReplyStub() {
  const reply: any = {
    statusCode: 200,
    body: undefined,
    code(code: number) {
      reply.statusCode = code;
      return reply;
    },
    send(body: unknown) {
      reply.body = body;
      return reply;
    },
  };
  return reply;
}
async function callHandler(
  body: unknown,
  headers = { authorization: "Bearer key" },
) {
  const { routes, fastify } = createFastifyStub();
  await intentRoutes(fastify);
  const reply = createReplyStub();
  await routes.get("/classify")!({ headers, body }, reply);
  return reply;
}

describe("intentRoutes POST /classify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticateVirtualKey.mockResolvedValue(AUTH_OK);
    mocks.classifyIntent.mockResolvedValue(REMOTE_RESULT);
    mocks.intentClassifyLogCreate.mockResolvedValue(undefined);
  });

  it("proxies a validated request and preserves the gateway response contract", async () => {
    const reply = await callHandler({ input: "review this PR", top_n: 1 });
    expect(reply.statusCode).toBe(200);
    expect(mocks.classifyIntent).toHaveBeenCalledWith("review this PR");
    expect(reply.body).toMatchObject({
      model: REMOTE_RESULT.model,
      labels: [{ label: "code_review", score: 0.9 }],
      total_labels: 1,
      seq_len: 8,
    });
    expect(mocks.intentClassifyLogCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        classifier_model: REMOTE_RESULT.model,
        top_label: "code_review",
      }),
    );
  });

  it("rejects invalid input before calling the remote service", async () => {
    const reply = await callHandler({ input: "" });
    expect(reply.statusCode).toBe(400);
    expect(mocks.classifyIntent).not.toHaveBeenCalled();
  });

  it("forwards authentication failures", async () => {
    mocks.authenticateVirtualKey.mockResolvedValue({
      error: { code: 401, body: { error: { code: "missing_authorization" } } },
    });
    const reply = await callHandler({ input: "review" });
    expect(reply.statusCode).toBe(401);
    expect(mocks.classifyIntent).not.toHaveBeenCalled();
  });

  it("maps remote failures to a gateway error", async () => {
    mocks.classifyIntent.mockRejectedValue(new Error("upstream unavailable"));
    const reply = await callHandler({ input: "review" });
    expect(reply.statusCode).toBe(502);
    expect((reply.body as any).error.code).toBe("classification_error");
    expect(mocks.intentClassifyLogCreate).not.toHaveBeenCalled();
  });
});
