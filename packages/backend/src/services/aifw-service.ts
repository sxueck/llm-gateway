import { loadAifwConfig, type AifwConfig } from '../utils/aifw-config.js';
import { AifwClient } from './aifw-client.js';
import { memoryLogger } from './logger.js';
import { decodeAifwMaskMeta, mergeAifwMaskMetas, type AifwPlaceholdersMap } from '../utils/aifw-placeholders.js';

export interface AifwContext {
  enabled: true;
  maskMeta: string;
  placeholdersMap: AifwPlaceholdersMap;
}

interface TextRef {
  get: () => string;
  set: (next: string) => void;
}

function collectTextRefs(body: any): TextRef[] {
  const refs: TextRef[] = [];

  const pushStringRef = (getter: () => any, setter: (v: any) => void) => {
    const value = getter();
    if (typeof value !== 'string') return;
    if (!value.trim()) return;
    refs.push({
      get: () => getter(),
      set: (next) => setter(next),
    });
  };

  const walkMessageContent = (message: any) => {
    if (!message || typeof message !== 'object') return;
    if (typeof message.content === 'string') {
      pushStringRef(() => message.content, (v) => { message.content = v; });
      return;
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part && typeof part === 'object' && typeof part.text === 'string') {
          pushStringRef(() => part.text, (v) => { part.text = v; });
        }
      }
    }
  };

  const walkGeminiParts = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.parts)) {
      for (const part of node.parts) {
        if (part && typeof part === 'object' && typeof part.text === 'string') {
          pushStringRef(() => part.text, (v) => { part.text = v; });
        }
      }
    }
  };

  const walkContentBlocks = (content: any) => {
    if (!content) return;
    if (typeof content === 'string') {
      pushStringRef(() => content, (_v) => {
        // no-op: cannot set captured primitive
      });
      return;
    }
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && typeof block.text === 'string') {
          pushStringRef(() => block.text, (v) => { block.text = v; });
        }
      }
    }
  };

  // OpenAI-ish: messages
  if (Array.isArray(body?.messages)) {
    for (const msg of body.messages) {
      walkMessageContent(msg);
    }
  }

  // OpenAI chat completion response: choices[].message.content
  if (Array.isArray(body?.choices)) {
    for (const choice of body.choices) {
      if (!choice || typeof choice !== 'object') continue;
      if (choice.message && typeof choice.message === 'object') {
        walkMessageContent(choice.message);
      }
      if (typeof choice.text === 'string') {
        // Legacy completions response: choices[].text
        pushStringRef(() => choice.text, (v) => { choice.text = v; });
      }
      // Some providers may return tool outputs/extra text fields
      if (typeof choice.reasoning_content === 'string') {
        pushStringRef(() => choice.reasoning_content, (v) => { choice.reasoning_content = v; });
      }
    }
  }

  // OpenAI completions-like: prompt
  if (typeof body?.prompt === 'string') {
    pushStringRef(() => body.prompt, (v) => { body.prompt = v; });
  }

  // Embeddings-like: input
  if (typeof body?.input === 'string') {
    pushStringRef(() => body.input, (v) => { body.input = v; });
  } else if (Array.isArray(body?.input)) {
    for (let i = 0; i < body.input.length; i++) {
      if (typeof body.input[i] === 'string') {
        const idx = i;
        pushStringRef(() => body.input[idx], (v) => { body.input[idx] = v; });
      } else if (body.input[i] && typeof body.input[i] === 'object') {
        // Responses API input array shapes: items may contain text blocks
        const item = body.input[i];

        if (typeof item.text === 'string') {
          pushStringRef(() => item.text, (v) => { item.text = v; });
        }

        if (typeof item.content === 'string') {
          pushStringRef(() => item.content, (v) => { item.content = v; });
        } else if (Array.isArray(item.content)) {
          for (const block of item.content) {
            if (block && typeof block === 'object' && typeof block.text === 'string') {
              pushStringRef(() => block.text, (v) => { block.text = v; });
            }
          }
        }

        if (item.type === 'input_text' && typeof item.text === 'string') {
          pushStringRef(() => item.text, (v) => { item.text = v; });
        }

        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const block of item.content) {
            if (block && typeof block === 'object' && typeof block.text === 'string') {
              pushStringRef(() => block.text, (v) => { block.text = v; });
            }
          }
        }
      }
    }
  }

  // Responses API: instructions
  if (typeof body?.instructions === 'string') {
    pushStringRef(() => body.instructions, (v) => { body.instructions = v; });
  }

  // Responses API response: output[].content[].text
  if (Array.isArray(body?.output)) {
    for (const item of body.output) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.text === 'string') {
        pushStringRef(() => item.text, (v) => { item.text = v; });
      }
      if (typeof item.content === 'string') {
        pushStringRef(() => item.content, (v) => { item.content = v; });
      } else if (Array.isArray(item.content)) {
        for (const block of item.content) {
          if (block && typeof block === 'object' && typeof block.text === 'string') {
            pushStringRef(() => block.text, (v) => { block.text = v; });
          }
        }
      }
    }
  }

  // Anthropic response: content[] blocks at top-level
  if (Array.isArray(body?.content)) {
    walkContentBlocks(body.content);
  }

  // Gemini native/OpenAI-compat: contents + systemInstruction
  if (Array.isArray(body?.contents)) {
    for (const content of body.contents) {
      walkGeminiParts(content);
    }
  }
  if (body?.systemInstruction) {
    walkGeminiParts(body.systemInstruction);
  }

  return refs;
}

  export class AifwService {
    private cachedConfig: { value: AifwConfig; loadedAt: number } | null = null;
    private readonly configTtlMs = 3000;
  private lastAppliedMaskConfigJson: string | null = null;

  private async getConfig(): Promise<AifwConfig> {
    const now = Date.now();
    if (this.cachedConfig && now - this.cachedConfig.loadedAt < this.configTtlMs) {
      return this.cachedConfig.value;
    }
    const value = await loadAifwConfig();
    this.cachedConfig = { value, loadedAt: now };
    return value;
  }

  private async ensureRemoteMaskConfig(client: AifwClient, cfg: AifwConfig) {
    if (!cfg.maskConfig || !cfg.enabled) return;
    const json = JSON.stringify(cfg.maskConfig);
    if (json === this.lastAppliedMaskConfigJson) return;
    const ok = await client.setMaskConfig(cfg.maskConfig);
    if (ok) {
      this.lastAppliedMaskConfigJson = json;
    } else {
      // Don't block masking (it may still work with server-side defaults or per-request config),
      // but log so the operator can diagnose why the config isn't taking effect.
      memoryLogger.warn('OneAIFW maskConfig sync failed (will continue with masking attempt)', 'AIFW');
    }
  }

  async maskRequestBodyInPlace(body: any): Promise<AifwContext | null> {
    const cfg = await this.getConfig();
    if (!cfg.enabled) return null;

    const refs = collectTextRefs(body);
    if (refs.length === 0) return null;

    const client = new AifwClient({
      baseUrl: cfg.baseUrl,
      httpApiKey: cfg.httpApiKey,
      timeoutMs: cfg.timeoutMs,
    });

    await this.ensureRemoteMaskConfig(client, cfg);

    try {
      const items = refs.map((ref) => ({ text: ref.get() }));
      const results = await client.maskTextBatch(items);

      if (results.length !== refs.length) {
        throw new Error(`Batch mask failed: expected ${refs.length} results, got ${results.length}`);
      }

      const mergedPlaceholders: AifwPlaceholdersMap = {};
      const allMaskMetas: string[] = [];
      let sawOpaqueMaskMeta = false;
      let sawPlaceholderInMaskedText = false;

      for (let i = 0; i < results.length; i++) {
        const { maskedText, maskMeta } = results[i];
        refs[i].set(maskedText);

        if (typeof maskMeta === 'string' && maskMeta) {
          allMaskMetas.push(maskMeta);
        }

        if (typeof maskedText === 'string' && maskedText.includes('__PII_')) {
          sawPlaceholderInMaskedText = true;
        }

        // Best-effort local decode for fallback restoration.
        // Many OneAIFW deployments return an opaque/binary maskMeta; in that
        // case, decoding will fail and we rely on server-side restore.
        const placeholders = decodeAifwMaskMeta(maskMeta);
        if (placeholders) {
          Object.assign(mergedPlaceholders, placeholders);
        } else {
          sawOpaqueMaskMeta = true;
        }
      }

      const decodedItems = Object.keys(mergedPlaceholders).length;
      if (decodedItems > 0) {
        memoryLogger.debug(`OneAIFW masking applied (decoded placeholders): ${decodedItems}`, 'AIFW');
      } else if (sawPlaceholderInMaskedText) {
        memoryLogger.debug('OneAIFW masking applied (opaque/binary maskMeta; local decode skipped)', 'AIFW');
      } else {
        memoryLogger.debug('OneAIFW masking applied: 0 items (check maskConfig)', 'AIFW');
      }

      const finalMaskMeta = mergeAifwMaskMetas(allMaskMetas);

      if (sawOpaqueMaskMeta && decodedItems === 0 && finalMaskMeta) {
        memoryLogger.debug(`OneAIFW maskMeta merged as opaque blob (len=${finalMaskMeta.length})`, 'AIFW');
      } else {
        memoryLogger.debug(`OneAIFW Context: maskMeta length=${finalMaskMeta.length}`, 'AIFW');
      }

      return { enabled: true, maskMeta: finalMaskMeta, placeholdersMap: mergedPlaceholders };
    } catch (e: any) {
      const msg = e?.message || String(e);
      memoryLogger.error(`OneAIFW mask failed: ${msg}`, 'AIFW');
      if (cfg.failOpen) {
        memoryLogger.warn('OneAIFW is enabled but fail-open is on; request continues without masking', 'AIFW');
        return null;
      }
      throw new Error(`AIFW unavailable: ${msg}`);
    }
  }

  async restoreResponseBodyInPlace(body: any, maskMeta: string): Promise<void> {
    const cfg = await this.getConfig();
    if (!cfg.enabled) return;

    const refs = collectTextRefs(body);
    if (refs.length === 0) return;

    const client = new AifwClient({
      baseUrl: cfg.baseUrl,
      httpApiKey: cfg.httpApiKey,
      timeoutMs: cfg.timeoutMs,
    });

    try {
      const items = refs.map((ref) => ({ text: ref.get(), maskMeta }));
      const results = await client.restoreTextBatch(items);

      if (results.length !== refs.length) {
        throw new Error(`Batch restore failed: expected ${refs.length} results, got ${results.length}`);
      }

      for (let i = 0; i < results.length; i++) {
        refs[i].set(results[i]);
      }

      memoryLogger.debug(`OneAIFW restoration applied: ${refs.length} items`, 'AIFW');
    } catch (e: any) {
      memoryLogger.error(`OneAIFW restore failed: ${e?.message || e}`, 'AIFW');
      // We don't throw here because we want to return the (partially?) masked response rather than failing completely
    }
  }
}

export const aifwService = new AifwService();
