import type { ApiRequest } from '@/api/api-request'
import { extractRequestPreview } from '@/utils/content-truncator'

export type JsonLike = Record<string, any> | string | null | undefined

export function parseJsonLike(value: JsonLike): Record<string, any> | null {
  if (!value) return null
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function getRequestParams(row: ApiRequest): Record<string, any> | null {
  return parseJsonLike(row.request_params_json)
}

function previewFromJson(value: JsonLike): string {
  const parsed = parseJsonLike(value)
  if (!parsed) return '-'

  const text = JSON.stringify(parsed)
  if (!text) return '-'
  return text.length > 80 ? `${text.slice(0, 80)}...` : text
}

export function getRequestPreview(row: ApiRequest): string {
  if (row.request_body) {
    return extractRequestPreview(row.request_body)
  }
  return previewFromJson(row.request_params_json)
}

/**
 * 汇总口径里的 token 数不可信（流式部分请求 summary 与 body.usage 并存），
 * 优先读行列，缺失时回退解析 response_body 的 usage，与详情抽屉保持一致。
 */
export function getRequestTokens(row: ApiRequest, type: 'input' | 'output'): number {
  const isInput = type === 'input'
  const direct = isInput ? row.prompt_tokens : row.completion_tokens
  if (direct) return direct
  try {
    const usage = JSON.parse(row.response_body || '{}')?.usage
    if (!usage) return 0
    const base = isInput
      ? (usage.input_tokens ?? usage.prompt_tokens ?? 0)
      : (usage.output_tokens ?? usage.completion_tokens ?? 0)
    return isInput && base === 0
      ? base +
          (usage.input_tokens_details?.cached_tokens ??
            usage.prompt_tokens_details?.cached_tokens ??
            0)
      : base
  } catch {
    return 0
  }
}
