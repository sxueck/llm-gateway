import { expect, test } from 'vitest';

import { buildFeatureVector, detectPeaks, predict, trainRidge } from './traffic-prediction.js';

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
