import { describe, expect, it, vi } from 'vitest';
import type { OpsDimensionListResponse } from '@/api/ops-metrics';
import type { Model, VirtualKey } from '@/types';
import {
  collectBoundModelIds,
  createVirtualKeyMetricsLoader,
  fetchAllVirtualKeyMetrics,
  filterVirtualKeys,
  resolveFirstModelIdentifier,
} from './virtual-key-helpers';

function vk(partial: Partial<VirtualKey> & { id: string }): VirtualKey {
  return {
    keyValue: 'vk-test-' + partial.id,
    name: partial.id,
    enabled: true,
    cacheEnabled: false,
    disableLogging: false,
    contextBudgetTokens: null,
    imageCompressionEnabled: false,
    interceptZeroTemperature: false,
    piiProtectionEnabled: false,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  } as VirtualKey;
}

const models: Model[] = [
  { id: 'm1', name: 'Sonnet', modelIdentifier: 'anthropic/claude-sonnet-4', providerId: 'p1' } as Model,
  { id: 'm2', name: 'GPT Custom', modelIdentifier: 'openai/gpt-4o', providerId: 'p2' } as Model,
];

const modelNameOf = (id: string) => models.find((m) => m.id === id)?.name;

describe('collectBoundModelIds', () => {
  it('merges legacy modelId with modelIds and dedupes', () => {
    expect(collectBoundModelIds(vk({ id: 'a', modelId: 'm1', modelIds: ['m2', 'm1'] }))).toEqual([
      'm1',
      'm2',
    ]);
  });

  it('returns empty array when nothing is bound', () => {
    expect(collectBoundModelIds(vk({ id: 'a' }))).toEqual([]);
  });
});

describe('resolveFirstModelIdentifier', () => {
  it('uses the first resolvable bound model identifier, not its display name', () => {
    const key = vk({ id: 'a', modelId: 'ghost', modelIds: ['missing', 'm2'] });
    expect(resolveFirstModelIdentifier(key, models)).toBe('openai/gpt-4o');
  });

  it('returns null when no bound model resolves', () => {
    expect(resolveFirstModelIdentifier(vk({ id: 'a', modelIds: ['nope'] }), models)).toBeNull();
  });

  it('skips models whose modelIdentifier is empty instead of returning an unusable value', () => {
    const withEmpty = [
      { id: 'm0', name: 'Empty', modelIdentifier: '', providerId: 'p0' } as Model,
      ...models,
    ];
    const key = vk({ id: 'a', modelIds: ['m0', 'm1'] });
    expect(resolveFirstModelIdentifier(key, withEmpty)).toBe('anthropic/claude-sonnet-4');
    expect(resolveFirstModelIdentifier(vk({ id: 'b', modelIds: ['m0'] }), withEmpty)).toBeNull();
  });
});

describe('filterVirtualKeys', () => {
  const keys = [
    vk({ id: 'prod', name: '生产环境', keyValue: 'vk-prod-1', modelIds: ['m1'] }),
    vk({ id: 'ci', name: 'CI', keyValue: 'vk-ci-2', modelIds: ['m2'], enabled: false }),
    vk({ id: 'legacy', name: 'Legacy', keyValue: 'vk-old-3', modelId: 'm1' }),
  ];

  it('empty search plus all keeps everything', () => {
    expect(filterVirtualKeys(keys, {})).toHaveLength(3);
  });

  it('matches name, key value, bound model id and model name case-insensitively', () => {
    expect(filterVirtualKeys(keys, { search: '生产' }, modelNameOf)).toHaveLength(1);
    expect(filterVirtualKeys(keys, { search: 'VK-CI' }, modelNameOf)).toHaveLength(1);
    expect(filterVirtualKeys(keys, { search: 'm2' }, modelNameOf)).toHaveLength(1);
    expect(filterVirtualKeys(keys, { search: 'gpt custom' }, modelNameOf)).toHaveLength(1);
    expect(filterVirtualKeys(keys, { search: 'ghost' }, modelNameOf)).toHaveLength(0);
  });

  it('enabled filter narrows without touching search', () => {
    expect(filterVirtualKeys(keys, { enabled: 'disabled' })).toEqual([keys[1]]);
    expect(filterVirtualKeys(keys, { enabled: 'enabled', search: 'ci' })).toEqual([]);
  });
});

function page(items: Array<Partial<OpsDimensionListResponse['items'][number]>>, pageMeta: {
  page: number;
  total: number;
}): OpsDimensionListResponse {
  return {
    window: { startTime: 0, endTime: 111, timezone: 'Asia/Shanghai' },
    updatedAt: 0,
    dimension: 'virtualKey',
    dataCoverage: { detailStart: 0, hourlyFrom: null, hourlyTo: null, gaps: [], exact: true },
    pagination: { page: pageMeta.page, pageSize: 100, total: pageMeta.total, totalPages: 1 },
    items: items.map((item) => ({
      id: null,
      name: '',
      maskedKey: null,
      requestCount: 0,
      successCount: 0,
      failureCount: 0,
      successRate: null,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      cacheHitCount: 0,
      promptCacheHitCount: 0,
      avgTffbMs: null,
      validTffbCount: 0,
      avgResponseTimeMs: null,
      validResponseTimeCount: 0,
      avgOutputSpeed: null,
      validSpeedCount: 0,
      lastUsedAt: null,
      ...item,
    })) as OpsDimensionListResponse['items'],
  } as OpsDimensionListResponse;
}

function makeApi(pages: OpsDimensionListResponse[]) {
  const calls: Array<{ page: number; endTime: number }> = [];
  const api = vi.fn(async (_dim: 'virtualKey', query: { page?: number; endTime?: number }) => {
    calls.push({ page: query.page ?? 1, endTime: query.endTime ?? 0 });
    return pages[(query.page ?? 1) - 1] ?? page([], { page: query.page ?? 1, total: 0 });
  });
  return { api, calls };
}

describe('fetchAllVirtualKeyMetrics', () => {
  it('pages at the requested size until pagination.total is covered, pinning one endTime', async () => {
    const items = (n: number, offset: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `k${offset + i}`, requestCount: offset + i }));
    const { api, calls } = makeApi([
      page(items(100, 0), { page: 1, total: 250 }),
      page(items(100, 100), { page: 2, total: 250 }),
      page(items(50, 200), { page: 3, total: 250 }),
    ]);
    const result = await fetchAllVirtualKeyMetrics('7d', {
      api: api as never,
      now: () => 123456,
    });
    expect(calls.map((c) => c.page)).toEqual([1, 2, 3]);
    expect(new Set(calls.map((c) => c.endTime))).toEqual(new Set([123456]));
    expect(Object.keys(result.byId)).toHaveLength(250);
    expect(result.endTime).toBe(123456);
    expect(result.truncated).toBe(false);
    expect(result.hasCoverageGaps).toBe(false);
  });

  it('fetches the pages after the first concurrently, not one round trip at a time', async () => {
    const items = (offset: number) =>
      Array.from({ length: 100 }, (_, i) => ({ id: `k${offset + i}` }));
    let inFlight = 0;
    let maxInFlight = 0;
    const api = vi.fn(async (_dim: 'virtualKey', query: { page?: number }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // A serial loop never overlaps, so the yield is what the assertion observes.
      await Promise.resolve();
      inFlight -= 1;
      const p = query.page ?? 1;
      return page(items((p - 1) * 100), { page: p, total: 300 });
    });

    const result = await fetchAllVirtualKeyMetrics('24h', { api: api as never, now: () => 1 });

    expect(maxInFlight).toBeGreaterThan(1);
    expect(Object.keys(result.byId)).toHaveLength(300);
    expect(result.truncated).toBe(false);
  });

  it('marks truncated when the page cap stops before total', async () => {
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `k${i}` }));
    const { api, calls } = makeApi([
      page(items(100), { page: 1, total: 5000 }),
      page(items(100), { page: 2, total: 5000 }),
    ]);
    const result = await fetchAllVirtualKeyMetrics('30d', {
      api: api as never,
      maxPages: 2,
      now: () => 1,
    });
    expect(calls).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('skips null-id (deleted key) rows from the join but keeps paging progress', async () => {
    const { api } = makeApi([page([{ id: null, name: '已删除密钥 (x)' }, { id: 'k1' }], { page: 1, total: 2 })]);
    const result = await fetchAllVirtualKeyMetrics('24h', { api: api as never, now: () => 1 });
    expect(Object.keys(result.byId)).toEqual(['k1']);
    expect(result.truncated).toBe(false);
  });

  it('propagates api failures instead of fabricating zeros', async () => {
    const api = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(fetchAllVirtualKeyMetrics('24h', { api: api as never, now: () => 1 })).rejects.toThrow('boom');
  });

  it('reports coverage gaps from the backend dataCoverage', async () => {
    const response = page([{ id: 'k1' }], { page: 1, total: 1 });
    response.dataCoverage = {
      detailStart: 0,
      hourlyFrom: 1,
      hourlyTo: 2,
      gaps: [{ from: 3, to: 4 }],
      exact: false,
    };
    const api = vi.fn(async () => response);
    const result = await fetchAllVirtualKeyMetrics('7d', { api: api as never, now: () => 1 });
    expect(result.hasCoverageGaps).toBe(true);
  });

  it('ORs coverage gaps across pages instead of letting a later clean page erase them', async () => {
    const gappy = page([{ id: 'k1' }], { page: 1, total: 2 });
    gappy.dataCoverage = {
      detailStart: 0,
      hourlyFrom: null,
      hourlyTo: null,
      gaps: [{ from: 10, to: 20 }],
      exact: true,
    };
    const clean = page([{ id: 'k2' }], { page: 2, total: 2 });
    clean.dataCoverage = {
      detailStart: 0,
      hourlyFrom: null,
      hourlyTo: null,
      gaps: [],
      exact: true,
    };
    const { api } = makeApi([gappy, clean]);
    const result = await fetchAllVirtualKeyMetrics('7d', { api: api as never, now: () => 1 });
    expect(result.hasCoverageGaps).toBe(true);
  });

  it('flags a possible backend dimension-cap truncation when total reaches the cap even if every page was fetched', async () => {
    // 20 full pages of 100 cover pagination.total = 2000 completely, yet the
    // total equals the backend per-segment DIMENSION_LIMIT, so keys dropped by
    // per-segment capping before merging cannot be ruled out.
    const pages = Array.from({ length: 20 }, (_, p) =>
      page(
        Array.from({ length: 100 }, (_, i) => ({ id: `k${p * 100 + i}`, requestCount: 1 })),
        { page: p + 1, total: 2000 },
      ),
    );
    const { api } = makeApi(pages);
    const result = await fetchAllVirtualKeyMetrics('30d', { api: api as never, now: () => 1 });
    expect(Object.keys(result.byId)).toHaveLength(2000);
    expect(result.truncated).toBe(false);
    expect(result.backendCapHit).toBe(true);
  });

  it('does not flag the backend cap for totals below the limit', async () => {
    const { api } = makeApi([page([{ id: 'k1' }], { page: 1, total: 1999 })]);
    const result = await fetchAllVirtualKeyMetrics('24h', { api: api as never, now: () => 1 });
    expect(result.backendCapHit).toBe(false);
  });
});

describe('createVirtualKeyMetricsLoader stale guard', () => {
  it('discards a slow first response that lands after a newer request', async () => {
    let resolveFirst: (value: OpsDimensionListResponse) => void;
    const first = new Promise<OpsDimensionListResponse>((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;
    const api = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? first : page([{ id: 'fresh' }], { page: 1, total: 1 });
    });
    const load = createVirtualKeyMetricsLoader(api as never);

    const slow = load('24h');
    const fast = load('7d');
    resolveFirst!(page([{ id: 'slow' }], { page: 1, total: 1 }));

    const [slowOutcome, fastOutcome] = await Promise.all([slow, fast]);
    expect(slowOutcome.stale).toBe(true);
    expect(fastOutcome.stale).toBe(false);
    expect(fastOutcome.byId['fresh']).toBeDefined();
  });

  it('marks a late failure of a superseded request as stale instead of throwing', async () => {
    let rejectFirst: (error: Error) => void;
    const first = new Promise<OpsDimensionListResponse>((_, reject) => {
      rejectFirst = reject;
    });
    let calls = 0;
    const api = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? first : page([], { page: 1, total: 0 });
    });
    const load = createVirtualKeyMetricsLoader(api as never);

    const slow = load('24h');
    const fast = load('24h');
    rejectFirst!(new Error('late network error'));

    const [slowOutcome, fastOutcome] = await Promise.all([slow, fast]);
    expect(slowOutcome.stale).toBe(true);
    expect(fastOutcome.stale).toBe(false);
  });
});
