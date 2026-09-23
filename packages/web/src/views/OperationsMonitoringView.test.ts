import { createRenderer, defineComponent, h, nextTick, ref, ssrContextKey } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { api, push } = vi.hoisted(() => ({
  api: {
    getOverview: vi.fn(),
    getTrend: vi.fn(),
    getDimensionList: vi.fn(),
  },
  push: vi.fn(),
}));

vi.mock("@/api/ops-metrics", () => ({ opsMetricsApi: api }));
vi.mock("vue-router", () => ({ useRouter: () => ({ push }) }));
vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key, locale: ref("zh-CN") }),
}));
vi.mock("@/utils/common", () => ({ copyToClipboard: vi.fn() }));
vi.mock("@/utils/format", () => ({
  formatTokenNumber: (value: number) => String(value),
}));
vi.mock("vue-echarts", () => ({
  default: defineComponent({ render: () => h("chart") }),
}));
vi.mock("naive-ui", () => {
  const stub = defineComponent({
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => h("stub", attrs, slots.default?.());
    },
  });
  return {
    useMessage: () => ({
      error: vi.fn(), info: vi.fn(), warning: vi.fn(), success: vi.fn(),
    }),
    NAlert: stub, NButton: stub, NCard: stub, NDataTable: stub, NEmpty: stub,
    NGi: stub, NGrid: stub, NIcon: stub, NInput: stub, NRadioButton: stub,
    NRadioGroup: stub, NSelect: stub, NSkeleton: stub, NSpace: stub,
    NTabPane: stub, NTabs: stub, NTag: stub, NText: stub, NTooltip: stub,
  };
});

import OperationsMonitoringView from "./OperationsMonitoringView.vue";

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
    if (el.parent) {
      el.parent.children.splice(el.parent.children.indexOf(el), 1);
    }
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

const metrics = {
  requestCount: 0, successCount: 0, failureCount: 0, successRate: null,
  totalTokens: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0,
  avgTffbMs: null, validTffbCount: 0, avgResponseTimeMs: null,
  validResponseTimeCount: 0, avgOutputSpeed: null,
};
const overview = (count: number) => ({
  window: {
    startTime: 1_700_000_000_000,
    endTime: 1_700_086_400_000,
    timezone: "Asia/Shanghai",
  },
  updatedAt: 1_700_086_400_000,
  metrics: { ...metrics, requestCount: count },
  dataCoverage: {
    detailStart: 1_600_000_000_000,
    hourlyFrom: null, hourlyTo: null, gaps: [], exact: true,
  },
});

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await nextTick();
}

function mount() {
  const root = node("root");
  OperationsMonitoringView.render = () => null;
  const app = renderer.createApp(OperationsMonitoringView);
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(root);
  const state = (app as any)._instance.setupState;
  return { state, unmount: () => app.unmount() };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getOverview.mockResolvedValue(overview(101));
  api.getTrend.mockResolvedValue({ granularity: "hour", points: [] });
  api.getDimensionList.mockResolvedValue({ items: [], pagination: { total: 0 } });
});

describe("operations monitoring interactions", () => {
  it.each([
    ["virtualKey", "virtualKeyId", "key-rare"],
    ["model", "model", "model-rare"],
    ["provider", "providerId", "provider-rare"],
  ])("drills into the clicked %s row and its failed requests", async (dimension, filter, id) => {
    const view = mount();
    await flush();
    const buttons = view.state.renderRowActions({ id, name: id }, dimension)
      .children.default();
    buttons[buttons.length - 1].props.onClick({ stopPropagation() {} });
    expect(push).toHaveBeenCalledWith(expect.objectContaining({
      query: expect.objectContaining({ [filter]: id, status: "error" }),
    }));
    view.unmount();
  });

  it("loads the new filter while the previous request is pending and ignores its late response", async () => {
    let finishFirst!: (value: ReturnType<typeof overview>) => void;
    api.getOverview
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce(overview(202));
    const view = mount();
    await flush();
    view.state.period = "7d";
    await flush();
    expect(api.getOverview).toHaveBeenCalledTimes(2);
    finishFirst(overview(101));
    await flush();
    expect(view.state.overview.metrics.requestCount).toBe(202);
    view.unmount();
  });

  it("reloads rankings on sort change", async () => {
    const view = mount();
    await flush();
    view.state.handleRankingSortChange("failureCount");
    await flush();
    expect(api.getDimensionList).toHaveBeenCalledWith("model", expect.objectContaining({
      sortBy: "failureCount",
    }));
    expect(api.getDimensionList).toHaveBeenCalledWith("provider", expect.objectContaining({
      sortBy: "failureCount",
    }));
    view.unmount();
  });

  it("searches for a key beyond the first 100 options and makes it selectable", async () => {
    api.getDimensionList.mockImplementation((dimension, query) => Promise.resolve({
      items: dimension === "virtualKey" && query.search === "rare-key"
        ? [{ id: "rare-id", name: "rare-key", maskedKey: "***1234" }]
        : [],
      pagination: { total: 0 },
    }));
    const view = mount();
    await flush();
    view.state.handleFilterSearch("virtualKey", "rare-key");
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(api.getDimensionList).toHaveBeenCalledWith("virtualKey", expect.objectContaining({
      search: "rare-key", pageSize: 100,
    }));
    expect(view.state.keyOptions).toContainEqual({
      label: "rare-key (***1234)", value: "rare-id",
    });
    view.unmount();
  });
});
