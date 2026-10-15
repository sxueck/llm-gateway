import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const create = vi.fn();
  return { create };
});

vi.mock("../db/index.js", () => ({
  apiRequestDb: { create: mocks.create },
}));

import { logApiRequestToDb } from "./api-request-logger.js";
import {
  AGENT_LOOPBACK_HEADER,
  AGENT_RUN_ID_HEADER,
  agentLoopbackToken,
} from "../agent/run/loopback-token.js";

const baseParams = {
  virtualKey: { id: "vk-1", disable_logging: 0 } as any,
  providerId: "prov-1",
  model: "gpt-test",
  tokenCount: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
  status: "success" as const,
  responseTime: 100,
};

describe("logApiRequestToDb disable_logging suppression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue(undefined);
  });

  it("keeps ip, user_agent and error_message for normal keys", async () => {
    await logApiRequestToDb({
      ...baseParams,
      status: "error",
      errorMessage: "upstream exploded",
      ip: "1.2.3.4",
      userAgent: "UA/1.0",
    });

    const row = mocks.create.mock.calls[0][0];
    expect(row.ip).toBe("1.2.3.4");
    expect(row.user_agent).toBe("UA/1.0");
    expect(row.error_message).toBe("upstream exploded");
  });

  it("suppresses ip, user_agent and error_message when disable_logging is set", async () => {
    await logApiRequestToDb({
      ...baseParams,
      virtualKey: { id: "vk-2", disable_logging: 1 } as any,
      status: "error",
      errorMessage: JSON.stringify({
        error: { message: "prompt echo: secret" },
      }),
      ip: "1.2.3.4",
      userAgent: "UA/1.0",
    });

    const row = mocks.create.mock.calls[0][0];
    expect(row.ip).toBeUndefined();
    expect(row.user_agent).toBeUndefined();
    expect(row.error_message).toBeUndefined();
    // usage and attribution metadata still recorded for ops stats
    expect(row.virtual_key_id).toBe("vk-2");
    expect(row.prompt_tokens).toBe(1);
    expect(row.status).toBe("error");
  });
});

describe("logApiRequestToDb agent run correlation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue(undefined);
  });

  it("stamps run_id when the loopback token is valid", async () => {
    await logApiRequestToDb({
      ...baseParams,
      request: {
        headers: {
          [AGENT_LOOPBACK_HEADER]: agentLoopbackToken(),
          [AGENT_RUN_ID_HEADER]: "asr_1",
        },
      },
    });

    expect(mocks.create.mock.calls[0][0].run_id).toBe("asr_1");
  });

  it("drops run correlation when the loopback token is missing or invalid", async () => {
    await logApiRequestToDb({
      ...baseParams,
      request: { headers: { [AGENT_RUN_ID_HEADER]: "asr_spoof" } },
    });
    expect(mocks.create.mock.calls[0][0].run_id).toBeUndefined();

    await logApiRequestToDb({
      ...baseParams,
      request: {
        headers: {
          [AGENT_LOOPBACK_HEADER]: "f".repeat(64),
          [AGENT_RUN_ID_HEADER]: "asr_spoof",
        },
      },
    });
    expect(mocks.create.mock.calls[1][0].run_id).toBeUndefined();
  });

  it("prefers an explicit agentRunId over header derivation", async () => {
    await logApiRequestToDb({
      ...baseParams,
      agentRunId: "asr_explicit",
      request: {
        headers: {
          [AGENT_LOOPBACK_HEADER]: agentLoopbackToken(),
          [AGENT_RUN_ID_HEADER]: "asr_header",
        },
      },
    });

    expect(mocks.create.mock.calls[0][0].run_id).toBe("asr_explicit");
  });
});

describe("logApiRequestToDb 会话标识入库", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockResolvedValue(undefined);
  });

  it("从请求体 metadata.session_id 提取", async () => {
    await logApiRequestToDb({
      ...baseParams,
      truncatedRequest: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        metadata: { session_id: "sess-body" },
      }),
    });

    expect(mocks.create.mock.calls[0][0].session_id).toBe("sess-body");
  });

  it("请求头优先于请求体，且不依赖请求体可解析", async () => {
    await logApiRequestToDb({
      ...baseParams,
      request: { headers: { "x-session-id": "sess-head" } },
      truncatedRequest: "{ 已被截断的 JSON",
    });

    expect(mocks.create.mock.calls[0][0].session_id).toBe("sess-head");
  });

  it("原始 body 的标识优先于截断摘要（超长正文不丢会话）", async () => {
    await logApiRequestToDb({
      ...baseParams,
      request: { headers: {}, body: { metadata: { session_id: "sess-raw" } } },
      truncatedRequest: '{"truncated":true,"top_level_keys":["messages"]}',
    });

    expect(mocks.create.mock.calls[0][0].session_id).toBe("sess-raw");
  });

  it("两者都缺失时写 NULL，交给读取侧启发式兼底", async () => {
    await logApiRequestToDb({ ...baseParams });

    expect(mocks.create.mock.calls[0][0].session_id).toBeNull();
  });

  it("disable_logging 密钥不写会话标识（与 ip/user_agent 同一隐私口径）", async () => {
    await logApiRequestToDb({
      ...baseParams,
      virtualKey: { id: "vk-2", disable_logging: 1 } as any,
      request: { headers: { "x-session-id": "sess-secret" } },
    });

    expect(mocks.create.mock.calls[0][0].session_id).toBeNull();
  });
});
