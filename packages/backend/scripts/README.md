# Backend performance scripts

## Dynamic compression benchmark

```bash
bun run benchmark:dynamic-compression
```

The benchmark compares dynamic compression disabled and enabled under concurrent, long-context requests. It measures:

- TTFT and end-to-end latency (`p50`, `p95`, `p99`, mean, max)
- Event Loop Utilization and event-loop delay histogram
- process CPU time and machine-wide CPU utilization for every core
- observed GC pause count, total, `p50`, `p95`, and max
- message-compressor preprocessing, token-counting, and total-time breakdown

The workload uses repeated fenced code blocks because those exercise the compressor's fingerprint and replacement paths. The upstream is deterministic: it waits for a configured first-token delay and generation delay after gateway preprocessing, so mode differences isolate gateway CPU work rather than provider/network variance.

Tune the workload when reproducing a production issue:

```bash
bun run benchmark:dynamic-compression -- \
  --requests=240 \
  --concurrency=24 \
  --history-turns=32 \
  --code-lines=160 \
  --upstream-ttft-ms=15 \
  --generation-ms=25
```

`systemCpuPerCore` is sampled from `os.cpus()` and is machine-wide; run on an otherwise idle host for trustworthy per-core values. The script only recommends evaluating a bounded Worker Pool when preprocessing is both material (`p95 >= 10ms`, at least 50% of compressor time) and the Event Loop Utilization is at least 70%. It does not add a Worker Pool automatically.

This is a reproducible request-path microbenchmark, not an external-provider benchmark. Before changing the deployment execution model, repeat the same measurements against a production-like gateway deployment with representative provider latency, MySQL load, request logging, and traffic mix.
