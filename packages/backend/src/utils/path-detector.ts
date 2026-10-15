/**
 * Path and endpoint detection utilities
 * Centralizes all path-based logic to avoid hardcoded path checks scattered throughout the codebase
 */

export enum EndpointType {
  CHAT_COMPLETIONS = 'chat_completions',
  RESPONSES = 'responses',
  MESSAGES = 'messages',
  EMBEDDINGS = 'embeddings',
  AUDIO = 'audio',
  COMPLETIONS = 'completions',
  IMAGES = 'images',
  UNKNOWN = 'unknown'
}

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
  if (normalizedPath.includes('/images')) {
    return EndpointType.IMAGES;
  }
  if (normalizedPath.includes('/completions') && !normalizedPath.includes('/chat/')) {
    return EndpointType.COMPLETIONS;
  }

  return EndpointType.UNKNOWN;
}

export function isChatCompletionsPath(path: string): boolean {
  return detectEndpointType(path) === EndpointType.CHAT_COMPLETIONS;
}

export function isResponsesApiPath(path: string): boolean {
  return detectEndpointType(path) === EndpointType.RESPONSES;
}

export function isResponsesCompactPath(path: string): boolean {
  return path.toLowerCase().includes('/responses/compact');
}

export function shouldBypassGatewayCache(path: string): boolean {
  return isEmbeddingsPath(path) || isResponsesCompactPath(path) || isImagesPath(path);
}

export function isMessagesPath(path: string): boolean {
  return detectEndpointType(path) === EndpointType.MESSAGES;
}

export function isEmbeddingsPath(path: string): boolean {
  return detectEndpointType(path) === EndpointType.EMBEDDINGS;
}

export function isAudioPath(path: string): boolean {
  return detectEndpointType(path) === EndpointType.AUDIO;
}

export function isImagesPath(path: string): boolean {
  return detectEndpointType(path) === EndpointType.IMAGES;
}

export function isCompletionsPath(path: string): boolean {
  return detectEndpointType(path) === EndpointType.COMPLETIONS;
}

export function hasV1Prefix(path: string): boolean {
  return path.startsWith('/v1/');
}

export function hasV1BetaPrefix(path: string): boolean {
  return path.startsWith('/v1beta/');
}

export function hasDuplicatedV1Prefix(path: string): boolean {
  return path.startsWith('/v1/v1/');
}

/**
 * Ensure the /v1/ prefix and strip duplicated /v1/v1/.
 * Gemini /v1beta/ paths are returned unchanged.
 */
export function normalizePath(path: string): string {
  let normalizedPath = path;

  if (hasV1BetaPrefix(normalizedPath)) {
    return normalizedPath;
  }

  if (hasDuplicatedV1Prefix(normalizedPath)) {
    normalizedPath = normalizedPath.replace(/^\/v1\/v1\//, '/v1/');
  }

  if (!hasV1Prefix(normalizedPath)) {
    normalizedPath = `/v1${normalizedPath}`;
  }

  return normalizedPath;
}

export function isMessageBasedEndpoint(path: string): boolean {
  const endpointType = detectEndpointType(path);
  return [
    EndpointType.CHAT_COMPLETIONS,
    EndpointType.RESPONSES,
    EndpointType.MESSAGES
  ].includes(endpointType);
}

/** Prompt transformations currently apply to chat completions only. */
export function supportsPromptProcessing(path: string): boolean {
  return isChatCompletionsPath(path);
}

export function requiresInputNormalization(path: string): boolean {
  const endpointType = detectEndpointType(path);
  return [
    EndpointType.EMBEDDINGS,
    EndpointType.RESPONSES
  ].includes(endpointType);
}
