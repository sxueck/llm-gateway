import { loadAifwConfig, type AifwConfig } from '../utils/aifw-config.js';
import { AifwClient } from './aifw-client.js';
import { memoryLogger } from './logger.js';
import { decodeAifwMaskMeta, mergeAifwMaskMetas, type AifwPlaceholdersMap } from '../utils/aifw-placeholders.js';
import { systemConfigDb } from '../db/index.js';

const AIFW_PRESERVE_PLACEHOLDERS_HINT =
  'Important: The text may contain OneAIFW placeholders like __PII_EMAIL_ADDRESS_00000001__ (or __PII_EMAIL_ADDRESS_1__). ' +
  'These placeholders MUST be copied verbatim: do not translate, reformat, pad/strip zeros, add spaces, or delete them. ' +
  'If you remove/alter placeholders, the gateway cannot restore the original values.';

function injectPreservePlaceholdersHintInPlace(body: any): void {
  if (!body || typeof body !== 'object') return;

  // OpenAI-ish chat: messages[].role/content
  if (Array.isArray(body.messages)) {
    const sysIdx = body.messages.findIndex((m: any) => m && m.role === 'system');
    if (sysIdx >= 0) {
      const msg = body.messages[sysIdx];
      if (typeof msg?.content === 'string') {
        msg.content = `${msg.content}\n\n${AIFW_PRESERVE_PLACEHOLDERS_HINT}`;
        return;
      }
      if (Array.isArray(msg?.content)) {
        msg.content.push({ type: 'text', text: AIFW_PRESERVE_PLACEHOLDERS_HINT });
        return;
      }
    }

    // No system message: prepend one.
    body.messages.unshift({ role: 'system', content: AIFW_PRESERVE_PLACEHOLDERS_HINT });
    return;
  }

  // OpenAI Responses API: instructions
  if (typeof body.instructions === 'string') {
    body.instructions = `${body.instructions}\n\n${AIFW_PRESERVE_PLACEHOLDERS_HINT}`;
    return;
  }
  if (body.instructions === undefined) {
    // Only set if missing; avoid overwriting non-string formats.
    body.instructions = AIFW_PRESERVE_PLACEHOLDERS_HINT;
    return;
  }

  // Gemini native: systemInstruction.parts[].text
  if (body.systemInstruction && typeof body.systemInstruction === 'object' && Array.isArray(body.systemInstruction.parts)) {
    body.systemInstruction.parts.push({ text: AIFW_PRESERVE_PLACEHOLDERS_HINT });
  }
}

export interface AifwContext {
  enabled: true;
  maskMeta: string;
  placeholdersMap: AifwPlaceholdersMap;
  clientConfig: {
    baseUrl: string;
    httpApiKey?: string;
    timeoutMs: number;
  };
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
  private maskedCount: number = 0;
  private lastMaskedAt: number = 0;
  private initialized = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistInFlight: Promise<void> | null = null;
  private pendingPersist = false;
  private lastPersistAt = 0;
  private readonly persistDebounceMs = 5000;
  private persistDisabled = false;
  // Guardrail: some OneAIFW NER ONNX models crash on very long inputs.
  // Skip overlong fields to keep masking fail-open and avoid breaking requests.
  private readonly maxMaskTextChars = 8000;

  async getStats() {
    await this.ensureInitialized();
    const cfg = await this.getConfig();
    return {
      maskedCount: this.maskedCount,
      lastMaskedAt: this.lastMaskedAt,
      enabled: cfg.enabled,
    };
  }

  private async ensureInitialized() {
    if (this.initialized) return;
    try {
      const savedCount = await systemConfigDb.get('aifw_masked_count');
      const savedLastAt = await systemConfigDb.get('aifw_last_masked_at');
      
      if (savedCount) {
        this.maskedCount = Number(savedCount.value) || 0;
      }
      if (savedLastAt) {
        this.lastMaskedAt = Number(savedLastAt.value) || 0;
      }
    } catch (e) {
      memoryLogger.warn(`Failed to initialize AIFW stats: ${e}`, 'AIFW');
    } finally {
      // Stats are best-effort. If DB read fails once, don't keep retrying per-request.
      this.initialized = true;
    }
  }

  private async persistStats() {
    try {
      await Promise.all([
        systemConfigDb.set('aifw_masked_count', String(this.maskedCount), 'OneAIFW 隐私保护累计次数'),
        systemConfigDb.set('aifw_last_masked_at', String(this.lastMaskedAt), 'OneAIFW 最后隐私保护时间')
      ]);
    } catch (e) {
      // Stats persistence is best-effort. If it fails once, stop trying to avoid
      // repeatedly hitting a broken DB and spamming logs.
      this.persistDisabled = true;
      memoryLogger.warn(`Failed to persist AIFW stats: ${e}`, 'AIFW');
    }
  }

  private schedulePersistStats() {
    if (this.persistDisabled) return;
    this.pendingPersist = true;
    if (this.persistTimer) return;

    const now = Date.now();
    const delay = Math.max(0, this.persistDebounceMs - (now - this.lastPersistAt));
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flushPersistStats().catch(() => {});
    }, delay);
  }

  private async flushPersistStats(): Promise<void> {
    if (!this.pendingPersist) return;
    this.pendingPersist = false;
    this.lastPersistAt = Date.now();

    // Serialize writes so we don't overlap DB updates.
    if (this.persistInFlight) {
      try {
        await this.persistInFlight;
      } catch {
        // Ignore and attempt the latest write.
      }
    }

    const p = this.persistStats().finally(() => {
      if (this.persistInFlight === p) {
        this.persistInFlight = null;
      }
    });
    this.persistInFlight = p;
    await p;
  }

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

    await this.ensureInitialized();

    const refs = collectTextRefs(body);
    if (refs.length === 0) return null;

    const pairs = refs
      .map((ref) => ({ ref, text: ref.get() }))
      .filter((x) => typeof x.text === 'string' && x.text.trim().length > 0);

    const maskPairs = pairs.filter((x) => x.text.length <= this.maxMaskTextChars);
    const skipped = pairs.length - maskPairs.length;
    if (maskPairs.length === 0) {
      if (skipped > 0) {
        memoryLogger.warn(
          `OneAIFW masking skipped: all text fields exceed max length (${this.maxMaskTextChars} chars)`,
          'AIFW'
        );
      }
      return null;
    }

    if (skipped > 0) {
      memoryLogger.warn(
        `OneAIFW masking: skipped ${skipped}/${pairs.length} fields (> ${this.maxMaskTextChars} chars) to avoid NER crashes`,
        'AIFW'
      );
    }

    const client = new AifwClient({
      baseUrl: cfg.baseUrl,
      httpApiKey: cfg.httpApiKey,
      timeoutMs: cfg.timeoutMs,
    });

    await this.ensureRemoteMaskConfig(client, cfg);

    try {
      const items = maskPairs.map((p) => ({ text: p.text }));
      const results = await client.maskTextBatch(items);

      if (results.length !== maskPairs.length) {
        throw new Error(`Batch mask failed: expected ${maskPairs.length} results, got ${results.length}`);
      }

      const mergedPlaceholders: AifwPlaceholdersMap = {};
      const allMaskMetas: string[] = [];
      let sawOpaqueMaskMeta = false;
      let sawPlaceholderInMaskedText = false;

      for (let i = 0; i < results.length; i++) {
        const { maskedText, maskMeta } = results[i];
        maskPairs[i].ref.set(maskedText);

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
        this.maskedCount++;
        this.lastMaskedAt = Date.now();
        this.schedulePersistStats();
      } else if (sawPlaceholderInMaskedText) {
        memoryLogger.debug('OneAIFW masking applied (opaque/binary maskMeta; local decode skipped)', 'AIFW');
        this.maskedCount++;
        this.lastMaskedAt = Date.now();
        this.schedulePersistStats();
      } else {
        memoryLogger.debug('OneAIFW masking applied: 0 items (check maskConfig)', 'AIFW');
      }

      const finalMaskMeta = mergeAifwMaskMetas(allMaskMetas);

      if (sawOpaqueMaskMeta && decodedItems === 0 && finalMaskMeta) {
        memoryLogger.debug(`OneAIFW maskMeta merged as opaque blob (len=${finalMaskMeta.length})`, 'AIFW');
      } else {
        memoryLogger.debug(`OneAIFW Context: maskMeta length=${finalMaskMeta.length}`, 'AIFW');
      }

      // After masking, add a small instruction for the upstream model to preserve placeholders.
      // Only add it when masking actually introduced placeholders.
      if (decodedItems > 0 || sawPlaceholderInMaskedText) {
        injectPreservePlaceholdersHintInPlace(body);
      }

      return {
        enabled: true,
        maskMeta: finalMaskMeta,
        placeholdersMap: mergedPlaceholders,
        clientConfig: {
          baseUrl: cfg.baseUrl,
          httpApiKey: cfg.httpApiKey,
          timeoutMs: cfg.timeoutMs,
        },
      };
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
