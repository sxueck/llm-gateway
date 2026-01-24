# Tool Calling Protocols (OpenAI Chat / OpenAI Responses / Claude)

This doc captures the concrete request/response shapes for tool calling across the three protocols we support.

Goal: implement per-protocol adapters that translate between wire formats and a shared internal representation.

## 0) Internal Adapter Contract (recommended)

Define a protocol-agnostic shape in the gateway, then implement:

- `parseModelToolCalls(rawModelResponse) -> ToolCall[]`
- `buildToolResultMessages(toolCalls, toolOutputs) -> ProtocolSpecificContinuation`

Suggested internal types:

```ts
export type ToolCall = {
  id: string; // tool_call_id | call_id | tool_use_id
  name: string;
  // For OpenAI Chat/Responses: arguments is a JSON string.
  // For Claude: input is already an object.
  argumentsJson?: string;
  input?: Record<string, any>;
};

export type ToolOutput = {
  id: string; // must match ToolCall.id
  outputText: string; // typically JSON.stringify(result)
  isError?: boolean;
};
```

Key differences to handle per adapter:

- ID field: Chat uses `tool_call_id`, Responses uses `call_id`, Claude uses `tool_use_id`.
- Args format: Chat/Responses use JSON-encoded string; Claude uses structured object.
- Continuation format: Chat uses `role: "tool"` messages; Responses uses `function_call_output` items; Claude uses `tool_result` blocks.

---

## 1) OpenAI Chat Completions (`/v1/chat/completions`)

### Request (gateway -> model)

- `messages[]`: `{ role: "system"|"user"|"assistant"|"tool", content: string|... }`
- `tools[]`: `[{ type: "function", function: { name, description, parameters, strict? } }]`
- `tool_choice`: `"auto"` or forced `{ type: "function", function: { name } }`

### Model tool call (model -> gateway)

- `choices[0].finish_reason === "tool_calls"`
- `choices[0].message.tool_calls[]`:

```json
{
  "id": "call_xxx",
  "type": "function",
  "function": {
    "name": "get_weather",
    "arguments": "{\"location\":\"Paris\"}"
  }
}
```

Adapter notes:

- Map `tool_calls[i].id` -> `ToolCall.id`.
- Map `tool_calls[i].function.name` -> `ToolCall.name`.
- Map `tool_calls[i].function.arguments` -> `ToolCall.argumentsJson`.

### Send tool result back (gateway -> model)

Append tool messages to the next `messages` request:

```json
{
  "role": "tool",
  "tool_call_id": "call_xxx",
  "content": "{\"temperature\":25}"
}
```

---

## 2) OpenAI Responses API (`/v1/responses`)

### Request (gateway -> model)

- `input`: can be text or a message array. Commonly:

```json
{
  "model": "gpt-5",
  "tools": [
    {
      "type": "function",
      "name": "get_weather",
      "description": "Get current weather",
      "parameters": {
        "type": "object",
        "properties": { "location": { "type": "string" } },
        "required": ["location"]
      }
    }
  ],
  "input": [{ "role": "user", "content": "Weather in Paris?" }]
}
```

### Model tool call (model -> gateway)

Tool calls arrive as items in `response.output[]` with `type: "function_call"`:

```json
{
  "type": "function_call",
  "call_id": "call_123",
  "name": "get_weather",
  "arguments": "{\"location\":\"Paris\"}"
}
```

Adapter notes:

- Map `call_id` -> `ToolCall.id`.
- Map `name` -> `ToolCall.name`.
- Map `arguments` -> `ToolCall.argumentsJson`.

### Send tool result back (gateway -> model)

Responses uses item continuation: add the prior `response.output` to the running `input`, then append a `function_call_output`:

```json
{
  "type": "function_call_output",
  "call_id": "call_123",
  "output": "{\"temperature\":25}"
}
```

Important:

- For reasoning models, if the response contains reasoning items alongside tool calls, those items must be passed back as part of the running input when submitting tool outputs.

---

## 3) Anthropic Claude Messages API (`/v1/messages`)

### Request (gateway -> model)

- `tools[]`: Claude tool schema uses `input_schema`:

```json
{
  "name": "get_weather",
  "description": "Get the current weather in a given location",
  "input_schema": {
    "type": "object",
    "properties": {
      "location": { "type": "string", "description": "City, e.g. Paris" }
    },
    "required": ["location"]
  }
}
```

- `messages[]`: `role: "user"|"assistant"`, `content` is typically an array of blocks.

### Model tool call (model -> gateway)

Claude returns tool use as a content block and sets `stop_reason: "tool_use"`:

```json
{
  "type": "tool_use",
  "id": "toolu_abc",
  "name": "get_weather",
  "input": { "location": "Paris" }
}
```

Adapter notes:

- Map `tool_use.id` -> `ToolCall.id`.
- Map `tool_use.name` -> `ToolCall.name`.
- Map `tool_use.input` -> `ToolCall.input`.

### Send tool result back (gateway -> model)

You must append the assistant's tool_use blocks to history, then send a user message containing tool_result blocks:

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_abc",
      "content": "{\"temperature\":25}"
    }
  ]
}
```

---

## 4) Practical Guidance for "Per-Protocol" Adapters

- Parsing should be strict:
  - Chat: accept `finish_reason === "tool_calls"` + `message.tool_calls`.
  - Responses: scan `response.output[]` for `type === "function_call"`.
  - Claude: scan `content[]` for `type === "tool_use"` and `stop_reason === "tool_use"`.

- Result formatting:
  - Keep `outputText` as a string (usually `JSON.stringify(result)`), even if the tool returns structured data.
  - Always preserve the model-provided call id and attach it back exactly.

- Conversation continuity:
  - Chat: append tool result messages to `messages`.
  - Responses: maintain a running `input` list; include prior output items (and reasoning items if present) when you submit tool outputs.
  - Claude: preserve the assistant content blocks; tool_result is a new user content block referencing `tool_use_id`.
