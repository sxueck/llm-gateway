import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock('@/utils/request', () => ({ default: state }));

import { isNodeOperationsMenuEnabled, nodesApi } from './nodes';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isNodeOperationsMenuEnabled', () => {
  it('enabled:true 时显示入口', async () => {
    state.get.mockResolvedValue({ enabled: true, nodeId: 'a', controlId: 'a', nodeIds: ['a'] });
    await expect(isNodeOperationsMenuEnabled()).resolves.toBe(true);
  });

  it('enabled:false 时隐藏入口', async () => {
    state.get.mockResolvedValue({ enabled: false, nodeId: 'a', controlId: 'a', nodeIds: [] });
    await expect(isNodeOperationsMenuEnabled()).resolves.toBe(false);
  });

  it('请求失败时隐藏入口（fail-closed）', async () => {
    state.get.mockRejectedValue(new Error('network down'));
    await expect(isNodeOperationsMenuEnabled()).resolves.toBe(false);
  });

  it('响应缺失或取值异常时隐藏入口', async () => {
    state.get.mockResolvedValueOnce(undefined);
    await expect(isNodeOperationsMenuEnabled()).resolves.toBe(false);
    state.get.mockResolvedValueOnce({ nodeId: 'a' });
    await expect(isNodeOperationsMenuEnabled()).resolves.toBe(false);
    state.get.mockResolvedValueOnce({ enabled: 'yes' });
    await expect(isNodeOperationsMenuEnabled()).resolves.toBe(false);
  });
});

describe('nodesApi', () => {
  it('GET /admin/nodes', async () => {
    state.get.mockResolvedValue({ enabled: false, nodeId: '', controlId: '', nodes: [], providers: [] });
    await nodesApi.getOverview();
    expect(state.get).toHaveBeenCalledWith('/admin/nodes');
  });

  it('POST /admin/nodes/:id/check 对节点 ID 编码', async () => {
    state.post.mockResolvedValue({
      nodeId: 'n/1', reachable: true, authenticated: true,
      latencyMs: 12, checkedAt: 1, errorCode: null,
    });
    await nodesApi.checkNode('n/1');
    expect(state.post).toHaveBeenCalledWith('/admin/nodes/n%2F1/check');
  });
});
