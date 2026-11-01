import { FastifyReply, FastifyRequest } from 'fastify';
import { getDateKeyInTz, getDayStartOfDateKeyInTz } from '../../db/utils/time-buckets.js';
import { gatewayTimezone } from '../../services/gateway-timezone.js';
import { memoryLogger } from '../../services/logger.js';
import { virtualKeyQuota } from '../../services/virtual-key-quota.js';
import type { VirtualKeyQuotaEntry } from '../../services/virtual-key-quota.js';
import { authenticateVirtualKey, extractVirtualKeyAuthHeader } from './auth.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKENS_PER_M = 1_000_000;

export interface ModelQuotaPeriodSummary {
  limit_millions: number;
  limit_tokens: number;
  used_tokens: number;
  remaining_tokens: number;
  request_count: number;
  resets_at: string;
}

export interface ModelQuotaSummaryEntry {
  object: 'model_quota';
  model: string;
  daily: ModelQuotaPeriodSummary | null;
  weekly: ModelQuotaPeriodSummary | null;
}

export interface VirtualKeyQuotaSummary {
  timezone: string;
  data: ModelQuotaSummaryEntry[];
}

function plusDays(dateKey: string, days: number): string {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

function mondayOfDateKey(dateKey: string): string {
  const day = new Date(`${dateKey}T00:00:00Z`);
  const monday = day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY_MS;
  return new Date(monday).toISOString().slice(0, 10);
}

export function buildQuotaPeriodSummary(
  limitMillions: number | null | undefined,
  usedTokens: number,
  requestCount: number,
  resetsAt: number,
): ModelQuotaPeriodSummary | null {
  // 0 / null means "no ceiling configured" — same contract as the admin
  // quota views, so unset dimensions surface as null instead of a fake 0 cap.
  if (limitMillions == null || limitMillions <= 0) return null;
  const limitTokens = Math.round(limitMillions * TOKENS_PER_M);
  return {
    limit_millions: limitMillions,
    limit_tokens: limitTokens,
    used_tokens: usedTokens,
    // A request can overshoot the budget; the remaining allowance cannot be negative.
    remaining_tokens: Math.max(0, limitTokens - usedTokens),
    request_count: requestCount,
    resets_at: new Date(resetsAt).toISOString(),
  };
}

/**
 * Shape the quota service snapshot into the client-facing summary. Period
 * boundaries mirror `VirtualKeyQuotaService.check`: gateway-timezone natural
 * days, weeks Monday-based, week-to-date spanning Monday..today.
 */
export function buildQuotaSummary(
  entries: VirtualKeyQuotaEntry[],
  now: number,
  timeZone: string,
): VirtualKeyQuotaSummary {
  const today = getDateKeyInTz(now, timeZone);
  const dailyResetsAt = getDayStartOfDateKeyInTz(plusDays(today, 1), timeZone);
  const weeklyResetsAt = getDayStartOfDateKeyInTz(plusDays(mondayOfDateKey(today), 7), timeZone);
  return {
    timezone: timeZone,
    data: entries.map((entry) => ({
      object: 'model_quota',
      model: entry.model,
      daily: buildQuotaPeriodSummary(entry.limitMillions, entry.usedTokens, entry.requestCount, dailyResetsAt),
      weekly: buildQuotaPeriodSummary(
        entry.weeklyLimitMillions,
        entry.weeklyUsedTokens,
        entry.weeklyRequestCount,
        weeklyResetsAt,
      ),
    })),
  };
}

// Config read errors surface as 500; usage reads follow enforcement's fail-open behavior.
export async function getQuotaSummaryHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    const resolvedAuthHeader = extractVirtualKeyAuthHeader(request.headers as any);
    const authResult = await authenticateVirtualKey(resolvedAuthHeader);
    if ('error' in authResult) {
      return reply.code(authResult.error.code).send(authResult.error.body);
    }

    const { virtualKey, virtualKeyValue } = authResult;
    const now = Date.now();
    const entries = await virtualKeyQuota.snapshot(virtualKey.id, now);
    const summary = buildQuotaSummary(entries, now, gatewayTimezone.get());

    memoryLogger.info(
      `Quota summary query: virtual key ${virtualKeyValue.slice(0, 6)}...${virtualKeyValue.slice(-4)} | ${summary.data.length} configured model(s)`,
      'Proxy'
    );

    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Type', 'application/json');
    return reply.send({
      object: 'virtual_key_quota_summary',
      ...summary,
    });
  } catch (error: any) {
    memoryLogger.error(
      `Quota summary query failed: ${error.message}`,
      'Proxy',
      { error: error.stack }
    );

    return reply.code(500).send({
      error: {
        message: 'Failed to query quota summary',
        type: 'internal_error',
        param: null,
        code: 'quota_summary_error'
      }
    });
  }
}
