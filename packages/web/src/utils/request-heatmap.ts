import type { RequestHeatmapResponse } from '@/api/config'

const DAY_MS = 24 * 60 * 60 * 1000
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

export function formatHeatmapTokens(value: number): string {
  return `${(value / 1_000_000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })}M`
}

export interface HeatmapDay {
  date: string
  requestCount: number
  totalTokens: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  level: number
}

export function heatmapWindow(data: RequestHeatmapResponse, width: number): RequestHeatmapResponse {
  const columns = Math.max(53, Math.floor((width + 3) / 17))
  const lastWeekday = new Date(data.windowEnd - DAY_MS + SHANGHAI_OFFSET_MS).getUTCDay()
  const days = columns <= 53 ? 365 : Math.max(365, Math.min(data.days, columns * 7 - (6 - lastWeekday)))
  const windowStart = Math.max(data.windowStart, data.windowEnd - days * DAY_MS)
  return { ...data, days: Math.round((data.windowEnd - windowStart) / DAY_MS), windowStart, items: data.items.filter(item => item.timestamp >= windowStart) }
}

export function buildRequestHeatmap(data: RequestHeatmapResponse): Array<HeatmapDay | null> {
  const items = new Map(data.items.map(item => [item.timestamp, item]))
  const max = Math.max(0, ...data.items.map(item => item.totalTokens))
  const firstWeekday = new Date(data.windowStart + SHANGHAI_OFFSET_MS).getUTCDay()
  const cells: Array<HeatmapDay | null> = Array.from({ length: firstWeekday }, () => null)

  for (let timestamp = data.windowStart; timestamp < data.windowEnd; timestamp += DAY_MS) {
    const item = items.get(timestamp)
    const totalTokens = item?.totalTokens ?? 0
    const date = new Date(timestamp + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10)
    cells.push({
      date,
      requestCount: item?.requestCount ?? 0,
      totalTokens,
      promptTokens: item?.promptTokens ?? 0,
      completionTokens: item?.completionTokens ?? 0,
      cachedTokens: item?.cachedTokens ?? 0,
      level: totalTokens > 0 && max > 0 ? Math.ceil((totalTokens / max) * 4) : 0
    })
  }
  while (cells.length % 7 !== 0) cells.push(null)
  return cells
}
