/**
 * cURL examples for the virtual key create/rotate result modal. The generated
 * command must be paste-and-run ready, so every line except the last ends with
 * a shell line continuation.
 *
 * Security constraint: key values, URLs and headers are always wrapped in
 * POSIX single quotes (`'` -> `'\''`), and the request body is JSON.stringify'd
 * then single-quoted as a whole, so no value can be re-interpreted by the
 * shell (command substitution, variable expansion, backticks).
 */

/** POSIX-safe single quoting: a literal `'` closes the quote, emits an escaped quote, reopens. */
export function shellSingleQuote(value: string): string {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export interface VirtualKeyCurlInput {
  baseUrl: string;
  keyValue: string;
  /** model_identifier of a bound model (the real `model` field value), not the display name. */
  modelIdentifier: string;
}

export interface VirtualKeyCurlSnippets {
  openai: string;
  anthropic: string;
}

const OPENAI_BODY = { model: '', messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 };
const ANTHROPIC_BODY = { model: '', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] };

/** Returns null when no usable model identifier is bound; the caller explains why. */
export function buildVirtualKeyCurlSnippets(input: VirtualKeyCurlInput): VirtualKeyCurlSnippets | null {
  const base = input.baseUrl.replace(/\/+$/, '');
  if (!input.modelIdentifier) return null;

  const openaiBody = JSON.stringify({ ...OPENAI_BODY, model: input.modelIdentifier });
  const anthropicBody = JSON.stringify({ ...ANTHROPIC_BODY, model: input.modelIdentifier });

  const openai = [
    `curl -X POST ${shellSingleQuote(`${base}/v1/chat/completions`)} \\`,
    `  -H ${shellSingleQuote('Content-Type: application/json')} \\`,
    `  -H ${shellSingleQuote(`Authorization: Bearer ${input.keyValue}`)} \\`,
    `  -d ${shellSingleQuote(openaiBody)}`,
  ].join('\n');

  const anthropic = [
    `curl -X POST ${shellSingleQuote(`${base}/v1/messages`)} \\`,
    `  -H ${shellSingleQuote('Content-Type: application/json')} \\`,
    `  -H ${shellSingleQuote(`x-api-key: ${input.keyValue}`)} \\`,
    `  -H ${shellSingleQuote('anthropic-version: 2023-06-01')} \\`,
    `  -d ${shellSingleQuote(anthropicBody)}`,
  ].join('\n');

  return { openai, anthropic };
}
