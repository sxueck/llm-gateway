import { createRenderer, defineComponent, h, nextTick, ssrContextKey } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { api } = vi.hoisted(() => ({
  api: { getOverview: vi.fn(), checkNode: vi.fn() },
}));

vi.mock('@/api/nodes', () => ({
  nodesApi: api,
  isNodeOperationsMenuEnabled: vi.fn(),
}));
vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key }),
}));
vi.mock('naive-ui', () => {
  const stub = defineComponent({
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => h('stub', attrs, slots.default?.());
    },
  });
  return {
    NAlert: stub, NButton: stub, NCard: stub, NDataTable: stub,
    NDescriptions: stub, NDescriptionsItem: stub, NEmpty: stub,
    NSpace: stub, NSkeleton: stub, NTag: stub, NText: stub,
  };
});

import NodeOperationsView from './NodeOperationsView.vue';

type TestNode = { type: string; props: Record<string, any>; children: TestNode[]; parent?: TestNode; text?: string };

function node(type: string, text?: string): TestNode {
  return { type, props: {}, children: [], text };
}

const renderer = createRenderer<TestNode, TestNode>({
  createElement: (type) => node(type),
  createText: (text) => node('text', text),
  createComment: () => node('comment'),
  setElementText: (el, text) => { el.children = []; el.text = text; },
  setText: (el, text) => { el.text = text; },
  patchProp: (el, key, _p, next) => { el.props[key] = next; },
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
  nextSibling: (el) => (el.parent ? el.parent.children[el.parent.children.indexOf(el) + 1] ?? null : null),
});

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await nextTick();
}

function mount() {
  const root = node('root');
  NodeOperationsView.render = () => null;
  const app = renderer.createApp(NodeOperationsView);
  app.provide(ssrContextKey, { modules: new Set() });
  app.mount(root);
  const state = (app as any)._instance.setupState;
  return { state, unmount: () => app.unmount() };
}

const enabledOverview = {
  enabled: true,
  nodeId: 'node-a',
  controlId: 'node-c',
  nodes: [
    { id: 'node-a', origin: null, local: true, control: false },
    { id: 'node-b', origin: 'https://node-b.example', local: false, control: false },
    { id: 'node-c', origin: 'https://node-c.example', local: false, control: true },
  ],
  providers: [
    { id: 'p1', name: 'OpenAI', ownerNode: 'node-b', enabled: true, configured: true },
    { id: 'p2', name: 'Legacy', ownerNode: 'node-c', enabled: true, configured: false },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('NodeOperationsView', () => {
  it('加载失败时显示错误态且不渲染表格', async () => {
    api.getOverview.mockRejectedValue(new Error('boom'));
    const { state } = mount();
    await flush();
    expect(state.loadError).toBe(true);
    expect(state.nodeRows).toHaveLength(0);
  });

  it('单节点模式：显示禁用态且无法探测', async () => {
    api.getOverview.mockResolvedValue({
      enabled: false, nodeId: '', controlId: '', nodes: [], providers: [],
    });
    const { state } = mount();
    await flush();
    expect(state.overview.enabled).toBe(false);
    // 禁用态下 checkNode 直接短路，不会触发请求。
    await state.checkNode('any');
    expect(api.checkNode).not.toHaveBeenCalled();
  });

  it('多节点模式：渲染节点与提供商数据', async () => {
    api.getOverview.mockResolvedValue(enabledOverview);
    const { state } = mount();
    await flush();
    expect(state.nodeRows.map((r: any) => r.id)).toEqual(['node-a', 'node-b', 'node-c']);
    expect(state.unconfiguredProviders).toEqual(['Legacy']);
  });

  it('手动检测远端节点后写入结果，且不会轮询', async () => {
    api.getOverview.mockResolvedValue(enabledOverview);
    api.checkNode.mockResolvedValue({
      nodeId: 'node-b', reachable: true, authenticated: true,
      latencyMs: 42, checkedAt: 1_700_000_000_000, errorCode: null,
    });
    const { state } = mount();
    await flush();
    expect(api.checkNode).not.toHaveBeenCalled();
    await state.checkNode('node-b');
    await flush();
    expect(api.checkNode).toHaveBeenCalledTimes(1);
    expect(state.checkResults['node-b'].latencyMs).toBe(42);
    expect(state.checkingNode).toBe(null);
  });

  it('检测抛错时清除旧成功结果并展示错误', async () => {
    api.getOverview.mockResolvedValue(enabledOverview);
    api.checkNode.mockRejectedValue(new Error('timeout'));
    const { state } = mount();
    await flush();
    state.checkResults = { 'node-c': { reachable: true, authenticated: true } };
    await state.checkNode('node-c');
    await flush();
    expect(state.checkError).toBe('node-c');
    expect(state.checkResults['node-c']).toBeUndefined();
    expect(state.checkingNode).toBe(null);
  });

  it('刷新会清空既有检测结果', async () => {
    api.getOverview.mockResolvedValue(enabledOverview);
    api.checkNode.mockResolvedValue({
      nodeId: 'node-b', reachable: null, authenticated: null,
      latencyMs: 0, checkedAt: 1, errorCode: 'ETIMEDOUT',
    });
    const { state } = mount();
    await flush();
    await state.checkNode('node-b');
    await flush();
    expect(Object.keys(state.checkResults)).toEqual(['node-b']);
    await state.refresh();
    await flush();
    expect(state.checkResults).toEqual({});
  });
});
