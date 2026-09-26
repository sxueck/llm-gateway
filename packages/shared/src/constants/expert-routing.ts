// These labels are optional UI templates, not a restriction on Jev candidates.
export const EXPERT_ROUTING_ELIGIBLE_LABELS = [
  { label: "code_authoring", displayName: "Code Authoring" },
  { label: "code_modification", displayName: "Code Modification" },
  { label: "code_repair", displayName: "Code Repair" },
  { label: "code_review", displayName: "Code Review" },
  { label: "code_explanation", displayName: "Code Explanation" },
  { label: "test_generation", displayName: "Test Generation" },
  { label: "code_search", displayName: "Code Search" },
  { label: "architecture_consultation", displayName: "Architecture Consultation" },
  { label: "dependency_management", displayName: "Dependency Management" },
  { label: "context_specification", displayName: "Context Specification" },
  { label: "workflow_control", displayName: "Workflow Control" },
  { label: "general_inquiry", displayName: "General Inquiry" },
] as const;

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
