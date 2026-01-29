export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export type AnthropicThinkingConfig =
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'disabled' };

export interface AnthropicContentBlock {
  type:
    | 'text'
    | 'image'
    | 'document'
    | 'search_result'
    | 'tool_use'
    | 'tool_result'
    | 'server_tool_use'
    | 'web_search_tool_result'
    | 'web_fetch_tool_result'
    | 'thinking'
    | 'redacted_thinking'
    | 'mcp_tool_use'
    | 'mcp_tool_result';
  text?: string;
  thinking?: string;
  signature?: string;
  // For redacted thinking blocks
  data?: string;
  // Common block metadata used by document/search_result blocks
  title?: string | null;
  citations?: any;
  context?: string | null;
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
  service_tier?: 'auto' | 'standard_only' | (string & {});
  metadata?: {
    user_id?: string;
  };
  tools?: AnthropicTool[];
  tool_choice?: {
    type: 'auto' | 'any' | 'tool' | 'none';
    name?: string;
    disable_parallel_tool_use?: boolean;
  };
  /**
   * Beta feature flags. When present, will be forwarded as `anthropic-beta`.
   *
   * Note: behavior is provider-dependent for Anthropic-compatible APIs.
   */
  betas?: string[];
  thinking?: AnthropicThinkingConfig;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  cache_control?: {
    type: 'ephemeral';
  };
  // Keep compatibility with server-tools / provider-specific extensions
  type?: string | null;
  [key: string]: any;
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
  stop_reason:
    | 'end_turn'
    | 'max_tokens'
    | 'stop_sequence'
    | 'tool_use'
    | 'pause_turn'
    | 'refusal'
    | 'model_context_window_exceeded'
    | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

export interface AnthropicStreamEvent {
  type: 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop' | 'ping' | 'error';
  message?: Partial<AnthropicResponse>;
  index?: number;
  content_block?: AnthropicContentBlock;
  delta?: {
    type: 'text_delta' | 'input_json_delta' | 'thinking_delta' | 'signature_delta' | 'citations_delta';
    text?: string;
    partial_json?: string;
    thinking?: string;
    signature?: string;
    citation?: any;
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
