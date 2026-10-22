import type { E2EContext } from "./context.js";
import { MOCK_UPSTREAM_KEY } from "./env.js";

export interface SeedResult {
  token: string;
  expertVirtualModelName: string;
  expertUpstreamModels: { low: string; medium: string; high: string };
  /** key = 网关侧模型名（含 expert-e2e），value = 虚拟密钥明文 */
  virtualKeys: Record<string, string>;
}

function authed(token: string) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  };
}

export async function seedViaAdminApi(gatewayBaseUrl: string, mockBaseUrl: string): Promise<SeedResult> {
  // 1) 引导管理员并获取 JWT
  const reg = await fetch(`${gatewayBaseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "e2e-admin", password: "e2e-password-123456" }),
  });
  if (!reg.ok) throw new Error(`register failed: HTTP ${reg.status} ${await reg.text()}`);
  const { token } = (await reg.json()) as { token: string };

  // 2) 一个 provider 承载三种协议（protocolMappings 全部指向 mock upstream）
  const providerRes = await fetch(`${gatewayBaseUrl}/api/admin/providers`, {
    method: "POST",
    headers: authed(token),
    body: JSON.stringify({
      id: "prov-e2e-mock",
      name: "E2E Mock Upstream",
      baseUrl: mockBaseUrl,
      apiKey: MOCK_UPSTREAM_KEY,
      protocolMappings: {
        // buildOpenAICompatibleUrl 只在 base 已含 /v1 时去重，openai 链路的转发路径是
        // /chat/completions（无 /v1），因此 openai 映射必须自带 /v1；anthropic/google 的
        // 转发路径本身含 /v1 前缀，用裸 base 即可。
        openai: `${mockBaseUrl}/v1`,
        anthropic: mockBaseUrl,
        google: mockBaseUrl,
      },
      enabled: true,
    }),
  });
  if (!providerRes.ok) throw new Error(`provider create failed: HTTP ${providerRes.status} ${await providerRes.text()}`);

  // 3) 直连链路三个模型 + 智能路由三个档位专家模型
  const modelPlan: Array<{ gateway: string; identifier: string }> = [
    { gateway: "gpt-e2e", identifier: "mock-gpt" },
    { gateway: "claude-e2e", identifier: "mock-claude" },
    { gateway: "gemini-e2e", identifier: "mock-gemini" },
    { gateway: "expert-low-e2e", identifier: "mock-expert-low" },
    { gateway: "expert-med-e2e", identifier: "mock-expert-med" },
    { gateway: "expert-high-e2e", identifier: "mock-expert-high" },
  ];
  const modelIds = new Map<string, string>();
  for (const m of modelPlan) {
    const res = await fetch(`${gatewayBaseUrl}/api/admin/models`, {
      method: "POST",
      headers: authed(token),
      body: JSON.stringify({
        name: m.gateway,
        providerId: "prov-e2e-mock",
        modelIdentifier: m.identifier,
        enabled: true,
      }),
    });
    if (!res.ok) throw new Error(`model ${m.gateway} create failed: HTTP ${res.status} ${await res.text()}`);
    const { id } = (await res.json()) as { id: string };
    modelIds.set(m.gateway, id);
  }

  // 4) 直连链路的虚拟密钥：每条链路一把、按模型绑定。注意 provider 级绑定的 VK 会走直通管道，
  //    只有模型级绑定才能命中虚拟模型 → 专家路由分支。
  const virtualKeys: Record<string, string> = {};
  const createVk = async (name: string, modelId: string | undefined): Promise<string> => {
    const value = `sk-e2e-${name}`;
    const vkRes = await fetch(`${gatewayBaseUrl}/api/admin/virtual-keys`, {
      method: "POST",
      headers: authed(token),
      body: JSON.stringify({
        name,
        modelId,
        keyType: "custom",
        customKey: value,
        routingStrategy: "single",
        enabled: true,
      }),
    });
    if (!vkRes.ok) throw new Error(`virtual key ${name} create failed: HTTP ${vkRes.status} ${await vkRes.text()}`);
    return value;
  };
  virtualKeys["gpt-e2e"] = await createVk("e2e-vk-openai", modelIds.get("gpt-e2e"));
  virtualKeys["claude-e2e"] = await createVk("e2e-vk-anthropic", modelIds.get("claude-e2e"));
  virtualKeys["gemini-e2e"] = await createVk("e2e-vk-gemini", modelIds.get("gemini-e2e"));

  // 5) 智能路由配置：三档专家 + fallback=medium + fail_open=fallback；
  //    自动创建暴露的虚拟模型（classifier 由 JEV_API_URL 指向 mock 的 /jev）
  const expertRes = await fetch(`${gatewayBaseUrl}/api/admin/expert-routing`, {
    method: "POST",
    headers: authed(token),
    body: JSON.stringify({
      name: "e2e-expert-routing",
      enabled: true,
      createVirtualModel: true,
      virtualModelName: "expert-e2e",
      fail_open: "fallback",
      experts: [
        { id: "low", type: "real", provider_id: "prov-e2e-mock", model_id: modelIds.get("expert-low-e2e"), model: "mock-expert-low", band: "low" },
        { id: "medium", type: "real", provider_id: "prov-e2e-mock", model_id: modelIds.get("expert-med-e2e"), model: "mock-expert-med", band: "medium" },
        { id: "high", type: "real", provider_id: "prov-e2e-mock", model_id: modelIds.get("expert-high-e2e"), model: "mock-expert-high", band: "high" },
      ],
      fallback: { type: "real", provider_id: "prov-e2e-mock", model_id: modelIds.get("expert-med-e2e"), model: "mock-expert-med" },
    }),
  });
  if (!expertRes.ok) {
    throw new Error(`expert routing create failed: HTTP ${expertRes.status} ${await expertRes.text()}`);
  }
  const expertBody = (await expertRes.json()) as {
    virtualModel: { id: string; name: string } | null;
  };
  if (!expertBody.virtualModel) throw new Error("expert routing did not create the exposed virtual model");

  // 6) 专家链路 VK：绑定专家路由创建的虚拟模型，必须在专家配置之后创建
  virtualKeys[expertBody.virtualModel.name] = await createVk(
    "e2e-vk-expert",
    expertBody.virtualModel.id,
  );

  return {
    token,
    expertVirtualModelName: expertBody.virtualModel.name,
    expertUpstreamModels: {
      low: "mock-expert-low",
      medium: "mock-expert-med",
      high: "mock-expert-high",
    },
    virtualKeys,
  };
}
