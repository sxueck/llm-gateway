import { expect, test } from 'vitest';

import {
  buildFeatureVector,
  detectPeaks,
  predict,
  predictWeeklyEmpirical,
  trainRidge,
  trainWeeklyEmpirical,
} from './traffic-prediction.js';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const SHANGHAI_OFFSET = 8 * HOUR;

// Returns the UTC ms for a given Shanghai-local hour on a known date.
function shanghaiHour(dayUtcMidnight: number, localHour: number): number {
  return dayUtcMidnight + localHour * HOUR - SHANGHAI_OFFSET;
}

function daySamples(dayUtcMidnight: number, isWorkday: boolean, profile: number[]) {
  return profile.map((count, hour) => ({
    timestampMs: shanghaiHour(dayUtcMidnight, hour),
    count,
    isWorkday,
  }));
}

test('buildFeatureVector returns the expected model feature count', () => {
  expect(buildFeatureVector(Date.UTC(2026, 0, 1), true)).toHaveLength(8);
});

test('trainRidge ignores invalid counts and keeps predictions finite', () => {
  const base = Date.UTC(2026, 0, 1);
  const samples = [
    { timestampMs: base, count: 10, isWorkday: true },
    { timestampMs: base + 3600000, count: Number.NaN, isWorkday: true },
    { timestampMs: base + 2 * 3600000, count: Number.POSITIVE_INFINITY, isWorkday: true },
    { timestampMs: base + 3 * 3600000, count: -1, isWorkday: true },
  ];

  const theta = trainRidge(samples);
  const prediction = predict(theta, base, true);

  expect(theta).toHaveLength(8);
  expect(theta.every(Number.isFinite)).toBe(true);
  expect(Number.isFinite(prediction)).toBe(true);
});

test('detectPeaks returns peak windows for clear local surges', () => {
  const base = Date.UTC(2026, 0, 1);
  const predictions = [10, 12, 30, 11, 10].map((predictedCount, index) => ({
    timestamp: base + index * 3600000,
    predictedCount,
    isPeak: false,
    peakScore: 0,
    isWorkday: true,
  }));

  const peaks = detectPeaks(predictions);

  expect(peaks).toHaveLength(1);
  expect(peaks[0]).toMatchObject({
    peakTimestamp: base + 2 * 3600000,
    peakCount: 30,
  });
});

test('trainWeeklyEmpirical reproduces a bimodal shape and keeps nights at zero', () => {
  const start = Date.UTC(2026, 0, 5); // Monday
  const profile = [0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 10, 80, 80, 30, 70, 70, 70, 70, 60, 15, 10, 5, 0, 0];

  // 14 identical days: every shrinkage level agrees, so the learned profile is exact.
  const samples = Array.from({ length: 14 }, (_, d) => daySamples(start + d * DAY, true, profile)).flat();
  const model = trainWeeklyEmpirical(samples);

  expect(predictWeeklyEmpirical(model, shanghaiHour(start, 11), true)).toBeCloseTo(80, 5);
  expect(predictWeeklyEmpirical(model, shanghaiHour(start, 13), true)).toBeCloseTo(30, 5);
  expect(predictWeeklyEmpirical(model, shanghaiHour(start, 16), true)).toBeCloseTo(70, 5);
  expect(predictWeeklyEmpirical(model, shanghaiHour(start, 3), true)).toBe(0);
});

test('weekly model learns a night-shifted regime without any daytime assumption', () => {
  const start = Date.UTC(2026, 0, 5);
  // Night worker: peak at 02:00, daytime quiet. No workday/daytime prior is hardcoded.
  const nightProfile = Array.from({ length: 24 }, (_, h) => (h === 2 ? 90 : h === 14 ? 0 : 0));
  const samples = Array.from({ length: 14 }, (_, d) => daySamples(start + d * DAY, true, nightProfile)).flat();
  const model = trainWeeklyEmpirical(samples);

  expect(predictWeeklyEmpirical(model, shanghaiHour(start, 2), true)).toBeCloseTo(90, 5);
  expect(predictWeeklyEmpirical(model, shanghaiHour(start, 14), true)).toBe(0);
});

test('weekly model keeps a smaller, non-zero weekend profile', () => {
  const start = Date.UTC(2026, 0, 5); // Monday
  const wkd = Array.from({ length: 24 }, (_, h) => (h === 15 ? 80 : 0));
  const wknd = Array.from({ length: 24 }, (_, h) => (h === 15 ? 12 : 0));

  const samples: ReturnType<typeof daySamples> = [];
  for (let w = 0; w < 8; w++) {
    const base = start + w * 7 * DAY;
    for (let d = 0; d < 5; d++) samples.push(...daySamples(base + d * DAY, true, wkd));
    samples.push(...daySamples(base + 5 * DAY, false, wknd)); // Saturday
    samples.push(...daySamples(base + 6 * DAY, false, wknd)); // Sunday
  }
  const model = trainWeeklyEmpirical(samples);

  const workdayPeak = predictWeeklyEmpirical(model, shanghaiHour(start, 15), true);
  const weekendPeak = predictWeeklyEmpirical(model, shanghaiHour(start + 5 * DAY, 15), false);

  expect(workdayPeak).toBeGreaterThan(60);
  expect(weekendPeak).toBeGreaterThan(0); // not collapsed to zero
  expect(weekendPeak).toBeLessThan(workdayPeak * 0.5); // but clearly smaller
  expect(predictWeeklyEmpirical(model, shanghaiHour(start, 3), true)).toBeLessThan(1);
});

test('weekly model routes holidays to the weekend regime without polluting working weekdays', () => {
  const start = Date.UTC(2026, 0, 5); // Monday
  const wkd = Array.from({ length: 24 }, (_, h) => (h === 10 ? 100 : 0));
  const wknd = Array.from({ length: 24 }, (_, h) => (h === 10 ? 10 : 0));

  const samples: ReturnType<typeof daySamples> = [];
  for (let w = 0; w < 6; w++) {
    const base = start + w * 7 * DAY;
    for (let d = 0; d < 5; d++) samples.push(...daySamples(base + d * DAY, true, wkd));
    samples.push(...daySamples(base + 5 * DAY, false, wknd));
    samples.push(...daySamples(base + 6 * DAY, false, wknd));
  }
  const model = trainWeeklyEmpirical(samples);

  const futureMonday = start + 6 * 7 * DAY; // a Monday with no training data
  const asWorkingMonday = predictWeeklyEmpirical(model, shanghaiHour(futureMonday, 10), true);
  const asHoliday = predictWeeklyEmpirical(model, shanghaiHour(futureMonday, 10), false);

  expect(asWorkingMonday).toBeGreaterThan(60); // normal Monday ~100
  expect(asHoliday).toBeGreaterThan(0);
  expect(asHoliday).toBeLessThan(40); // holiday behaves weekend-like, not 100
});
