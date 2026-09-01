/**
 * Per-model "disable thinking" enforcement (model_attributes.disable_thinking).
 *
 * Translates the single operator-facing switch into per-protocol request
 * rewrites, applied on the live proxy paths BEFORE options/params are built,
 * so a client cannot force thinking on models meant to answer instantly:
 * - openai: strip reasoning_effort/reasoning; force thinking={type:'disabled'}
 *   (the OpenAI SDK's extra_body serializes this as the top-level MiMo field)
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
      for (const field of ['reasoning_effort', 'reasoning'] as const) {
        if (body[field] !== undefined) {
          delete body[field];
          changed = true;
        }
      }
      if (body.thinking?.type !== 'disabled') {
        body.thinking = { type: 'disabled' };
        changed = true;
      }
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
