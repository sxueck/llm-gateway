import { AsyncLocalStorage } from 'node:async_hooks';

export interface NodeAuditContext {
  requestId: string;
  ingressNode: string;
  executionNode: string;
}

export const nodeAuditContext = new AsyncLocalStorage<NodeAuditContext>();
