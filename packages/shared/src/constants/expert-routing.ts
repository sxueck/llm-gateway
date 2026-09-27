// Historical sources remain for existing log rows and statistics.
export const EXPERT_ROUTING_ROUTE_SOURCES = [
  "session",
  "jev",
  "intent_api",
  "llm_second_pass",
  "fallback",
] as const;

export type ExpertRoutingRouteSource = (typeof EXPERT_ROUTING_ROUTE_SOURCES)[number];

export const EXPERT_ROUTING_ANONYMOUS_SCOPE = "__anonymous__";
export const DEFAULT_SESSION_IDLE_TTL_SECONDS = 86400;
export const DEFAULT_SESSION_ABSOLUTE_TTL_SECONDS = 2592000;
