import {
  DEFAULT_SESSION_IDLE_TTL_SECONDS,
  DEFAULT_SESSION_ABSOLUTE_TTL_SECONDS,
} from "@llm-gateway/shared";
import type {
  SessionBindingPolicy,
  CreateExpertRoutingRequest,
} from "@/api/expert-routing";
import { DEFAULT_CHOICE_THRESHOLD } from "@/api/expert-routing";

export { DEFAULT_CHOICE_THRESHOLD };

export function createDefaultSessionBindingPolicy(): SessionBindingPolicy {
  return {
    idle_ttl_seconds: DEFAULT_SESSION_IDLE_TTL_SECONDS,
    absolute_ttl_seconds: DEFAULT_SESSION_ABSOLUTE_TTL_SECONDS,
  };
}

export function createDefaultExpertRoutingConfig(): CreateExpertRoutingRequest {
  return {
    name: "",
    description: "",
    enabled: true,
    choice_threshold: DEFAULT_CHOICE_THRESHOLD,
    session_binding_policy: createDefaultSessionBindingPolicy(),
    preprocessing: {
      strip_tools: false,
      strip_files: false,
      strip_code_blocks: false,
      strip_system_prompt: false,
    },
    experts: [],
  };
}
