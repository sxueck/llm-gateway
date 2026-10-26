import { createRenderer, defineComponent, h, nextTick, ssrContextKey } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const { api, message } = vi.hoisted(() => ({
  api: {
    getSystemSettings: vi.fn(),
    updateSystemSettings: vi.fn(),
  },
  message: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/api/config", () => ({ configApi: api }));
vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock("@/stores/model", () => ({
  useModelStore: () => ({
    models: [{ name: "gpt-x", isVirtual: false }, { name: "gpt-v", isVirtual: true }],
    fetchModels: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock("naive-ui", () => {
  const stub = defineComponent({ render: () => h("stub") });
  return {
    NSpace: stub,
    NText: stub,
    NButton: stub,
    NSelect: stub,
    NInputNumber: stub,
    useMessage: () => message,
  };
});

import ModelBudgetSettings from "./ModelBudgetSettings.vue";

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
  return { modelDailyTokenLimits };
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await nextTick();
}

function mount() {
  const root = node("root");
  ModelBudgetSettings.render = () => null;
  const app = renderer.createApp(ModelBudgetSettings);
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
});

describe("model budget settings init", () => {
  it("loads quota rows from server settings on mount", async () => {
    const view = mount();
    await flush();

    expect(api.getSystemSettings).toHaveBeenCalledTimes(1);
    expect(view.state.quotaRows).toEqual([{ model: "gpt-x", limitMillions: 1 }]);
    expect(view.state.savingQuota).toBe(false);
    view.unmount();
  });
});

describe("model budget settings save/refresh/reset", () => {
  it("uses the latest server state for usage display and reset after saving", async () => {
    const view = mount();
    await flush();
    api.getSystemSettings.mockResolvedValue(settings(refreshedLimits));
    view.state.quotaRows = [
      { model: " gpt-x ", limitMillions: 2 },
      { model: "", limitMillions: 5 },
      { model: "gpt-z", limitMillions: 0 },
    ];

    await view.state.onSaveModelQuotas();

    expect(api.updateSystemSettings).toHaveBeenCalledWith({
      modelDailyTokenLimits: [{ model: "gpt-x", limitMillions: 2 }],
    });
    expect(message.success).toHaveBeenCalledWith("messages.operationSuccess");
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

describe("model budget migration source assertions", () => {
  it("CostAnalysisView tabs are ordered mappings -> prices -> budgets", () => {
    const src = readFileSync(join(__dirname, "../views/CostAnalysisView.vue"), "utf8");
    const positions = ["mappings", "prices", "budgets"].map(name =>
      src.indexOf(`<n-tab-pane name="${name}"`),
    );
    expect(positions.every(p => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(src).toContain("costAnalysis.tabs.budgets");
    expect(src).toMatch(/<n-tab-pane name="budgets"[^>]*display-directive="show:lazy"/);
  });

  it("SettingsView no longer hosts the model daily token quota entry", () => {
    const src = readFileSync(join(__dirname, "../views/SettingsView.vue"), "utf8");
    expect(src).not.toContain("modelDailyTokenQuota");
    expect(src).not.toContain("quotaRows");
    expect(src).not.toContain("modelDailyTokenLimits");
    expect(src).not.toContain("useModelStore");
  });
});
