import { gatewayTimezone } from "../../services/gateway-timezone.js";

const DAY_MS = 24 * 60 * 60 * 1000;

interface TzWallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

// Intl.DateTimeFormat construction is expensive while formatToParts is not;
// the quota hot path resolves day boundaries per request, so cache one
// formatter per zone.
const wallFormatters = new Map<string, Intl.DateTimeFormat>();

function getWallFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = wallFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    wallFormatters.set(timeZone, formatter);
  }
  return formatter;
}

function getWallClockInTz(timestampMs: number, timeZone: string): TzWallClock {
  const parts = getWallFormatter(timeZone).formatToParts(
    new Date(timestampMs),
  );
  const byType: Record<string, string> = {};
  for (const part of parts) {
    byType[part.type] = part.value;
  }
  // Some ICU builds render midnight as hour "24"; normalize to 0.
  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
    hour: Number(byType.hour) % 24,
    minute: Number(byType.minute),
    second: Number(byType.second),
  };
}

function wallClockToUtcMs(wall: TzWallClock): number {
  return Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second,
  );
}

/** Offset of `timeZone` at `timestampMs`: wall clock minus UTC, in ms. */
function getTimeZoneOffsetMs(timestampMs: number, timeZone: string): number {
  const wholeSecondMs = Math.floor(timestampMs / 1000) * 1000;
  return (
    wallClockToUtcMs(getWallClockInTz(wholeSecondMs, timeZone)) -
    wholeSecondMs
  );
}

/** 'YYYY-MM-DD' calendar day in `timeZone` — the key of daily rows. */
export function getDateKeyInTz(
  timestampMs: number,
  timeZone: string,
): string {
  const wall = getWallClockInTz(timestampMs, timeZone);
  const month = String(wall.month).padStart(2, "0");
  const day = String(wall.day).padStart(2, "0");
  return `${wall.year}-${month}-${day}`;
}

/**
 * UTC-ms instant of wall-clock midnight in `timeZone` for the given calendar
 * date. Two offset passes, so a DST transition between the naive UTC guess and
 * the real day start still lands on the same calendar date. Zones with no
 * 00:00 on a transition day resolve to the nearest instant.
 */
export function getDayStartOfDateKeyInTz(
  dateKey: string,
  timeZone: string,
): number {
  const naiveUtcMidnight = Date.parse(`${dateKey}T00:00:00Z`);
  const firstGuess =
    naiveUtcMidnight - getTimeZoneOffsetMs(naiveUtcMidnight, timeZone);
  return naiveUtcMidnight - getTimeZoneOffsetMs(firstGuess, timeZone);
}

export function getDayStartOfInTz(
  timestampMs: number,
  timeZone: string,
): number {
  return getDayStartOfDateKeyInTz(
    getDateKeyInTz(timestampMs, timeZone),
    timeZone,
  );
}

export function getDateKey(timestampMs: number = Date.now()): string {
  return getDateKeyInTz(timestampMs, gatewayTimezone.get());
}

export function getDayStartOf(timestampMs: number): number {
  return getDayStartOfInTz(timestampMs, gatewayTimezone.get());
}

/** Midnight of the gateway-timezone day `daysOffset` from today. */
export function getDayStart(daysOffset: number = 0): number {
  return getDayStartOfInTz(
    Date.now() + daysOffset * DAY_MS,
    gatewayTimezone.get(),
  );
}

/** Calendar date key one day after `dateKey` (Date.UTC normalizes overflow). */
function nextDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1))
    .toISOString()
    .slice(0, 10);
}

/** Day-start buckets in `timeZone` covering [startTime, endTime]. */
export function generateDayBucketsInTz(
  startTime: number,
  endTime: number,
  timeZone: string,
): number[] {
  const buckets: number[] = [];
  let dateKey = getDateKeyInTz(startTime, timeZone);
  let cursor = getDayStartOfDateKeyInTz(dateKey, timeZone);
  while (cursor <= endTime) {
    buckets.push(cursor);
    // Advance the calendar date itself (not cursor + DAY_MS): a DST day is
    // 23h or 25h, so midnight + 24h can stay inside the same day and stall
    // the loop.
    dateKey = nextDateKey(dateKey);
    cursor = getDayStartOfDateKeyInTz(dateKey, timeZone);
  }
  return buckets;
}

export function generateDayBuckets(
  startTime: number,
  endTime: number,
): number[] {
  return generateDayBucketsInTz(startTime, endTime, gatewayTimezone.get());
}

/**
 * Half-open [start, end) aggregation bucket keyed by its start instant.
 * Repositories assign rows with a range join (`ts >= start AND ts < end`), so
 * ANY boundary set is exact — UTC hours, fixed-offset days, DST 23h/25h local
 * days, sub-hour (+05:30/+05:45) midnights — where the previous
 * `FLOOR((ts + offset) / N) * N - offset` form matched only one fixed UTC
 * offset and silently mis-bucketed every other zone.
 */
export interface BucketBoundary {
  start: number;
  end: number;
}

/**
 * Contiguous local-day buckets covering [startTime, endTime]. The last
 * bucket's end is the midnight after `endTime` (may lie beyond it); readers
 * clamp to their own window. Pass `endTime - 1` to exclude a day whose
 * midnight coincides with `endTime`.
 */
export function generateDayBucketBoundariesInTz(
  startTime: number,
  endTime: number,
  timeZone: string,
): BucketBoundary[] {
  const starts = generateDayBucketsInTz(startTime, endTime, timeZone);
  return starts.map((start, i) => ({
    start,
    end:
      i + 1 < starts.length
        ? starts[i + 1]
        : // Next local midnight, never start + DAY_MS (see generateDayBucketsInTz).
          getDayStartOfDateKeyInTz(
            nextDateKey(getDateKeyInTz(start, timeZone)),
            timeZone,
          ),
  }));
}

export function generateTimeBuckets(startTime: number, endTime: number, intervalMs: number): number[] {
  const timePoints: number[] = [];
  let currentTime = Math.floor(startTime / intervalMs) * intervalMs;
  const endBucket = Math.floor(endTime / intervalMs) * intervalMs;

  while (currentTime <= endBucket) {
    timePoints.push(currentTime);
    currentTime += intervalMs;
  }

  return timePoints;
}

export function initializeTimeBuckets(timePoints: number[]): Map<number, any> {
  const buckets = new Map<number, any>();
  timePoints.forEach(time => {
    buckets.set(time, {
      timestamp: time,
      requestCount: 0,
      successCount: 0,
      errorCount: 0,
      tokenCount: 0
    });
  });
  return buckets;
}
