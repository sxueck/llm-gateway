// Head inference math for the SetFit ONNX classifier.
//
// Contract (from ONNX_INFERENCE.md):
//   logits = (embedding @ coef.T + intercept) / (1.0 + 1e-05)
//   probs  = softmax(logits)
// where embedding is the L2-normalized [hidden] sentence_embedding from the
// ONNX encoder, coef is [numClasses, hidden], intercept is [numClasses].

const TEMPERATURE_DIVISOR = 1.0 + 1e-5;

export interface RankedLabel {
  label: string;
  score: number;
}

/**
 * Compute per-class probabilities from a sentence embedding and the linear head
 * weights. `coef` is a flat row-major [numClasses, hidden] array.
 */
export function computeProbabilities(
  embedding: Float64Array | Float32Array,
  coef: Float64Array,
  intercept: Float64Array,
  hidden: number
): Float64Array {
  const numClasses = intercept.length;
  const logits = new Float64Array(numClasses);

  for (let c = 0; c < numClasses; c++) {
    const rowOffset = c * hidden;
    let dot = 0;
    for (let h = 0; h < hidden; h++) {
      dot += embedding[h] * coef[rowOffset + h];
    }
    logits[c] = (dot + intercept[c]) / TEMPERATURE_DIVISOR;
  }

  return softmax(logits);
}

/**
 * L2-normalize an embedding into a new Float64Array. The classification head
 * was trained on L2-normalized embeddings; normalize defensively so correctness
 * does not depend on the ONNX graph baking normalization in. Idempotent on
 * already-unit vectors.
 */
export function l2Normalize(input: Float64Array | Float32Array): Float64Array {
  let sumSquares = 0;
  for (let i = 0; i < input.length; i++) sumSquares += input[i] * input[i];
  const norm = Math.sqrt(sumSquares);
  const out = new Float64Array(input.length);
  if (!(norm > 0)) return out;
  for (let i = 0; i < input.length; i++) out[i] = input[i] / norm;
  return out;
}

export function softmax(logits: Float64Array): Float64Array {
  const n = logits.length;
  if (n === 0) return new Float64Array(0);

  let max = logits[0];
  for (let i = 1; i < n; i++) {
    if (logits[i] > max) max = logits[i];
  }

  const out = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const e = Math.exp(logits[i] - max);
    out[i] = e;
    sum += e;
  }
  if (sum > 0) {
    for (let i = 0; i < n; i++) out[i] /= sum;
  }
  return out;
}

/**
 * Rank all classes by probability (descending) and attach label names.
 */
export function rankLabels(probs: Float64Array, labels: string[]): RankedLabel[] {
  const ranked = labels.map((label, index) => ({ label, score: probs[index] ?? 0 }));
  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}
