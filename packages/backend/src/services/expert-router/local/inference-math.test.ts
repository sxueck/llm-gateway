import { describe, expect, test } from 'vitest';
import { computeProbabilities, l2Normalize, rankLabels, softmax } from './inference-math.js';

describe('softmax', () => {
  test('produces a probability distribution summing to 1', () => {
    const probs = softmax(Float64Array.from([1, 2, 3]));
    let sum = 0;
    for (const p of probs) sum += p;
    expect(sum).toBeCloseTo(1, 6);
    expect(probs[2]).toBeGreaterThan(probs[1]);
    expect(probs[1]).toBeGreaterThan(probs[0]);
  });

  test('is numerically stable for large logits', () => {
    const probs = softmax(Float64Array.from([1000, 1001, 1002]));
    let sum = 0;
    for (const p of probs) sum += p;
    expect(sum).toBeCloseTo(1, 6);
    expect(Array.from(probs).every((p) => Number.isFinite(p))).toBe(true);
  });
});

describe('computeProbabilities', () => {
  test('matches the documented head contract: (emb @ coef.T + intercept) / (1+1e-5)', () => {
    // 3 classes, hidden = 2
    const embedding = Float64Array.from([1.0, 0.0]);
    const coef = Float64Array.from([
      1, 0, // class 0 weights
      0, 1, // class 1 weights
      1, 1, // class 2 weights
    ]);
    const intercept = Float64Array.from([0, 0, 0]);
    const hidden = 2;

    const probs = computeProbabilities(embedding, coef, intercept, hidden);

    // logits = [1, 0, 1] / 1.00001  (then softmax)
    expect(probs.length).toBe(3);
    let sum = 0;
    for (const p of probs) sum += p;
    expect(sum).toBeCloseTo(1, 6);
    // class 0 and class 2 tie (logit 1), class 1 lowest (logit 0)
    expect(probs[0]).toBeCloseTo(probs[2], 6);
    expect(probs[1]).toBeLessThan(probs[0]);
  });
});

describe('rankLabels', () => {
  test('sorts labels by score descending', () => {
    const labels = ['a', 'b', 'c'];
    const probs = Float64Array.from([0.2, 0.5, 0.3]);
    const ranked = rankLabels(probs, labels);
    expect(ranked.map((r) => r.label)).toEqual(['b', 'c', 'a']);
    expect(ranked[0].score).toBeCloseTo(0.5, 6);
  });
});

describe('l2Normalize', () => {
  test('scales a non-unit vector to unit length', () => {
    const out = l2Normalize(Float64Array.from([3, 4]));
    expect(out[0]).toBeCloseTo(0.6, 6);
    expect(out[1]).toBeCloseTo(0.8, 6);
    let norm = 0;
    for (const v of out) norm += v * v;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 6);
  });

  test('is idempotent on an already unit vector', () => {
    const unit = Float64Array.from([0.6, 0.8]);
    const out = l2Normalize(unit);
    expect(out[0]).toBeCloseTo(0.6, 6);
    expect(out[1]).toBeCloseTo(0.8, 6);
  });

  test('returns a zero vector for a zero input rather than dividing by zero', () => {
    const out = l2Normalize(Float64Array.from([0, 0]));
    expect(Array.from(out)).toEqual([0, 0]);
  });
});
