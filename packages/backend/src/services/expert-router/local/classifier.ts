import { getAssets } from './model-assets.js';
import { computeProbabilities, l2Normalize, rankLabels, type RankedLabel } from './inference-math.js';
import { applyRejectionPolicy, type PolicyResult } from './rejection-policy.js';
import { EXPERT_ROUTING_MODEL_REVISION } from '@llm-gateway/shared';

export interface LocalClassifyResult {
  policy: PolicyResult;
  ranked: RankedLabel[];
  revision: string;
  latencyMs: number;
  seqLen: number;
  truncated: boolean;
}

/**
 * Run the local ONNX intent classifier on a single text and apply the v3
 * rejection policy. Returns the full ranked distribution plus the policy
 * decision so the routing layer can log top-1/top-2 scores and rejection reason.
 */
export async function classifyWithLocalOnnx(
  text: string,
  maxTokens = 1024
): Promise<LocalClassifyResult> {
  const assets = getAssets();
  if (!assets) {
    throw new Error('local ONNX classifier assets not loaded');
  }

  const start = Date.now();

  const { inputIds, attentionMask, seqLen } = await tokenizeForEncoder(assets.tokenizer, text, maxTokens);

  const ortModule: any = await import('onnxruntime-node');
  const ort = ortModule?.default ?? ortModule;
  const feeds = {
    input_ids: new ort.Tensor('int64', BigInt64Array.from(inputIds.map((v) => BigInt(v))), [1, seqLen]),
    attention_mask: new ort.Tensor(
      'int64',
      BigInt64Array.from(attentionMask.map((v) => BigInt(v))),
      [1, seqLen]
    ),
  };

  const outputs = await assets.session.run(feeds);
  const embedding = readSentenceEmbedding(outputs);

  const probs = computeProbabilities(
    l2Normalize(Float64Array.from(embedding)),
    assets.coef,
    assets.intercept,
    assets.hidden
  );
  const ranked = rankLabels(probs, assets.labels);
  const policy = applyRejectionPolicy(text, ranked, assets.policy);

  return {
    policy,
    ranked,
    revision: assets.revision || EXPERT_ROUTING_MODEL_REVISION,
    latencyMs: Date.now() - start,
    seqLen,
    truncated: seqLen >= maxTokens,
  };
}

/**
 * Tokenize a single text for the Qwen encoder. Batch size is always 1, so no
 * padding is required — this sidesteps padding-side concerns entirely while
 * keeping last-token pooling correct. Truncates to `maxTokens`.
 */
async function tokenizeForEncoder(
  tokenizer: any,
  text: string,
  maxTokens: number
): Promise<{ inputIds: number[]; attentionMask: number[]; seqLen: number }> {
  const enc = await tokenizer(text, { truncation: true, max_length: maxTokens, padding: false });

  const inputIds = asFlatNumberArray(enc?.input_ids);
  if (inputIds.length === 0) {
    throw new Error('tokenizer produced empty input_ids');
  }
  const attentionMask =
    enc?.attention_mask != null ? asFlatNumberArray(enc.attention_mask) : inputIds.map(() => 1);
  if (attentionMask.length !== inputIds.length) {
    // Defensive: align mask length to ids.
    return {
      inputIds,
      attentionMask: inputIds.map(() => 1),
      seqLen: inputIds.length,
    };
  }
  return { inputIds, attentionMask, seqLen: inputIds.length };
}

/** Normalize a Transformers.js tokenization field (Tensor or nested array) to a flat number[]. */
function asFlatNumberArray(value: any): number[] {
  if (value == null) return [];
  if (Array.isArray(value)) {
    // number[][] (batch) -> take first sequence; number[] -> as-is.
    if (Array.isArray(value[0])) return (value[0] as any[]).map((v) => Number(v));
    return (value as any[]).map((v) => Number(v));
  }
  if (typeof value.tolist === 'function') {
    const nested = value.tolist();
    return asFlatNumberArray(nested);
  }
  if (value.data && typeof value.data !== 'string') {
    const data = value.data;
    if (value.dims && Array.isArray(value.dims) && value.dims.length > 1) {
      // Tensor [1, seq] -> take first row using dims.
      const cols = value.dims[value.dims.length - 1];
      const row: number[] = [];
      for (let i = 0; i < cols; i++) row.push(Number(data[i]));
      return row;
    }
    return Array.from(data as Iterable<any>).map((v) => Number(v));
  }
  return [];
}

function readSentenceEmbedding(outputs: any): Float32Array | number[] {
  const tensor = outputs?.sentence_embedding ?? outputs?.last_hidden_state ?? Object.values(outputs)[0];
  const dims = tensor?.dims;
  // sentence_embedding is a pooled [hidden] or [1, hidden] vector. A 3-D
  // [1, seq, hidden] last_hidden_state is token-level and cannot be interpreted
  // as a pooled vector — fail loudly rather than computing logits over the
  // wrong memory slice.
  if (Array.isArray(dims) && dims.length > 2) {
    throw new Error(
      `unexpected embedding shape [${dims.join(', ')}]; expected pooled [hidden] or [1, hidden]`
    );
  }
  const data = tensor?.data ?? tensor;
  if (data instanceof Float32Array) return data;
  if (Array.isArray(data) || (data && typeof data.length === 'number')) {
    return Array.from(data as Iterable<any>).map((v) => Number(v));
  }
  throw new Error('could not read sentence_embedding from ONNX output');
}
