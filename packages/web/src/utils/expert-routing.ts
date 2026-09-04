import {
  DEFAULT_SESSION_IDLE_TTL_SECONDS,
  DEFAULT_SESSION_ABSOLUTE_TTL_SECONDS,
} from "@llm-gateway/shared";
import type {
  LlmSecondPassConfig,
  SessionBindingPolicy,
  CreateExpertRoutingRequest,
} from "@/api/expert-routing";

export function createDefaultLlmSecondPassConfig(): LlmSecondPassConfig {
  return {
    type: "real",
    max_tokens: 200,
    temperature: 0,
    timeout: 10000,
    ignore_system_messages: false,
    max_messages_to_classify: 0,
    enable_structured_output: true,
    enable_adaptive_thinking: false,
  };
}

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
    llm_second_pass: createDefaultLlmSecondPassConfig(),
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
