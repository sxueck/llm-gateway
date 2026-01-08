function hasStringIdLike(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

export function inputReferencesPersistedItems(input: unknown): boolean {
  if (!Array.isArray(input)) return false;

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as any;

    // Common identifiers that indicate referencing an existing item/response.
    if (hasStringIdLike(obj.id)) {
      // Many providers use prefixes like "rs_" for response IDs.
      return true;
    }
    if (hasStringIdLike(obj.response_id) || hasStringIdLike(obj.responseId)) return true;
    if (hasStringIdLike(obj.input_item_id) || hasStringIdLike(obj.inputItemId)) return true;
    if (hasStringIdLike(obj.item_id) || hasStringIdLike(obj.itemId)) return true;

    const content = obj.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as any;
        if (hasStringIdLike(b.id) || hasStringIdLike(b.item_id) || hasStringIdLike(b.itemId)) {
          return true;
        }
      }
    }
  }

  return false;
}

export function normalizeResponsesStoreParam(body: any, includePrevId: boolean): { store?: boolean } {
  if (!body || typeof body !== 'object') return {};

  if (body.store !== undefined) {
    return { store: Boolean(body.store) };
  }

  const hasPrev = includePrevId && typeof body.previous_response_id === 'string' && body.previous_response_id.length > 0;
  if (hasPrev) {
    return { store: true };
  }

  if (inputReferencesPersistedItems(body.input)) {
    return { store: true };
  }

  return {};
}

