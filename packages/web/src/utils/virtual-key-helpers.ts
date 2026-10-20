import { opsMetricsApi } from '@/api/ops-metrics';
import type { OpsDimensionItem, OpsDimensionListResponse, OpsPeriod } from '@/api/ops-metrics';
import type { Model, VirtualKey } from '@/types';

/** Merges the legacy single-model field modelId with the batch modelIds, deduped. */
export function collectBoundModelIds(virtualKey: VirtualKey): string[] {
  const ids: string[] = [];
  if (virtualKey.modelId) ids.push(virtualKey.modelId);
  if (Array.isArray(virtualKey.modelIds)) ids.push(...virtualKey.modelIds);
  return [...new Set(ids)];
}

export function resolveFirstModelIdentifier(
  virtualKey: VirtualKey,
  models: Model[],
): string | null {
  for (const id of collectBoundModelIds(virtualKey)) {
    const model = models.find((m) => m.id === id);
    if (model?.modelIdentifier) return model.modelIdentifier;
  }
  return null;
}

export type VirtualKeyEnabledFilter = 'all' | 'enabled' | 'disabled';

export interface VirtualKeyFilterCriteria {
  search?: string;
  enabled?: VirtualKeyEnabledFilter;
}

export function filterVirtualKeys(
  keys: VirtualKey[],
  criteria: VirtualKeyFilterCriteria,
  modelNameOf?: (modelId: string) => string | null | undefined,
): VirtualKey[] {
  const needle = (criteria.search ?? '').trim().toLowerCase();
  return keys.filter((key) => {
    if (criteria.enabled === 'enabled' && !key.enabled) return false;
    if (criteria.enabled === 'disabled' && key.enabled) return false;
    if (!needle) return true;
    if (key.name?.toLowerCase().includes(needle)) return true;
    if (key.keyValue?.toLowerCase().includes(needle)) return true;
    for (const modelId of collectBoundModelIds(key)) {
      if (modelId.toLowerCase().includes(needle)) return true;
      const name = modelNameOf?.(modelId);
      if (name && name.toLowerCase().includes(needle)) return true;
    }
    return false;
  });
}

/**
 * Limit: backend services/ops-metrics.ts keeps at most DIMENSION_LIMIT = 2000
 * dimension keys per window segment, and single-page pageSize is clamped to
 * [1,100]. So the client fetches 100/page with a 20-page ceiling; anything not
 * fetched is reported as truncated — never silently presented as complete.
 */
export const VK_METRICS_PAGE_SIZE = 100;
export const VK_METRICS_MAX_PAGES = 20;

/**
 * Mirrors the backend per-segment DIMENSION_LIMIT. Even when pagination.total
 * equals this cap and every page was fetched, per-segment capping may have
 * dropped dimension keys before they could be merged, so the outcome is flagged
 * instead of pretending the data set is complete.
 */
export const VK_METRICS_BACKEND_DIMENSION_LIMIT = 2000;

/** Upper bound on simultaneous dimension requests; page 1 alone decides the window. */
const VK_METRICS_PAGE_POOL = 4;

export interface VirtualKeyMetricsData {
  byId: Record<string, OpsDimensionItem>;
  /** Sampling end (ms) shared by all pages of this fetch. */
  endTime: number;
  /** Stopped early at the page cap; dimension keys are still missing. */
  truncated: boolean;
  /** pagination.total reached the backend per-segment cap; entries may be hidden. */
  backendCapHit: boolean;
  /** Backend dataCoverage reported gaps or non-exact aggregation on any page. */
  hasCoverageGaps: boolean;
}

export interface VirtualKeyMetricsOutcome extends VirtualKeyMetricsData {
  /** true when this result was superseded by a newer request; the caller must discard it. */
  stale: boolean;
}

type GetDimensionList = typeof opsMetricsApi.getDimensionList;

export interface FetchMetricsOptions {
  pageSize?: number;
  maxPages?: number;
  api?: GetDimensionList;
  now?: () => number;
}

export async function fetchAllVirtualKeyMetrics(
  period: OpsPeriod,
  options: FetchMetricsOptions = {},
): Promise<VirtualKeyMetricsData> {
  const api = options.api ?? opsMetricsApi.getDimensionList.bind(opsMetricsApi);
  const pageSize = Math.min(Math.max(options.pageSize ?? VK_METRICS_PAGE_SIZE, 1), 100);
  const maxPages = Math.max(options.maxPages ?? VK_METRICS_MAX_PAGES, 1);
  const endTime = Math.floor((options.now ?? Date.now)());

  const byId: Record<string, OpsDimensionItem> = {};
  let expectedTotal = Number.POSITIVE_INFINITY;
  let received = 0;
  let backendCapHit = false;
  let hasCoverageGaps = false;

  const absorb = (response: OpsDimensionListResponse): number => {
    // Coverage is OR-ed across pages: a gap on any page invalidates the whole window.
    const coverage = response.dataCoverage;
    if (coverage) {
      hasCoverageGaps = hasCoverageGaps || coverage.gaps.length > 0 || coverage.exact === false;
    }
    const total = response.pagination?.total ?? 0;
    backendCapHit = backendCapHit || total >= VK_METRICS_BACKEND_DIMENSION_LIMIT;
    expectedTotal = Number.isFinite(expectedTotal) ? Math.max(expectedTotal, total) : total;
    received += response.items.length;
    for (const item of response.items) {
      // Rows with a null id are deleted keys that cannot join back to the list;
      // skip them from the map but still count them toward paging progress.
      if (item.id) byId[item.id] = item;
    }
    return response.items.length;
  };

  const requestPage = (page: number) => api('virtualKey', { period, endTime, page, pageSize });

  const firstPageCount = absorb(await requestPage(1));
  // One round trip per page would serialize up to 20 requests for a 30d window; page 1
  // already publishes pagination.total, so the remaining pages are known and independent.
  const lastPage = Math.min(maxPages, Math.max(1, Math.ceil(expectedTotal / pageSize)));
  if (firstPageCount > 0) {
    for (let start = 2; start <= lastPage; start += VK_METRICS_PAGE_POOL) {
      const end = Math.min(start + VK_METRICS_PAGE_POOL - 1, lastPage);
      const responses = await Promise.all(
        Array.from({ length: end - start + 1 }, (_, i) => requestPage(start + i)),
      );
      // Absorb every response before deciding, then stop on an empty batch: the total
      // can shrink between windows and an exhausted page means there is nothing left.
      const counts = responses.map((response) => absorb(response));
      if (!counts.some((count) => count > 0)) break;
    }
  }

  return {
    byId,
    endTime,
    truncated: received < expectedTotal,
    backendCapHit,
    hasCoverageGaps,
  };
}

/**
 * Loader with stale-guard: each call increments a token; results of an older
 * request (success or failure) that land after a newer one are marked stale for
 * the caller to discard.
 */
export function createVirtualKeyMetricsLoader(getDimensionList?: GetDimensionList) {
  const api = getDimensionList ?? opsMetricsApi.getDimensionList.bind(opsMetricsApi);
  let token = 0;
  return async (period: OpsPeriod, options?: FetchMetricsOptions): Promise<VirtualKeyMetricsOutcome> => {
    const mine = ++token;
    try {
      const data = await fetchAllVirtualKeyMetrics(period, { ...options, api });
      return { ...data, stale: mine !== token };
    } catch (error) {
      if (mine !== token) {
        return {
          byId: {},
          endTime: 0,
          truncated: false,
          backendCapHit: false,
          hasCoverageGaps: false,
          stale: true,
        };
      }
      throw error;
    }
  };
}
