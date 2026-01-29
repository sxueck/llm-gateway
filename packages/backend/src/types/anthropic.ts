export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export type AnthropicThinkingConfig =
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'disabled' };

export interface AnthropicContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result' | 'thinking' | 'redacted_thinking';
  text?: string;
  thinking?: string;
  signature?: string;
  // For redacted thinking blocks
  data?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
  id?: string;
  name?: string;
  input?: any;
  tool_use_id?: string;
  content?: string | any[];
  cache_control?: {
    type: 'ephemeral';
  };
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string | AnthropicContentBlock[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  metadata?: {
    user_id?: string;
  };
  tools?: AnthropicTool[];
  tool_choice?: {
    type: 'auto' | 'any' | 'tool';
    name?: string;
  };
  thinking?: AnthropicThinkingConfig;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  cache_control?: {
    type: 'ephemeral';
  };
}
 
export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  service_tier?: string;
}
 
export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
  stop_sequence?: string | null;
  usage: AnthropicUsage;
}

export interface AnthropicStreamEvent {
  type: 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop' | 'ping' | 'error';
  message?: Partial<AnthropicResponse>;
  index?: number;
  content_block?: AnthropicContentBlock;
  delta?: {
    type: 'text_delta' | 'input_json_delta' | 'thinking_delta' | 'signature_delta';
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
    stop_reason?: string;
    stop_sequence?: string;
  };
  usage?: Partial<AnthropicUsage>;
  error?: {
    type: string;
    message: string;
  };
}

export interface AnthropicError {
  type: 'error';
  error: {
    type: 'invalid_request_error' | 'authentication_error' | 'permission_error' | 'not_found_error' | 'rate_limit_error' | 'api_error' | 'overloaded_error';
    message: string;
  };
}
