import { memoryLogger } from './logger.js';

export interface AifwMaskTextResult {
  maskedText: string;
  maskMeta: string;
}

export interface AifwClientConfig {
  baseUrl: string;
  httpApiKey?: string;
  timeoutMs: number;
}

export interface AifwMaskTextOptions {
  language?: string;
}

function buildAuthHeaders(httpApiKey?: string): Record<string, string> {
  if (!httpApiKey) return {};
  const trimmed = httpApiKey.trim();
  if (!trimmed) return {};
  // OneAIFW accepts either "<key>" or "Bearer <key>"
  const value = trimmed.toLowerCase().startsWith('bearer ') ? trimmed : `Bearer ${trimmed}`;
  return { Authorization: value };
}

export class AifwClient {
  constructor(private config: AifwClientConfig) {}

  private url(path: string): string {
    const base = this.config.baseUrl.replace(/\/+$/, '');
    const p = path.startsWith('/') ? path : `/${path}`;
    return `${base}${p}`;
  }

  async health(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
      const res = await fetch(this.url('/api/health'), {
        method: 'GET',
        headers: {
          ...buildAuthHeaders(this.config.httpApiKey),
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return res.ok;
    } catch {
      return false;
    }
  }

  async setMaskConfig(maskConfig: any): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
      const res = await fetch(this.url('/api/config'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildAuthHeaders(this.config.httpApiKey),
        },
        body: JSON.stringify({ maskConfig }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        memoryLogger.warn(`OneAIFW config update failed: HTTP ${res.status} ${text}`, 'AIFW');
        return false;
      }
      return true;
    } catch (e: any) {
      memoryLogger.warn(`OneAIFW config update failed: ${e?.message || e}`, 'AIFW');
      return false;
    }
  }

  async maskText(text: string, options?: AifwMaskTextOptions): Promise<AifwMaskTextResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await fetch(this.url('/api/mask_text'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildAuthHeaders(this.config.httpApiKey),
        },
        body: JSON.stringify({
          text,
          language: options?.language,
        }),
        signal: controller.signal,
      });
      const raw = await res.text();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${raw}`);
      }

      const parsed = raw ? JSON.parse(raw) : null;
      const out = parsed?.output;
      const maskedText = out?.text;
      const maskMeta = out?.maskMeta;
      if (typeof maskedText !== 'string' || typeof maskMeta !== 'string') {
        throw new Error('Invalid OneAIFW response (missing output.text/output.maskMeta)');
      }
      return { maskedText, maskMeta };
    } finally {
      clearTimeout(timeout);
    }
  }

  async maskTextBatch(items: { text: string; language?: string }[]): Promise<AifwMaskTextResult[]> {
    if (!items || items.length === 0) return [];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await fetch(this.url('/api/mask_text_batch'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildAuthHeaders(this.config.httpApiKey),
        },
        body: JSON.stringify(items),
        signal: controller.signal,
      });

      if (!res.ok) {
        const raw = await res.text();
        throw new Error(`HTTP ${res.status}: ${raw}`);
      }

      const raw = await res.text();
      let parsed: any = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        throw new Error(`Invalid OneAIFW batch response (invalid JSON): ${raw.slice(0, 500)}`);
      }

      if (parsed?.error) {
        throw new Error(`OneAIFW batch returned error: ${JSON.stringify(parsed.error)}`);
      }

      let outputs = parsed?.output;
      // Some deployments may return a single object for a batch of size 1.
      if (outputs && !Array.isArray(outputs) && typeof outputs === 'object') {
        outputs = [outputs];
      }

      if (!Array.isArray(outputs)) {
        throw new Error(`Invalid OneAIFW batch response (missing output array): ${raw.slice(0, 500)}`);
      }

      const results: AifwMaskTextResult[] = [];
      for (let i = 0; i < outputs.length; i++) {
        const item = outputs[i];
        if (!item || typeof item.text !== 'string' || typeof item.maskMeta !== 'string') {
          throw new Error(`Invalid OneAIFW batch item at index ${i}`);
        }
        results.push({
          maskedText: item.text,
          maskMeta: item.maskMeta,
        });
      }

      return results;
    } finally {
      clearTimeout(timeout);
    }
  }

  async restoreText(text: string, maskMeta: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await fetch(this.url('/api/restore_text'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildAuthHeaders(this.config.httpApiKey),
        },
        body: JSON.stringify({
          text,
          maskMeta,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const raw = await res.text();
        throw new Error(`HTTP ${res.status}: ${raw}`);
      }

      const parsed: any = await res.json();
      const out = parsed?.output;
      if (typeof out?.text !== 'string') {
        throw new Error('Invalid OneAIFW response (missing output.text)');
      }
      return out.text;
    } finally {
      clearTimeout(timeout);
    }
  }

  async restoreTextBatch(items: { text: string; maskMeta: string }[]): Promise<string[]> {
    if (!items || items.length === 0) return [];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await fetch(this.url('/api/restore_text_batch'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...buildAuthHeaders(this.config.httpApiKey),
        },
        body: JSON.stringify(items),
        signal: controller.signal,
      });

      if (!res.ok) {
        const raw = await res.text();
        throw new Error(`HTTP ${res.status}: ${raw}`);
      }

      const raw = await res.text();
      let parsed: any = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        throw new Error(`Invalid OneAIFW batch response (invalid JSON): ${raw.slice(0, 500)}`);
      }

      if (parsed?.error) {
        throw new Error(`OneAIFW batch returned error: ${JSON.stringify(parsed.error)}`);
      }

      let outputs = parsed?.output;
      if (outputs && !Array.isArray(outputs) && typeof outputs === 'object') {
        outputs = [outputs];
      }

      if (!Array.isArray(outputs)) {
        throw new Error(`Invalid OneAIFW batch response (missing output array): ${raw.slice(0, 500)}`);
      }

      const results: string[] = [];
      for (let i = 0; i < outputs.length; i++) {
        const item = outputs[i];
        if (!item || typeof item.text !== 'string') {
          throw new Error(`Invalid OneAIFW batch item at index ${i}`);
        }
        results.push(item.text);
      }

      return results;
    } finally {
      clearTimeout(timeout);
    }
  }
}
