export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export function removeV1Suffix(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized.endsWith('/v1') ? normalized.slice(0, -3) : normalized;
}

export function buildEndpointUrl(baseUrl: string, endpoint: string): string {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const normalizedEndpoint = endpoint.trim().replace(/^\/+/, '');
  return `${normalizedBase}/${normalizedEndpoint}`;
}

export function buildModelsEndpoint(baseUrl: string): string {
  return buildEndpointUrl(baseUrl, 'models');
}

export function buildChatCompletionsEndpoint(baseUrl: string): string {
  return buildEndpointUrl(baseUrl, 'chat/completions');
}
