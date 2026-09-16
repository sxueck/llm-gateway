/**
 * 从模型输出中提取结构化结果 JSON（FR-7）：
 * 1) 直接 parse；2) ```json 围栏；3) 首个平衡的 {...} 块。
 */
export function extractJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    const direct = tryParse(trimmed);
    if (direct !== undefined) return { ok: true, value: direct };
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fenced) {
    const parsed = tryParse(fenced[1].trim());
    if (parsed !== undefined) return { ok: true, value: parsed };
  }
  const balanced = firstBalancedObject(trimmed);
  if (balanced !== null) {
    const parsed = tryParse(balanced);
    if (parsed !== undefined) return { ok: true, value: parsed };
  }
  return { ok: false, error: 'no JSON object found in model output' };
}

function tryParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function firstBalancedObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\') {
      escaped = true;
      continue;
    }
    if (c === '"') inString = !inString;
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 轻量结构校验（网关侧 zod 是最终闸门）：
 * 检查必填字段、行区间合法性与路径形态。
 */
export function lightValidateResult(value: unknown): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return ['result must be a JSON object'];
  }
  const obj = value as Record<string, unknown>;
  if (obj.status !== 'completed') errors.push('status must be "completed"');
  if (typeof obj.summary !== 'string' || obj.summary.trim().length === 0) {
    errors.push('summary must be a non-empty string');
  }
  if (!Array.isArray(obj.files)) {
    errors.push('files must be an array');
  } else {
    if (obj.files.length > 50) errors.push('files must have at most 50 entries');
    obj.files.forEach((file, i) => {
      if (!file || typeof file !== 'object') {
        errors.push(`files[${i}] must be an object`);
        return;
      }
      const f = file as Record<string, unknown>;
      if (typeof f.path !== 'string' || f.path.length === 0 || f.path.startsWith('/') || f.path.split('/').includes('..')) {
        errors.push(`files[${i}].path must be a workspace-relative path`);
      }
      const start = Number(f.start_line);
      const end = Number(f.end_line);
      if (!Number.isInteger(start) || start < 1) errors.push(`files[${i}].start_line must be an integer >= 1`);
      if (!Number.isInteger(end) || end < 1) errors.push(`files[${i}].end_line must be an integer >= 1`);
      if (Number.isInteger(start) && Number.isInteger(end) && end < start) {
        errors.push(`files[${i}].end_line must be >= start_line`);
      }
      if (typeof f.reason !== 'string' || f.reason.trim().length === 0) {
        errors.push(`files[${i}].reason must be a non-empty string`);
      }
    });
  }
  return errors;
}
