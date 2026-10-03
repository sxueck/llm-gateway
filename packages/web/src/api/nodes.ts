import request from '@/utils/request';

import type { NodeCheckResult, NodesOverview } from '@llm-gateway/shared';
export type { NodeInfo, NodeProviderInfo, NodesOverview, NodeCheckResult } from '@llm-gateway/shared';

export const nodesApi = {
  getOverview(): Promise<NodesOverview> {
    return request.get('/admin/nodes');
  },

  checkNode(nodeId: string): Promise<NodeCheckResult> {
    return request.post(`/admin/nodes/${encodeURIComponent(nodeId)}/check`);
  },
};

// 侧边栏"节点运维"入口的可见性：只有 /admin/providers/node-options 明确返回 enabled:true
// 才显示；请求失败、字段缺失、其他取值一律隐藏（fail-closed）。
export async function isNodeOperationsMenuEnabled(): Promise<boolean> {
  try {
    const options = await request.get<{ enabled?: unknown }>(
      '/admin/providers/node-options'
    );
    return options?.enabled === true;
  } catch {
    return false;
  }
}
