import { z } from 'zod';

export interface NodeInfo {
  id: string;
  origin: string | null;
  local: boolean;
  control: boolean;
}

export interface NodeProviderInfo {
  id: string;
  name: string;
  ownerNode: string;
  enabled: boolean;
  configured: boolean;
}

export interface NodesOverview {
  enabled: boolean;
  nodeId: string;
  controlId: string;
  nodes: NodeInfo[];
  providers: NodeProviderInfo[];
}

export interface NodeCheckResult {
  nodeId: string;
  reachable: boolean | null;
  authenticated: boolean | null;
  latencyMs: number;
  checkedAt: number;
  errorCode: string | null;
}

export const nodeHealthSchema = z.object({
  enabled: z.literal(true),
  nodeId: z.string(),
  controlId: z.string(),
}).strict();
