/**
 * Per-model "disable thinking" enforcement (model_attributes.disable_thinking).
 *
 * Translates the single operator-facing switch into per-protocol request
 * rewrites, applied on the live proxy paths BEFORE options/params are built,
 * so a client cannot force thinking on models meant to answer instantly:
 * - openai: strip reasoning_effort/reasoning/thinking; set enable_thinking=false
 *   (top level for forwarding plus extra_body, mirroring supports_reasoning's
 *   extra_body convention; providers that reject the unknown field must not
 *   get this flag enabled)
 * - anthropic: thinking={type:'disabled'}
 * - gemini: generationConfig.thinkingConfig.thinkingBudget=0, drop thinkingLevel
 */

export type ThinkingControlProtocol = 'openai' | 'anthropic' | 'gemini';

function getOrCreateField(obj: any, camel: string, snake: string): any {
  for (const key of [camel, snake]) {
    if (obj[key] !== undefined && obj[key] !== null && typeof obj[key] === 'object') {
      return obj[key];
    }
  }
  return (obj[camel] = {});
}

export function applyDisableThinking(body: any, protocol: ThinkingControlProtocol): boolean {
  if (!body || typeof body !== 'object') {
    return false;
  }

  switch (protocol) {
    case 'openai': {
      let changed = false;
      for (const field of ['reasoning_effort', 'reasoning', 'thinking'] as const) {
        if (body[field] !== undefined) {
          delete body[field];
          changed = true;
        }
      }
      if (body.enable_thinking !== false) {
        body.enable_thinking = false;
        changed = true;
      }
      const extraBody = body.extra_body && typeof body.extra_body === 'object' ? body.extra_body : {};
      if (extraBody.enable_thinking !== false) {
        changed = true;
      }
      body.extra_body = { ...extraBody, enable_thinking: false };
      return changed;
    }
    case 'anthropic': {
      if (body.thinking && typeof body.thinking === 'object' && body.thinking.type === 'disabled') {
        return false;
      }
      body.thinking = { type: 'disabled' };
      return true;
    }
    case 'gemini': {
      const generationConfig = getOrCreateField(body, 'generationConfig', 'generation_config');
      const thinkingConfig = getOrCreateField(generationConfig, 'thinkingConfig', 'thinking_config');
      let changed = false;
      if (thinkingConfig.thinkingBudget !== 0) {
        thinkingConfig.thinkingBudget = 0;
        changed = true;
      }
      if (thinkingConfig.thinkingLevel !== undefined) {
        delete thinkingConfig.thinkingLevel;
        changed = true;
      }
      return changed;
    }
  }
}
