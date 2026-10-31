import { describe, expect, it } from 'vitest'
import { buildRequestHeatmap, formatHeatmapTokens, heatmapWindow } from './request-heatmap'

const DAY = 86400000
const start = Date.UTC(2026, 0, 3, 16)

describe('formatHeatmapTokens', () => {
  it('formats zero, small values and large totals in millions', () => {
    expect(formatHeatmapTokens(0)).toBe('0.00M')
    expect(formatHeatmapTokens(1)).toBe('0.000001M')
    expect(formatHeatmapTokens(629_110)).toBe('0.62911M')
    expect(formatHeatmapTokens(4_459_400)).toBe('4.4594M')
  })
})

describe('heatmapWindow', () => {
  it('extends into earlier dates when wider and keeps the latest year on narrow screens', () => {
    const data = { now: start, days: 730, windowStart: start, windowEnd: start + 730 * DAY, detailStart: start, items: [] }
    const narrow = heatmapWindow(data, 600)
    const wide = heatmapWindow(data, 1300)
    expect(narrow.days).toBe(365)
    expect(wide.days).toBeGreaterThan(365)
    expect(wide.days).toBeLessThanOrEqual(730)
    expect(buildRequestHeatmap(wide).length / 7).toBeLessThanOrEqual(Math.floor(1303 / 17))
    expect(heatmapWindow(data, 3000).days).toBe(730)
  })
})

describe('buildRequestHeatmap', () => {
  it('fills missing dates and scales colors by token usage rather than requests', () => {
    const cells = buildRequestHeatmap({
      now: start, days: 3, windowStart: start, windowEnd: start + 3 * DAY, detailStart: start,
      items: [
        { date: '2026-01-04', timestamp: start, requestCount: 100, totalTokens: 2, promptTokens: 1, completionTokens: 1, cachedTokens: 5 },
        { date: '2026-01-06', timestamp: start + 2 * DAY, requestCount: 1, totalTokens: 8, promptTokens: 5, completionTokens: 3, cachedTokens: 2 }
      ]
    })
    expect(cells.slice(0, 3)).toEqual([
      { date: '2026-01-04', requestCount: 100, totalTokens: 2, promptTokens: 1, completionTokens: 1, cachedTokens: 5, level: 1 },
      { date: '2026-01-05', requestCount: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, level: 0 },
      { date: '2026-01-06', requestCount: 1, totalTokens: 8, promptTokens: 5, completionTokens: 3, cachedTokens: 2, level: 4 }
    ])
    expect(cells).toHaveLength(7)
    expect(cells.slice(3)).toEqual([null, null, null, null])
  })

  it('places the first day on its weekday and handles an empty year', () => {
    const monday = start + DAY
    const cells = buildRequestHeatmap({ now: monday, days: 365, windowStart: monday, windowEnd: monday + 365 * DAY, detailStart: monday, items: [] })
    expect(cells[0]).toBeNull()
    expect(cells[1]).toEqual({ date: '2026-01-05', requestCount: 0, totalTokens: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, level: 0 })
    expect(cells.filter(Boolean)).toHaveLength(365)
    expect(cells.length % 7).toBe(0)
  })
})
