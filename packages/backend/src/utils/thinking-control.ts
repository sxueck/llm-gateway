/**
 * Per-model "disable thinking" enforcement (model_attributes.disable_thinking).
 *
 * Applied on the live proxy paths before options are built.
 * - openai: Chat reads reasoning_effort / enable_thinking / thinking;
 *   Responses reads reasoning.effort. Each off switch is written, not deleted,
 *   because omitting it leaves the upstream default (often thinking on).
 * - anthropic: thinking={type:'disabled'}
 * - gemini: thinkingConfig.thinkingLevel=low. thinkingBudget is removed;
 *   the current API uses thinkingLevel and rejects the two fields together.
 */

export type ThinkingControlProtocol = 'openai' | 'anthropic' | 'gemini';

const GEMINI_THINKING_LEVEL = 'low';

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assignIfDifferent(obj: Record<string, any>, key: string, value: unknown): boolean {
  if (obj[key] === value) return false;
  obj[key] = value;
  return true;
}

function deleteIfPresent(obj: Record<string, any>, key: string): boolean {
  if (obj[key] === undefined) return false;
  delete obj[key];
  return true;
}

function configObjects(parent: Record<string, any>, camel: string, snake: string): Record<string, any>[] {
  const found: Record<string, any>[] = [];
  if (isPlainObject(parent[camel])) found.push(parent[camel]);
  if (isPlainObject(parent[snake])) found.push(parent[snake]);
  if (found.length === 0) {
    const created: Record<string, any> = {};
    parent[camel] = created;
    found.push(created);
  }
  return found;
}

function disableGeminiThinkingConfig(config: Record<string, any>): boolean {
  let changed = false;
  changed = deleteIfPresent(config, 'thinkingBudget') || changed;
  changed = deleteIfPresent(config, 'thinking_budget') || changed;
  changed = deleteIfPresent(config, 'thinking_level') || changed;
  changed = assignIfDifferent(config, 'thinkingLevel', GEMINI_THINKING_LEVEL) || changed;
  return changed;
}

function forceFalse(obj: Record<string, any>, key: string): boolean {
  if (obj[key] === false) return false;
  obj[key] = false;
  return true;
}

export function applyDisableThinking(body: any, protocol: ThinkingControlProtocol): boolean {
  if (!isPlainObject(body)) {
    return false;
  }

  switch (protocol) {
    case 'openai': {
      let changed = false;
      changed = assignIfDifferent(body, 'reasoning_effort', 'none') || changed;
      if (!isPlainObject(body.reasoning) || body.reasoning.effort !== 'none') {
        body.reasoning = {
          ...(isPlainObject(body.reasoning) ? body.reasoning : {}),
          effort: 'none',
        };
        changed = true;
      }
      if (body.thinking?.type !== 'disabled') {
        body.thinking = { type: 'disabled' };
        changed = true;
      }
      changed = forceFalse(body, 'enable_thinking') || changed;
      if (isPlainObject(body.extra_body)) {
        changed = forceFalse(body.extra_body, 'enable_thinking') || changed;
      }
      if (isPlainObject(body.chat_template_kwargs)) {
        changed = forceFalse(body.chat_template_kwargs, 'enable_thinking') || changed;
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
      let changed = false;
      for (const generationConfig of configObjects(body, 'generationConfig', 'generation_config')) {
        for (const thinkingConfig of configObjects(generationConfig, 'thinkingConfig', 'thinking_config')) {
          changed = disableGeminiThinkingConfig(thinkingConfig) || changed;
        }
      }
      return changed;
    }
  }
}
