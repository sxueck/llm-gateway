import { createRenderer, defineComponent, h, nextTick, ref, ssrContextKey } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { api, authApi, message } = vi.hoisted(() => ({
  api: {
    getSystemSettings: vi.fn(),
    updateSystemSettings: vi.fn(),
    getTrafficAnalysisRegions: vi.fn(),
  },
  authApi: { getAllUsers: vi.fn() },
  message: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/api/config", () => ({ configApi: api }));
vi.mock("@/api/auth", () => ({ authApi }));
vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("@/stores/auth", () => ({
  useAuthStore: () => ({ user: null }),
}));
vi.mock("@/stores/provider", () => ({
  useProviderStore: () => ({ providers: [], fetchProviders: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("@/stores/virtual-key", () => ({
  useVirtualKeyStore: () => ({ virtualKeys: [], fetchVirtualKeys: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("@/stores/model", () => ({
  useModelStore: () => ({ models: [], fetchModels: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("@/composables/useSystemConfig", () => ({
  useSystemConfig: () => ({ dashboardHideRequestSourceCard: ref(false) }),
}));
vi.mock("naive-ui", () => {
  const stub = defineComponent({ render: () => h("stub") });
  return {
    NSpace: stub,
    NCard: stub,
    NDescriptions: stub,
    NDescriptionsItem: stub,
    NSwitch: stub,
    NAlert: stub,
    NText: stub,
    NDivider: stub,
    NInput: stub,
    NButton: stub,
    NSelect: stub,
    NInputNumber: stub,
    useMessage: () => message,
    useDialog: () => ({ warning: vi.fn() }),
  };
});

import SettingsView from "./SettingsView.vue";

type TestNode = {
  type: string;
  props: Record<string, any>;
  children: TestNode[];
  parent?: TestNode;
  text?: string;
};

function node(type: string, text?: string): TestNode {
  return { type, props: {}, children: [], text };
}

const renderer = createRenderer<TestNode, TestNode>({
  createElement: (type) => node(type),
  createText: (text) => node("text", text),
  createComment: (text) => node("comment", text),
  setText: (el, text) => { el.text = text; },
  setElementText: (el, text) => { el.children = []; el.text = text; },
  patchProp: (el, key, _previous, next) => { el.props[key] = next; },
  insert: (el, parent, anchor) => {
    if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1);
    el.parent = parent;
    const index = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(index < 0 ? parent.children.length : index, 0, el);
  },
  remove: (el) => {
    if (el.parent) el.parent.children.splice(el.parent.children.indexOf(el), 1);
    el.parent = undefined;
  },
  parentNode: (el) => el.parent ?? null,
  nextSibling: (el) => {
    if (!el.parent) return null;
    return el.parent.children[el.parent.children.indexOf(el) + 1] ?? null;
  },
});

const initialLimits = [
  { model: "gpt-x", limitMillions: 1, limitTokens: 1_000_000, usedTokens: 100, requestCount: 1 },
];
const refreshedLimits = [
  { model: "gpt-x", limitMillions: 2, limitTokens: 2_000_000, usedTokens: 200, requestCount: 2 },
  { model: "gpt-y", limitMillions: 1, limitTokens: 1_000_000, usedTokens: 50, requestCount: 1 },
];

function settings(modelDailyTokenLimits: typeof initialLimits) {
  return {
    allowRegistration: true,
    corsEnabled: false,
    litellmCompatEnabled: false,
    streamResumeEnabled: false,
    publicUrl: "http://localhost:3000",
    trafficAnalysisRegion: null,
    dashboardHideRequestSourceCard: false,
    reasoningEffortModelSuffixes: [],
    modelDailyTokenLimits,
  };
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await nextTick();
}

function mount() {
  const root = node("root");
  SettingsView.render = () => null;
  const app = renderer.createApp(SettingsView);
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(root);
  return {
    state: (app as any)._instance.setupState,
    unmount: () => app.unmount(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getSystemSettings.mockResolvedValue(settings(initialLimits));
  api.updateSystemSettings.mockResolvedValue({ success: true });
  api.getTrafficAnalysisRegions.mockResolvedValue([]);
  authApi.getAllUsers.mockResolvedValue([]);
});

describe("settings model quota refresh", () => {
  it("uses the latest server state for usage display and reset after saving", async () => {
    const view = mount();
    await flush();
    api.getSystemSettings.mockResolvedValue(settings(refreshedLimits));
    view.state.quotaRows = [{ model: "gpt-x", limitMillions: 2 }];

    await view.state.onSaveModelQuotas();

    expect(view.state.quotaUsage).toEqual(refreshedLimits);
    expect(view.state.quotaRows).toEqual([
      { model: "gpt-x", limitMillions: 2 },
      { model: "gpt-y", limitMillions: 1 },
    ]);

    view.state.quotaRows = [];
    view.state.onResetModelQuotas();
    expect(view.state.quotaRows).toEqual([
      { model: "gpt-x", limitMillions: 2 },
      { model: "gpt-y", limitMillions: 1 },
    ]);
    view.unmount();
  });
});
