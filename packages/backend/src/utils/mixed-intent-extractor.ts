/** Extract the likely user intent from a pasted/mixed text blob. */

import { jsonrepair } from 'jsonrepair';

function normalizeNewlines(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function isLargeMultiline(raw: string): boolean {
  const t = raw || '';
  const lines = normalizeNewlines(t).split('\n');
  const nonEmpty = lines.filter(l => l.trim().length > 0).length;
  return t.length > 400 && nonEmpty >= 6;
}

function unwrapExportedContentField(input: string): string {
  let t = (input || '').toString();
  const m = t.match(/^\s*"?content"?\s*:\s*([\s\S]+)$/i);
  if (!m || !m[1]) return t;

  t = m[1].trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    t = t.slice(1, -1);
    t = t
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\"/g, '"');
  }
  return t;
}

function tryParseJsonEnvelope(input: string): any | null {
  const t = (input || '').trim();
  if (!t) return null;
  if (!t.startsWith('{') && !t.startsWith('[')) return null;

  try {
    const repaired = jsonrepair(t);
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

function extractTextFromContentParts(content: any): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const texts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (typeof (part as any).text === 'string') {
      texts.push((part as any).text);
    } else if (typeof (part as any).content === 'string') {
      texts.push((part as any).content);
    }
  }
  return texts.join('\n').trim();
}

function tryExtractFromEnvelope(obj: any): string | null {
  if (!obj) return null;

  if (typeof obj === 'object' && typeof obj.role === 'string' && obj.content !== undefined) {
    const extracted = extractTextFromContentParts(obj.content);
    return extracted || null;
  }

  if (typeof obj === 'object' && Array.isArray(obj.messages)) {
    const userMsgs = obj.messages.filter((m: any) => m && typeof m === 'object' && m.role === 'user');
    const last = userMsgs[userMsgs.length - 1];
    const extracted = last ? extractTextFromContentParts(last.content) : '';
    return extracted || null;
  }

  if (typeof obj === 'object' && Array.isArray(obj.input)) {
    const userMsgs = obj.input.filter((m: any) => m && typeof m === 'object' && m.role === 'user');
    const last = userMsgs[userMsgs.length - 1];
    const extracted = last ? extractTextFromContentParts(last.content) : '';
    return extracted || null;
  }

  if (Array.isArray(obj)) {
    const userMsgs = obj.filter((m: any) => m && typeof m === 'object' && m.role === 'user');
    const last = userMsgs[userMsgs.length - 1];
    const extracted = last ? extractTextFromContentParts(last.content) : '';
    return extracted || null;
  }

  return null;
}

function findLastQuestionLikeLine(input: string): string | null {
  const lines = normalizeNewlines(input)
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    if (line.length > 500) continue;
    if (line.startsWith('{') || line.startsWith('[')) continue;

    if (/^(USER|ASSISTANT|SYSTEM)\s*:/i.test(line)) continue;
    if (/^ChatHistory\s*:/i.test(line)) continue;

    if (/[\?？]\s*$/.test(line)) return line;

    if (/(如何|怎么|为什么|为何|是否|是不是|能否|可以吗|需要吗|请问|怎么办|how\b|why\b|can\b|should\b)/i.test(line)) {
      return line;
    }
  }

  return null;
}

export function extractUserIntentFromMixedText(raw: string): string {
  if (!raw) return '';

  const unwrapped = unwrapExportedContentField(raw);
  let text = unwrapped;

  const parsed = tryParseJsonEnvelope(text);
  const fromEnvelope = parsed ? tryExtractFromEnvelope(parsed) : null;
  if (fromEnvelope && fromEnvelope.trim().length > 0) {
    return fromEnvelope.trim();
  }

  text = text.replace(/\n{3,}/g, '\n\n').trim();

  if (!text) return unwrapped.trim();

  if (isLargeMultiline(text)) {
    const q = findLastQuestionLikeLine(text);
    if (q && q.trim().length > 0) return q.trim();
  }

  return text;
}
