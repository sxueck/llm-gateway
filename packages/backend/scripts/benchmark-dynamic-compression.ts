#!/usr/bin/env node
// High-concurrency, long-context benchmark for the request-path work performed
// before an upstream model sends its first token. It compares dynamic compression
// on/off with a deterministic mock upstream delay; it does not require MySQL or a
// provider credential.
//
// Run: bun run benchmark:dynamic-compression
// Tune: bun run benchmark:dynamic-compression -- --requests=120 --concurrency=16

import { PerformanceObserver, monitorEventLoopDelay, performance } from 'node:perf_hooks'
import os from 'node:os'
import { MessageCompressor, type CompressionTiming } from '../src/services/message-compressor.js'
import { memoryLogger } from '../src/services/logger.js'

interface BenchmarkOptions {
  requests: number
  concurrency: number
  historyTurns: number
  codeLines: number
  upstreamTtftMs: number
  generationMs: number
  warmupRequests: number
}

interface LatencySummary {
  p50Ms: number
  p95Ms: number
  p99Ms: number
  meanMs: number
  maxMs: number
}

interface CoreSnapshot {
  idle: number
  total: number
}

interface CompressorProfile {
  requests: number
  preprocessMs: LatencySummary
  tokenCountMs: LatencySummary
  totalMs: LatencySummary
  preprocessShareOfTotal: number
}

interface ScenarioResult {
  dynamicCompression: boolean
  completedRequests: number
  wallTimeMs: number
  throughputRequestsPerSecond: number
  ttft: LatencySummary
  endToEnd: LatencySummary
  eventLoop: {
    utilization: number
    activeMs: number
    idleMs: number
    delayP50Ms: number
    delayP95Ms: number
    delayP99Ms: number
    delayMaxMs: number
  }
  processCpu: {
    utilization: number
    userMs: number
    systemMs: number
  }
  systemCpuPerCore: number[]
  gcPause: {
    count: number
    totalMs: number
    p50Ms: number
    p95Ms: number
    maxMs: number
  }
  compressor?: CompressorProfile
}

function parsePositiveInt(name: string, defaultValue: number): number {
  const arg = process.argv.find(value => value.startsWith(`--${name}=`))
  if (!arg) return defaultValue
  const parsed = Number.parseInt(arg.slice(name.length + 3), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`)
  }
  return parsed
}

function parseOptions(): BenchmarkOptions {
  return {
    requests: parsePositiveInt('requests', 96),
    concurrency: parsePositiveInt('concurrency', Math.max(4, Math.min(os.availableParallelism(), 16))),
    historyTurns: parsePositiveInt('history-turns', 24),
    codeLines: parsePositiveInt('code-lines', 120),
    upstreamTtftMs: parsePositiveInt('upstream-ttft-ms', 15),
    generationMs: parsePositiveInt('generation-ms', 25),
    warmupRequests: parsePositiveInt('warmup-requests', 8),
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function percentile(samples: number[], percentileValue: number): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1)
  return sorted[index]
}

function summarize(samples: number[]): LatencySummary {
  if (samples.length === 0) {
    return { p50Ms: 0, p95Ms: 0, p99Ms: 0, meanMs: 0, maxMs: 0 }
  }
  return {
    p50Ms: percentile(samples, 50),
    p95Ms: percentile(samples, 95),
    p99Ms: percentile(samples, 99),
    meanMs: samples.reduce((total, value) => total + value, 0) / samples.length,
    maxMs: Math.max(...samples),
  }
}

function snapshotCores(): CoreSnapshot[] {
  return os.cpus().map(cpu => {
    const times = cpu.times
    return {
      idle: times.idle,
      total: times.user + times.nice + times.sys + times.idle + times.irq,
    }
  })
}

function calculateCoreUtilization(before: CoreSnapshot[], after: CoreSnapshot[]): number[] {
  return before.map((start, index) => {
    const end = after[index]
    if (!end) return 0
    const totalDelta = end.total - start.total
    const idleDelta = end.idle - start.idle
    return totalDelta > 0 ? ((totalDelta - idleDelta) / totalDelta) * 100 : 0
  })
}

function buildLongHistory(options: BenchmarkOptions): Array<{ role: string; content: string }> {
  const sharedCodeBlock = Array.from(
    { length: options.codeLines },
    (_, index) =>
      `const item_${index} = await upstream.read(); if (item_${index}?.done) return finalize(item_${index}.value);`
  ).join('\n')
  const repeatedBlock = `\n\`\`\`ts\n${sharedCodeBlock}\n\`\`\`\n`
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: 'You are a gateway that preserves streaming backpressure.' },
  ]

  for (let turn = 0; turn < options.historyTurns; turn++) {
    messages.push({
      role: 'user',
      content: `Turn ${turn}: review this retry and stream-processing implementation.${repeatedBlock}`,
    })
  }
  messages.push(
    { role: 'assistant', content: 'I will inspect the current stream implementation.' },
    { role: 'user', content: 'Give the final recommendation and include failure modes.' },
    { role: 'assistant', content: 'I will provide a concise recommendation.' },
    { role: 'user', content: 'Now respond with the result.' },
  )
  return messages
}

async function runScenario(
  dynamicCompression: boolean,
  options: BenchmarkOptions,
  messages: Array<{ role: string; content: string }>
): Promise<ScenarioResult> {
  const compressor = new MessageCompressor()
  const ttftSamples: number[] = []
  const endToEndSamples: number[] = []
  const preprocessSamples: number[] = []
  const tokenCountSamples: number[] = []
  const compressorTotalSamples: number[] = []
  const gcPauses: number[] = []
  const originalLog = memoryLogger.log
  memoryLogger.log = () => undefined

  const gcObserver = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
      gcPauses.push(entry.duration)
    }
  })
  gcObserver.observe({ entryTypes: ['gc'] })

  const delay = monitorEventLoopDelay({ resolution: 10 })
  delay.enable()
  const eluStart = performance.eventLoopUtilization()
  const cpuStart = process.cpuUsage()
  const coresStart = snapshotCores()
  const benchmarkStart = performance.now()
  let nextRequest = 0

  try {
    const runRequest = async (): Promise<void> => {
      const requestStart = performance.now()
      if (dynamicCompression) {
        const result = await compressor.compressMessages(messages)
        recordCompressorTiming(result.timing, preprocessSamples, tokenCountSamples, compressorTotalSamples)
      }

      // The fixed delay represents an upstream that emits its first token after
      // accepting the request; the difference between modes is gateway work.
      await sleep(options.upstreamTtftMs)
      ttftSamples.push(performance.now() - requestStart)
      await sleep(options.generationMs)
      endToEndSamples.push(performance.now() - requestStart)
    }

    const workers: Promise<void>[] = []
    for (let workerIndex = 0; workerIndex < options.concurrency; workerIndex++) {
      workers.push((async (): Promise<void> => {
        while (nextRequest < options.requests) {
          nextRequest++
          await runRequest()
        }
      })())
    }
    await Promise.all(workers)
  } finally {
    delay.disable()
    gcObserver.disconnect()
    memoryLogger.log = originalLog
  }

  const wallTimeMs = performance.now() - benchmarkStart
  const elapsedElu = performance.eventLoopUtilization(eluStart)
  const elapsedCpu = process.cpuUsage(cpuStart)
  const systemCpuPerCore = calculateCoreUtilization(coresStart, snapshotCores())
  const processCpuMs = (elapsedCpu.user + elapsedCpu.system) / 1000

  return {
    dynamicCompression,
    completedRequests: endToEndSamples.length,
    wallTimeMs,
    throughputRequestsPerSecond: (endToEndSamples.length * 1000) / wallTimeMs,
    ttft: summarize(ttftSamples),
    endToEnd: summarize(endToEndSamples),
    eventLoop: {
      utilization: elapsedElu.utilization,
      activeMs: elapsedElu.active,
      idleMs: elapsedElu.idle,
      delayP50Ms: delay.percentile(50) / 1e6,
      delayP95Ms: delay.percentile(95) / 1e6,
      delayP99Ms: delay.percentile(99) / 1e6,
      delayMaxMs: delay.max / 1e6,
    },
    processCpu: {
      utilization: wallTimeMs > 0 ? processCpuMs / wallTimeMs : 0,
      userMs: elapsedCpu.user / 1000,
      systemMs: elapsedCpu.system / 1000,
    },
    systemCpuPerCore,
    gcPause: {
      count: gcPauses.length,
      totalMs: gcPauses.reduce((total, value) => total + value, 0),
      p50Ms: percentile(gcPauses, 50),
      p95Ms: percentile(gcPauses, 95),
      maxMs: Math.max(0, ...gcPauses),
    },
    compressor: dynamicCompression
      ? {
          requests: compressorTotalSamples.length,
          preprocessMs: summarize(preprocessSamples),
          tokenCountMs: summarize(tokenCountSamples),
          totalMs: summarize(compressorTotalSamples),
          preprocessShareOfTotal:
            compressorTotalSamples.reduce((total, value) => total + value, 0) > 0
              ? preprocessSamples.reduce((total, value) => total + value, 0) /
                compressorTotalSamples.reduce((total, value) => total + value, 0)
              : 0,
        }
      : undefined,
  }
}

function recordCompressorTiming(
  timing: CompressionTiming,
  preprocessSamples: number[],
  tokenCountSamples: number[],
  totalSamples: number[]
): void {
  preprocessSamples.push(timing.preprocessMs)
  tokenCountSamples.push(timing.tokenCountMs)
  totalSamples.push(timing.totalMs)
}

function formatLatency(summary: LatencySummary): string {
  return `p50=${summary.p50Ms.toFixed(1)}ms p95=${summary.p95Ms.toFixed(1)}ms p99=${summary.p99Ms.toFixed(1)}ms mean=${summary.meanMs.toFixed(1)}ms max=${summary.maxMs.toFixed(1)}ms`
}

function printScenario(result: ScenarioResult): void {
  const mode = result.dynamicCompression ? 'enabled' : 'disabled'
  console.log(`\nDynamic compression: ${mode}`)
  console.log(`  requests=${result.completedRequests} wall=${result.wallTimeMs.toFixed(1)}ms throughput=${result.throughputRequestsPerSecond.toFixed(2)} req/s`)
  console.log(`  TTFT: ${formatLatency(result.ttft)}`)
  console.log(`  End-to-end: ${formatLatency(result.endToEnd)}`)
  console.log(
    `  Event loop: ELU=${(result.eventLoop.utilization * 100).toFixed(1)}% active=${result.eventLoop.activeMs.toFixed(1)}ms ` +
      `delay p50/p95/p99/max=${result.eventLoop.delayP50Ms.toFixed(2)}/${result.eventLoop.delayP95Ms.toFixed(2)}/${result.eventLoop.delayP99Ms.toFixed(2)}/${result.eventLoop.delayMaxMs.toFixed(2)}ms`
  )
  console.log(
    `  Process CPU: utilization=${(result.processCpu.utilization * 100).toFixed(1)}% user=${result.processCpu.userMs.toFixed(1)}ms system=${result.processCpu.systemMs.toFixed(1)}ms`
  )
  console.log(`  System CPU per core: ${result.systemCpuPerCore.map(value => `${value.toFixed(1)}%`).join(', ')}`)
  console.log(
    `  GC pause: count=${result.gcPause.count} total=${result.gcPause.totalMs.toFixed(2)}ms p50=${result.gcPause.p50Ms.toFixed(2)}ms ` +
      `p95=${result.gcPause.p95Ms.toFixed(2)}ms max=${result.gcPause.maxMs.toFixed(2)}ms`
  )
  if (result.compressor) {
    console.log(`  Compressor preprocess: ${formatLatency(result.compressor.preprocessMs)}`)
    console.log(`  Compressor token counting: ${formatLatency(result.compressor.tokenCountMs)}`)
    console.log(`  Compressor total: ${formatLatency(result.compressor.totalMs)}`)
    console.log(`  Preprocess share of compressor CPU wall time: ${(result.compressor.preprocessShareOfTotal * 100).toFixed(1)}%`)
  }
}

function workerPoolRecommendation(result: ScenarioResult): string {
  const compressor = result.compressor
  if (!compressor) return 'not evaluated'
  const isHot = compressor.preprocessMs.p95Ms >= 10 && compressor.preprocessShareOfTotal >= 0.5
  if (!isHot) {
    return 'do not add a Worker Pool: preprocessing is not yet a dominant, material CPU hotspot under this workload.'
  }
  if (result.eventLoop.utilization < 0.7) {
    return 'preprocessing is material, but event-loop saturation is below 70%; profile a production-like run before adding workers.'
  }
  return 'candidate for a bounded Worker Pool: preprocessing p95 is material, dominates compression time, and this run saturated the event loop.'
}

async function main(): Promise<void> {
  const options = parseOptions()
  const messages = buildLongHistory(options)
  console.log('Dynamic compression benchmark (deterministic mock upstream)')
  console.log(`messages=${messages.length} requests=${options.requests} concurrency=${options.concurrency} codeLines=${options.codeLines} warmup=${options.warmupRequests}`)
  console.log('System CPU is machine-wide and may include unrelated processes; isolate the host for trustworthy per-core numbers.')

  if (options.warmupRequests > 0) {
    await runScenario(false, { ...options, requests: options.warmupRequests }, messages)
    await runScenario(true, { ...options, requests: options.warmupRequests }, messages)
  }

  const disabled = await runScenario(false, options, messages)
  const enabled = await runScenario(true, options, messages)
  printScenario(disabled)
  printScenario(enabled)
  console.log(`\nWorker Pool decision: ${workerPoolRecommendation(enabled)}`)
  console.log('This is a reproducible request-path microbenchmark, not a provider/network benchmark. Validate the same metrics against a production-like gateway deployment before changing the execution model.')
}

main().catch(error => {
  console.error('Benchmark failed:', error)
  process.exitCode = 1
})
