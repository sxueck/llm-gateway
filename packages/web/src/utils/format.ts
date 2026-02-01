import numeral from 'numeral'

export interface FormatOptions {
  decimals?: number
  locale?: string
  useGrouping?: boolean
}

export function formatNumber(num: number, options?: FormatOptions): string {
  const { decimals = 1, useGrouping = false } = options || {}

  if (num >= 1_000_000) {
    return numeral(num).format(`0.${'0'.repeat(decimals)}a`).toUpperCase()
  }
  if (num >= 1000) {
    return numeral(num).format(`0.${'0'.repeat(decimals)}a`).toUpperCase()
  }

  if (useGrouping) {
    return numeral(num).format('0,0')
  }

  return num.toString()
}

export function formatTokenNumber(num: number, options?: FormatOptions): string {
  const { decimals = 2 } = options || {}

  if (num >= 1_000_000_000) {
    return numeral(num / 1_000_000_000).format(`0.${'0'.repeat(decimals)}`) + 'B'
  }
  if (num >= 1_000_000) {
    return numeral(num / 1_000_000).format(`0.${'0'.repeat(decimals)}`) + 'M'
  }
  if (num >= 10000) {
    return numeral(num / 1000).format(`0.${'0'.repeat(decimals)}`) + 'K'
  }

  return numeral(num).format('0,0')
}

export function formatPercentage(num: number, options?: FormatOptions): string {
  const { decimals } = options || {}

  if (num === 0) return '0'
  if (num === 100) return '100'
  if (num < 0.01) return '0.00'

  if (decimals !== undefined) {
    return num.toFixed(decimals)
  }

  if (num < 1) return num.toFixed(2)
  if (num < 10) return num.toFixed(1)
  return num.toFixed(0)
}

export function formatResponseTime(time: number, options?: FormatOptions): string {
  const { decimals } = options || {}

  if (time >= 1000) {
    return (time / 1000).toFixed(decimals ?? 2)
  }
  if (time < 1) {
    return time.toFixed(decimals ?? 3)
  }
  if (time < 10) {
    return time.toFixed(decimals ?? 2)
  }
  return time.toFixed(decimals ?? 1)
}

export function formatTimestamp(
  timestamp: number,
  period: '24h' | '7d' | '30d' = '24h',
  locale: string = 'zh-CN'
): string {
  if (!timestamp || isNaN(timestamp)) {
    return ''
  }

  const date = new Date(timestamp)
  const formatter = new Intl.DateTimeFormat(locale, {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit',
    day: '2-digit',
  })

  if (period === '24h') {
    return (
      formatter.format(date).split(' ')[1] ||
      date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
    )
  }
  return (
    formatter.format(date).split(' ')[0] ||
    date.toLocaleDateString(locale, { month: '2-digit', day: '2-digit' })
  )
}

export function formatUptime(seconds: number): string {
  if (!seconds) return '0s'

  const days = Math.floor(seconds / (24 * 3600))
  seconds %= 24 * 3600
  const hours = Math.floor(seconds / 3600)
  seconds %= 3600
  const minutes = Math.floor(seconds / 60)

  if (days > 0) {
    return `${days}d ${hours}h`
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  return `${minutes}m`
}
