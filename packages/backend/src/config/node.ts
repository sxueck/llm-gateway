import { isPrivateNodeOrigin } from '../utils/node-origin.js';

export interface NodeConfig {
  enabled: boolean;
  id: string;
  controlId: string;
  peers: Record<string, string>;
  secret: string;
}

/** 节点 ID 与 peer ID 共用格式：小写字母开头，小写字母/数字/连字符，最长 32。 */
const NODE_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

const DEFAULT_DISABLED_NODE: NodeConfig = {
  enabled: false,
  id: "local",
  controlId: "local",
  peers: {},
  secret: "",
};

function isNodeIdValid(id: string): boolean {
  return NODE_ID_PATTERN.test(id);
}

/** 校验 peer origin：仅 http(s) origin，无 userinfo/query/hash/路径。 */
function validatePeerOrigin(peerId: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      `GATEWAY_NODE_PEERS 中 peer '${peerId}' 的 URL 无效`,
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `GATEWAY_NODE_PEERS 中 peer '${peerId}' 的 URL 必须是 http(s) 协议`,
    );
  }
  if (url.username || url.password) {
    throw new Error(
      `GATEWAY_NODE_PEERS 中 peer '${peerId}' 的 URL 不允许包含 userinfo`,
    );
  }
  if (url.search) {
    throw new Error(
      `GATEWAY_NODE_PEERS 中 peer '${peerId}' 的 URL 不允许包含 query`,
    );
  }
  if (url.hash) {
    throw new Error(
      `GATEWAY_NODE_PEERS 中 peer '${peerId}' 的 URL 不允许包含 hash`,
    );
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(
      `GATEWAY_NODE_PEERS 中 peer '${peerId}' 的 URL 只允许 origin（path 仅可为 '/'）`,
    );
  }

  if (!isPrivateNodeOrigin(url.origin)) {
    throw new Error(`GATEWAY_NODE_PEERS peer '${peerId}' requires HTTPS or a private tunnel IP`);
  }
  return url.origin;
}

function parsePeers(raw: string, localId: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("GATEWAY_NODE_PEERS 必须是合法的 JSON 对象");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("GATEWAY_NODE_PEERS 必须是 JSON 对象（peer ID => origin URL）");
  }

  const peers: Record<string, string> = {};
  for (const [peerId, origin] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (!isNodeIdValid(peerId)) {
      throw new Error(
        `GATEWAY_NODE_PEERS 中的 peer ID '${peerId}' 不符合格式 ${NODE_ID_PATTERN}`,
      );
    }
    if (peerId === localId) {
      throw new Error(
        `GATEWAY_NODE_PEERS 不允许包含与本节点相同的 peer ID: ${peerId}`,
      );
    }
    if (typeof origin !== "string" || !origin.trim()) {
      throw new Error(`GATEWAY_NODE_PEERS 中 peer '${peerId}' 的 URL 必须是非空字符串`);
    }
    peers[peerId] = validatePeerOrigin(peerId, origin.trim());
  }
  return peers;
}

export function listExecutableNodeIds(config: NodeConfig): string[] {
  if (!config.enabled) return [];
  return [config.id, ...Object.keys(config.peers)];
}

/**
 * 校验供应商归属节点是否可执行。只校格式不够：未知节点不会报错，而是让该
 * 供应商的全部流量永久 503 owner_node_unconfigured（故障不接管是设计行为）。
 */
export function nodeOwnerError(ownerNode: string, config: NodeConfig): string | null {
  if (!config.enabled) {
    return `多节点模式未启用，无法将供应商归属设为 '${ownerNode}'：请先配置 GATEWAY_NODE_*，或留空使用默认控制节点`;
  }
  if (ownerNode === config.id || Object.hasOwn(config.peers, ownerNode)) return null;
  return `未知 owner 节点 '${ownerNode}'：可用值为 ${listExecutableNodeIds(config).join(", ")}，留空表示默认控制节点 ${config.controlId}`;
}

export function parseNodeConfig(env: NodeJS.ProcessEnv): NodeConfig {
  const id = env.GATEWAY_NODE_ID?.trim() ?? "";
  const controlIdRaw = env.GATEWAY_CONTROL_NODE_ID?.trim() ?? "";
  const secret = env.GATEWAY_NODE_SECRET ?? "";
  const peersRaw = env.GATEWAY_NODE_PEERS?.trim() ?? "";
  const hasPartialConfig =
    controlIdRaw !== "" || secret !== "" || peersRaw !== "";

  // GATEWAY_NODE_ID 缺失：默认禁用；但若存在其他 GATEWAY_NODE_* 变量则为
  // 残缺配置，直接失败（避免半启用状态下静默以单节点模式运行）。
  if (id === "") {
    if (hasPartialConfig) {
      throw new Error(
        "节点配置不完整: 检测到 GATEWAY_CONTROL_NODE_ID/GATEWAY_NODE_SECRET/GATEWAY_NODE_PEERS 但缺少 GATEWAY_NODE_ID；请补全 GATEWAY_NODE_ID 或移除其余 GATEWAY_NODE_* 变量",
      );
    }
    return { ...DEFAULT_DISABLED_NODE, peers: {} };
  }

  if (!isNodeIdValid(id)) {
    throw new Error(
      `GATEWAY_NODE_ID '${id}' 不符合格式 ${NODE_ID_PATTERN}（小写字母开头，仅小写字母/数字/连字符，最长 32）`,
    );
  }

  // 启用时三项均需显式提供
  if (controlIdRaw === "") {
    throw new Error("多节点模式启用时必须显式设置 GATEWAY_CONTROL_NODE_ID");
  }
  if (!isNodeIdValid(controlIdRaw)) {
    throw new Error(
      `GATEWAY_CONTROL_NODE_ID '${controlIdRaw}' 不符合格式 ${NODE_ID_PATTERN}`,
    );
  }
  if (secret.length < 32) {
    throw new Error(
      `GATEWAY_NODE_SECRET 长度不足: 需要 >= 32 字符，当前 ${secret.length}`,
    );
  }
  if (peersRaw === "") {
    throw new Error("多节点模式启用时必须显式设置 GATEWAY_NODE_PEERS（JSON 对象，可为 {}）");
  }

  const peers = parsePeers(peersRaw, id);

  // 控制 ID 必须指向本节点或已配置的 peer
  if (controlIdRaw !== id && !Object.hasOwn(peers, controlIdRaw)) {
    throw new Error(
      `GATEWAY_CONTROL_NODE_ID '${controlIdRaw}' 既不是本节点 ID ('${id}') 也不是 GATEWAY_NODE_PEERS 中已配置的 peer`,
    );
  }

  return {
    enabled: true,
    id,
    controlId: controlIdRaw,
    peers,
    secret,
  };
}
