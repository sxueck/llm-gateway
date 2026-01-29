
export interface ChatMessage {
  role: string;
  content: string | any;
  tool_calls?: any[];
  [key: string]: any;
}

export interface ProxyRequest {
  body?: {
    messages?: ChatMessage[];
    input?: string | any[]; // Responses API
    instructions?: string; // Responses API
    model?: string;
    system?: string | any[];
    [key: string]: any;
  };
  protocol?: 'openai' | 'anthropic';
  [key: string]: any;
}

export interface ToolSignal {
  type: 'call' | 'result' | 'error';
  name?: string;
  content?: string;
  isError: boolean;
}

export interface HardHint {
  type: 'slash_command' | 'keyword';
  value: string;
  args?: string[];
}

export interface RoutingSignal {
  intentText: string;          // 核心意图文本（去噪后）
  historyHint?: string;        // 历史摘要
  toolSignals: ToolSignal[];   // 标准化的工具调用信号
  hardHints: HardHint[];       // Slash命令、特定关键词等
  originalRequest: ProxyRequest;
  stats?: {
    originalLength: number;
    cleanedLength: number;
    promptTokens: number;
    originalTokens?: number;
    cleanedTokens?: number;
    removedTokens?: number;
    removedTokensPct?: number;
    tokenizer?: string;
  };
}

export interface ToolPolicy {
  allowedTools?: string[]; // 白名单
  mode: 'read_only' | 'standard' | 'restricted';
}

export interface RouteDecision {
  category: string;
  confidence: number;
  source: 'llm';
  expertId?: string;
  toolPolicy?: ToolPolicy;
  isToolCall?: boolean;
  metadata?: Record<string, any>;
}
