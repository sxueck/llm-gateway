const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Shanghai is UTC+8

export function getShanghaiDayStart(daysOffset: number = 0): number {
  const now = new Date();
  const shanghaiNow = new Date(now.getTime() + SHANGHAI_OFFSET_MS);

  // Calculate the target day in Shanghai timezone
  const targetDate = new Date(shanghaiNow);
  targetDate.setUTCDate(targetDate.getUTCDate() + daysOffset);
  targetDate.setUTCHours(0, 0, 0, 0);

  // Convert back to UTC timestamp (milliseconds)
  return targetDate.getTime() - SHANGHAI_OFFSET_MS;
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

export function generateShanghaiDayBuckets(startTime: number, endTime: number): number[] {
  const dayMs = 24 * 60 * 60 * 1000;
  const timePoints: number[] = [];

  // Convert to Shanghai time, find the day boundary, then convert back to UTC
  // First Shanghai day boundary at or after startTime
  const shanghaiStart = startTime + SHANGHAI_OFFSET_MS;
  let currentShanghaiDay = Math.floor(shanghaiStart / dayMs) * dayMs;
  const shanghaiEnd = endTime + SHANGHAI_OFFSET_MS;
  const endShanghaiDay = Math.floor(shanghaiEnd / dayMs) * dayMs;

  while (currentShanghaiDay <= endShanghaiDay) {
    // Convert Shanghai day start back to UTC timestamp
    timePoints.push(currentShanghaiDay - SHANGHAI_OFFSET_MS);
    currentShanghaiDay += dayMs;
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
