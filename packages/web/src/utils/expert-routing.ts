import {
  DEFAULT_SESSION_IDLE_TTL_SECONDS,
  DEFAULT_SESSION_ABSOLUTE_TTL_SECONDS,
} from "@llm-gateway/shared";
import type {
  SessionPolicy,
  CreateExpertRoutingRequest,
} from "@/api/expert-routing";

export function createDefaultSessionPolicy(): SessionPolicy {
  return {
    mode: "escalate_only",
    idle_ttl_seconds: DEFAULT_SESSION_IDLE_TTL_SECONDS,
    absolute_ttl_seconds: DEFAULT_SESSION_ABSOLUTE_TTL_SECONDS,
  };
}

export function createDefaultExpertRoutingConfig(): CreateExpertRoutingRequest {
  return {
    name: "",
    description: "",
    enabled: true,
    session_policy: createDefaultSessionPolicy(),
    preprocessing: {
      strip_tools: false,
      strip_files: false,
      strip_code_blocks: false,
      strip_system_prompt: false,
    },
    experts: [],
  };
}
