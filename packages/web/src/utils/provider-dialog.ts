import type { ProtocolMapping } from '@/types';

export type ProtocolMode = 'single' | 'multi';

export const PROTOCOL_KEYS = ['openai', 'anthropic', 'google'] as const;
export type ProtocolKey = (typeof PROTOCOL_KEYS)[number];

export type EmptyProtocolUrls = Record<ProtocolKey, string>;

export type ConnectionIssue = 'emptyBaseUrl' | 'invalidBaseUrl' | 'emptyProtocols' | 'invalidProtocolUrl';

export type ConnectionResult =
  | { ok: true; baseUrl: string; protocolMappings: ProtocolMapping | null }
  | { ok: false; issue: ConnectionIssue; field: 'baseUrl' | ProtocolKey };

export interface ConnectionInput {
  protocolMode: ProtocolMode;
  baseUrl: string;
  protocolUrls: Partial<EmptyProtocolUrls>;
}

// Backend always stores a single base_url plus optional protocol mappings, so the
// dialog derives baseUrl from the first configured protocol when in multi mode.
export function resolveConnection(
  input: ConnectionInput,
  isValidUrl: (url: string) => boolean
): ConnectionResult {
  if (input.protocolMode === 'multi') {
    const mappings: ProtocolMapping = {};
    for (const key of PROTOCOL_KEYS) {
      const url = (input.protocolUrls[key] || '').trim();
      if (!url) continue;
      if (!isValidUrl(url)) return { ok: false, issue: 'invalidProtocolUrl', field: key };
      mappings[key] = url;
    }
    const baseUrl = PROTOCOL_KEYS.map(key => mappings[key]).find(Boolean) || '';
    if (!baseUrl) return { ok: false, issue: 'emptyProtocols', field: 'openai' };
    return { ok: true, baseUrl, protocolMappings: mappings };
  }

  const baseUrl = input.baseUrl.trim();
  if (!baseUrl) return { ok: false, issue: 'emptyBaseUrl', field: 'baseUrl' };
  if (!isValidUrl(baseUrl)) return { ok: false, issue: 'invalidBaseUrl', field: 'baseUrl' };
  return { ok: true, baseUrl, protocolMappings: null };
}

export interface ModelEntry {
  id: string;
  name?: string;
}

// Only models the upstream actually reported, never already-added ones: this dialog
// adds models and is not allowed to detach existing ones.
export function modelsToCreate<T extends ModelEntry>(
  discovered: T[],
  selectedIds: Iterable<string>,
  existingIdentifiers: Iterable<string>
): T[] {
  const selected = new Set(selectedIds);
  const existing = new Set(existingIdentifiers);
  const seen = new Set<string>();
  const result: T[] = [];
  for (const model of discovered) {
    if (!selected.has(model.id) || existing.has(model.id) || seen.has(model.id)) continue;
    seen.add(model.id);
    result.push(model);
  }
  return result;
}

// An untouched key field on edit means "keep the stored key" — the request must omit
// the property entirely, since the backend replaces the value whenever it is present.
export function resolveApiKeyPayload(isEdit: boolean, apiKey: string): string | undefined {
  const value = apiKey.trim();
  if (!value) return isEdit ? undefined : '';
  return value;
}

export function splitProtocolMappings(
  mappings: ProtocolMapping | null | undefined
): { enabled: boolean; urls: EmptyProtocolUrls } {
  const urls: EmptyProtocolUrls = { openai: '', anthropic: '', google: '' };
  if (!mappings) return { enabled: false, urls };
  for (const key of PROTOCOL_KEYS) {
    urls[key] = mappings[key] || '';
  }
  return { enabled: PROTOCOL_KEYS.some(key => urls[key] !== ''), urls };
}
