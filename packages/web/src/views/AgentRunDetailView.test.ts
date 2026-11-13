import { createRenderer, createSSRApp, defineComponent, h, nextTick, ssrContextKey } from "vue";
import { renderToString } from "@vue/server-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAgentRunDetail, streamSSE, push, authStore } = vi.hoisted(() => ({
  getAgentRunDetail: vi.fn(),
  streamSSE: vi.fn(),
  push: vi.fn(),
  authStore: { token: null as string | null },
}));

vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { id: "run-1" } }),
  useRouter: () => ({ push }),
}));
vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));
vi.mock("@/stores/auth", () => ({ useAuthStore: () => authStore }));
vi.mock("@/utils/sse", () => ({ streamSSE }));
vi.mock("@/api/config", () => ({ configApi: { getAgentRunDetail } }));
vi.mock("@/api/api-request", () => ({
  apiRequestApi: { getAll: vi.fn().mockResolvedValue({ data: [], total: 0 }) },
}));
vi.mock("@/components/PageHeader.vue", () => ({
  default: defineComponent({
    inheritAttrs: false,
    setup(_, { slots }) {
      return () => h("page-header", null, slots);
    },
  }),
}));

vi.mock("naive-ui", () => {
  const stub = defineComponent({
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => h("n-stub", attrs, slots.default?.());
    },
  });
  return {
    useMessage: () => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn(), success: vi.fn() }),
    NAlert: stub, NButton: stub, NCard: stub, NDataTable: stub,
    NDescriptions: stub, NDescriptionsItem: stub, NEmpty: stub, NIcon: stub,
    NTag: stub, NTimeline: stub, NTimelineItem: stub,
  };
});

import AgentRunDetailView from "./AgentRunDetailView.vue";
import AgentRunEventTrace from "./AgentRunEventTrace.vue";
import type { AgentRunDetailResponse, AgentRunEvent } from "@/api/config";

const events = (
  list: Array<{ seq: number; type: string; payload?: Record<string, unknown> }>,
): AgentRunEvent[] =>
  list.map((e, i) => ({
    seq: e.seq,
    type: e.type,
    payload: e.payload ?? { index: i },
    created_at: 1_700_000_000_500 + e.seq,
  }));

const detail = (status: string, evts: AgentRunEvent[]): AgentRunDetailResponse => ({
  run: {
    id: "run-1",
    user_id: 1,
    virtual_key_id: 1,
    plugin: { id: "demo", version: "1.0.0", digest: "abc123" },
    source: { type: "snapshot", snapshot_id: "s-1", requested_ref: null, commit: null },
    model_profile: "default",
    status: status as never,
    created_at: 1_700_000_000_000,
    started_at: 1_700_000_001_000,
    completed_at: status === "running" ? null : 1_700_000_010_000,
    expires_at: 1_700_000_900_000,
    cancellation_requested_at: null,
    duration_ms: 9_000,
    error: null,
    usage: {
      turn_count: 1, tool_call_count: 1, input_tokens: 10, output_tokens: 20, cost: 0.001,
    },
  },
  events: evts,
  events_truncated: false,
});

async function renderTrace(evts: AgentRunEvent[]): Promise<string> {
  const app = createSSRApp({ render: () => h(AgentRunEventTrace, { events: evts }) });
  return renderToString(app);
}

describe("AgentRunEventTrace (shadcn-vue trace)", () => {
  it("renders every event with the right badge variant/semantic class and summary", async () => {
    const html = await renderTrace(events([
      { seq: 1, type: "run.queued", payload: { plugin: "demo@1.0.0" } },
      { seq: 2, type: "run.started" },
      { seq: 3, type: "tool.started" },
      { seq: 4, type: "model.completed", payload: { turn: 1, prompt_tokens: 10, completion_tokens: 20 } },
      { seq: 5, type: "run.failed", payload: { code: "boom" } },
    ]));

    // all 5 events present, in order, with seq markers
    expect(html.match(/data-slot="trace"/g)).toHaveLength(5);
    expect(html.match(/data-slot="trace-line"/g)).toHaveLength(5);
    expect(html).toContain("#1");
    expect(html).toContain("#5");
    expect(html.indexOf("#3")).toBeLessThan(html.indexOf("#4"));
    // shadcn badges rendered with semantic tailwind classes
    expect(html).toContain("bg-[var(--color-info)]");
    expect(html).toContain("bg-[var(--color-warning)]");
    expect(html).toContain("bg-[var(--color-success)]");
    expect(html).toContain("bg-destructive");
    // summaries preserved
    expect(html).toContain("demo@1.0.0");
    expect(html).toContain("turn 1 · ↑10 ↓20");
    expect(html).toContain("code: boom");
    // payload trigger labelled via i18n, one per event
    expect(html.match(/agentRunDetail\.payload/g)).toHaveLength(5);
  });

  it("keeps payload JSON collapsed until the collapsible is open", async () => {
    const evts = events([{ seq: 1, type: "run.queued", payload: { secret: "payload-body" } }]);

    // SSR render: payload hidden by default
    const closed = await renderToString(createSSRApp({
      render: () => h(AgentRunEventTrace, { events: evts }),
    }));
    expect(closed).toContain("agentRunDetail.payload");
    expect(closed).not.toContain("payload-body");
    expect(closed).not.toContain("event-payload-json");

    // opening the collapsible reveals the JSON payload
    const open = await renderToString(createSSRApp({
      render: () => h(AgentRunEventTrace, { events: evts, defaultOpen: true }),
    }));
    expect(open).toContain("event-payload-json");
    expect(open).toContain("payload-body");
  });
});

// --- view live behavior with a lightweight custom renderer (no DOM env) ---

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

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await nextTick();
}

function mountView() {
  const root = node("root");
  AgentRunDetailView.render = () => null;
  const app = renderer.createApp(AgentRunDetailView);
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(root);
  const state = (app as any)._instance.setupState;
  return { state, unmount: () => app.unmount() };
}

beforeEach(() => {
  vi.clearAllMocks();
  authStore.token = "token-1";
  streamSSE.mockReturnValue(new Promise(() => {}));
});

describe("AgentRunDetailView live trace behavior", () => {
  it("subscribes to SSE with lastEventId from the max loaded seq", async () => {
    getAgentRunDetail.mockResolvedValue(detail("running", events([
      { seq: 1, type: "run.queued" },
      { seq: 7, type: "run.started" },
    ])));
    const view = mountView();
    await flush();

    expect(streamSSE).toHaveBeenCalledTimes(1);
    expect(streamSSE).toHaveBeenCalledWith(
      "/api/admin/agent-runs/run-1/events",
      expect.objectContaining({ token: "token-1", lastEventId: "7" }),
    );
    view.unmount();
  });

  it("merges SSE frames, dedupes by seq, keeps sorted, and reloads on terminal event", async () => {
    getAgentRunDetail.mockResolvedValue(detail("running", events([
      { seq: 1, type: "run.queued" },
      { seq: 7, type: "run.started" },
    ])));
    const view = mountView();
    await flush();

    const onEvent = streamSSE.mock.calls[0][1].onEvent as (frame: { data: string }) => void;

    onEvent({ data: JSON.stringify({ seq: 4, type: "tool.started", payload: {}, created_at: 1 }) });
    onEvent({ data: JSON.stringify({ seq: 7, type: "run.started", payload: {}, created_at: 1 }) }); // dup
    onEvent({ data: "not-json" }); // 坏帧忽略
    expect(view.state.detail.events.map((e: { seq: number }) => e.seq)).toEqual([1, 4, 7]);

    getAgentRunDetail.mockClear();
    getAgentRunDetail.mockResolvedValue(detail("completed", events([
      { seq: 1, type: "run.queued" },
    ])));
    onEvent({ data: JSON.stringify({ seq: 8, type: "run.completed", payload: {}, created_at: 2 }) });
    await flush();
    expect(getAgentRunDetail).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it("falls back to 5s polling when the SSE stream fails", async () => {
    vi.useFakeTimers();
    try {
      getAgentRunDetail.mockResolvedValue(detail("running", events([
        { seq: 1, type: "run.queued" },
      ])));
      streamSSE.mockImplementation((_url: string, _opts: unknown) =>
        Promise.reject(new Error("stream down")));

      const view = mountView();
      await flush();
      expect(getAgentRunDetail).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5000);
      await flush();
      expect(getAgentRunDetail).toHaveBeenCalledTimes(2);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });
});
