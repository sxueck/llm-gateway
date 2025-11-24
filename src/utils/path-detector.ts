/**
 * Path and endpoint detection utilities
 * Centralizes all path-based logic to avoid hardcoded path checks scattered throughout the codebase
 */

/**
 * Supported API endpoint types
 */
export enum EndpointType {
  CHAT_COMPLETIONS = 'chat_completions',
  RESPONSES = 'responses',
  MESSAGES = 'messages',
  EMBEDDINGS = 'embeddings',
  AUDIO = 'audio',
  COMPLETIONS = 'completions',
  UNKNOWN = 'unknown'
}

/**
 * Detect the endpoint type from a given path
 * @param path - The request path (e.g., '/v1/chat/completions')
 * @returns The detected endpoint type
 */
export function detectEndpointType(path: string): EndpointType {
  const normalizedPath = path.toLowerCase();

  if (normalizedPath.includes('/chat/completions')) {
    return EndpointType.CHAT_COMPLETIONS;
  }
  if (normalizedPath.includes('/responses')) {
    return EndpointType.RESPONSES;
  }
  if (normalizedPath.includes('/messages')) {
    return EndpointType.MESSAGES;
  }
  if (normalizedPath.includes('/embeddings')) {
    return EndpointType.EMBEDDINGS;
  }
  if (normalizedPath.includes('/audio')) {
    return EndpointType.AUDIO;
  }
  if (normalizedPath.includes('/completions') && !normalizedPath.includes('/chat/')) {
    return EndpointType.COMPLETIONS;
  }

  return EndpointType.UNKNOWN;
}

/**
 * Check if the path is a chat completions endpoint
 */
export function isChatCompletionsPath(path: string): boolean {
  return detectEndpointType(path) === EndpointType.CHAT_COMPLETIONS;
}

/**
 * Check if the path is a responses API endpoint (OpenAI Realtime API format)
 */
export function isResponsesApiPath(path: string): boolean {
  return detectEndpointType(path) === EndpointType.RESPONSES;
}

/**
 * Check if the path is an Anthropic messages endpoint
 */
export function isMessagesPath(path: string): boolean {
  return detectEndpointType(path) === EndpointType.MESSAGES;
}

/**
 * Check if the path is an embeddings endpoint
 */
export function isEmbeddingsPath(path: string): boolean {
  return detectEndpointType(path) === EndpointType.EMBEDDINGS;
}

/**
 * Check if the path is an audio endpoint
 */
export function isAudioPath(path: string): boolean {
  return detectEndpointType(path) === EndpointType.AUDIO;
}

/**
 * Check if the path is a completions endpoint (non-chat)
 */
export function isCompletionsPath(path: string): boolean {
  return detectEndpointType(path) === EndpointType.COMPLETIONS;
}

/**
 * Check if the path starts with /v1/
 */
export function hasV1Prefix(path: string): boolean {
  return path.startsWith('/v1/');
}

/**
 * Check if the path has a duplicated /v1/v1/ prefix
 */
export function hasDuplicatedV1Prefix(path: string): boolean {
  return path.startsWith('/v1/v1/');
}

/**
 * Normalize the path by ensuring it has the /v1/ prefix and removing duplicates
 * @param path - The original path
 * @returns The normalized path
 */
export function normalizePath(path: string): string {
  let normalizedPath = path;

  // Remove duplicated /v1/v1/ prefix
  if (hasDuplicatedV1Prefix(normalizedPath)) {
    normalizedPath = normalizedPath.replace(/^\/v1\/v1\//, '/v1/');
  }

  // Ensure /v1/ prefix
  if (!hasV1Prefix(normalizedPath)) {
    normalizedPath = `/v1${normalizedPath}`;
  }

  return normalizedPath;
}

/**
 * Check if the endpoint supports message-based requests (chat, messages, responses)
 */
export function isMessageBasedEndpoint(path: string): boolean {
  const endpointType = detectEndpointType(path);
  return [
    EndpointType.CHAT_COMPLETIONS,
    EndpointType.RESPONSES,
    EndpointType.MESSAGES
  ].includes(endpointType);
}

/**
 * Check if the endpoint supports prompt processing
 * (Currently only chat completions supports prompt transformations)
 */
export function supportsPromptProcessing(path: string): boolean {
  return isChatCompletionsPath(path);
}

/**
 * Check if the endpoint requires input normalization
 * (Currently only embeddings and responses APIs)
 */
export function requiresInputNormalization(path: string): boolean {
  const endpointType = detectEndpointType(path);
  return [
    EndpointType.EMBEDDINGS,
    EndpointType.RESPONSES
  ].includes(endpointType);
}
