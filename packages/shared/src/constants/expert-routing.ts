// Expert Routing shared contracts: intent labels and route sources.
//
// The local ONNX classifier (`snival/intent-router-zh-setfit-v1`) emits 21
// intent labels. Only the `coding` (9) and `general_control` (3) domains are
// production-eligible for direct expert mapping. The `ops` (8) labels and
// `out_of_scope` must NOT be mapped directly — they trigger the LLM second
// pass. These constants are the single source of truth shared by backend and
// web so the UI/API/backend use exactly the same vocabulary.

export type IntentDomain = 'coding' | 'ops' | 'general_control' | 'out_of_scope';

export interface IntentLabelMeta {
  label: string;
  displayName: string;
  domain: IntentDomain;
}

const PAIR = (label: string, displayName: string, domain: IntentDomain): IntentLabelMeta => ({
  label,
  displayName,
  domain,
});

/**
 * All 21 model labels in canonical model order (matches labels.json).
 */
export const EXPERT_ROUTING_LABELS: readonly IntentLabelMeta[] = [
  // coding (9) — production eligible
  PAIR('code_authoring', 'Code Authoring', 'coding'),
  PAIR('code_modification', 'Code Modification', 'coding'),
  PAIR('code_repair', 'Code Repair', 'coding'),
  PAIR('code_review', 'Code Review', 'coding'),
  PAIR('code_explanation', 'Code Explanation', 'coding'),
  PAIR('test_generation', 'Test Generation', 'coding'),
  PAIR('code_search', 'Code Search', 'coding'),
  PAIR('architecture_consultation', 'Architecture Consultation', 'coding'),
  PAIR('dependency_management', 'Dependency Management', 'coding'),
  // ops (8) — NOT usable for production routing
  PAIR('deployment', 'Deployment', 'ops'),
  PAIR('infrastructure_provisioning', 'Infrastructure Provisioning', 'ops'),
  PAIR('monitoring_query', 'Monitoring Query', 'ops'),
  PAIR('incident_response', 'Incident Response', 'ops'),
  PAIR('pipeline_operation', 'Pipeline Operation', 'ops'),
  PAIR('config_change', 'Config Change', 'ops'),
  PAIR('security_operation', 'Security Operation', 'ops'),
  PAIR('log_analysis', 'Log Analysis', 'ops'),
  // general_control (3) — production eligible
  PAIR('context_specification', 'Context Specification', 'general_control'),
  PAIR('workflow_control', 'Workflow Control', 'general_control'),
  PAIR('general_inquiry', 'General Inquiry', 'general_control'),
  // fallback
  PAIR('out_of_scope', 'Out of Scope', 'out_of_scope'),
];

/**
 * The 12 production-eligible labels (coding + general_control) that may be
 * mapped directly to an expert. ops and out_of_scope MUST be rejected by both
 * API and UI.
 */
export const EXPERT_ROUTING_ELIGIBLE_LABELS: readonly IntentLabelMeta[] = EXPERT_ROUTING_LABELS.filter(
  (l) => l.domain === 'coding' || l.domain === 'general_control'
);

/**
 * Labels that must NEVER be mapped directly to an expert.
 */
export const EXPERT_ROUTING_INELIGIBLE_LABELS: readonly IntentLabelMeta[] = EXPERT_ROUTING_LABELS.filter(
  (l) => l.domain === 'ops' || l.domain === 'out_of_scope'
);

export function isEligibleExpertRoutingLabel(label: string): boolean {
  return EXPERT_ROUTING_ELIGIBLE_LABELS.some((l) => l.label === label);
}

export function getExpertRoutingLabelMeta(label: string): IntentLabelMeta | undefined {
  return EXPERT_ROUTING_LABELS.find((l) => l.label === label);
}

/**
 * Route sources recorded in expert_routing_logs and surfaced in statistics.
 * The API/UI MUST report these values without collapsing local ONNX and LLM
 * second-pass decisions into a single bucket.
 */
export const EXPERT_ROUTING_ROUTE_SOURCES = [
  'session',
  'local_onnx',
  'llm_second_pass',
  'fallback',
] as const;

export type ExpertRoutingRouteSource = (typeof EXPERT_ROUTING_ROUTE_SOURCES)[number];

/**
 * Reserved non-null scope stored for anonymous requests (no virtual key) in
 * expert_routing_session_bindings.virtual_key_scope. Using a non-null sentinel
 * avoids MySQL nullable unique-key semantics producing duplicate anonymous
 * bindings.
 */
export const EXPERT_ROUTING_ANONYMOUS_SCOPE = '__anonymous__';

/**
 * Pin metadata for the local ONNX classifier artifacts. Runtime downloads from
 * mutable `main` are prohibited; deployments must resolve exactly this revision.
 */
export const EXPERT_ROUTING_MODEL_REPO = 'snival/intent-router-zh-setfit-v1';
export const EXPERT_ROUTING_MODEL_REVISION = 'ce71b323aff00e2d591cf75cfa607c5478bf9154';
export const EXPERT_ROUTING_ONNX_FILE = 'encoder-woq8.onnx';

/** Default session-binding TTLs (NFR-4). */
export const DEFAULT_SESSION_IDLE_TTL_SECONDS = 86400; // 24h
export const DEFAULT_SESSION_ABSOLUTE_TTL_SECONDS = 2592000; // 30d
