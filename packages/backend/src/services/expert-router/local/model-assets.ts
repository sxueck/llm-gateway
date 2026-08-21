import { readFileSync, existsSync, writeFileSync, renameSync } from "fs";
import { resolve, dirname, basename } from "path";
import {
  EXPERT_ROUTING_MODEL_REPO,
  EXPERT_ROUTING_MODEL_REVISION,
  EXPERT_ROUTING_ONNX_FILE,
} from "@llm-gateway/shared";
import { parseNpy } from "./npy-parser.js";
import type { RejectionPolicy } from "./rejection-policy.js";
import { memoryLogger } from "../../logger.js";

/**
 * Filesystem directory holding the pinned local ONNX classifier artifacts.
 * Populated by `scripts/download-onnx-model.{ts,js}` from the pinned HF
 * revision. Mutable `main` downloads are prohibited (NFR-1).
 */
const MODEL_DIR = process.env.EXPERT_ROUTING_MODEL_DIR
  ? resolve(process.env.EXPERT_ROUTING_MODEL_DIR)
  : resolve(process.cwd(), "model-assets", "intent-router-zh-setfit-v1");

const REVISION_MARKER_FILE = "REVISION";

const CLASSIFIER_DISABLED_VALUES = new Set(["off", "disabled", "0", "false"]);

/**
 * Deployment-level kill switch for the local ONNX classifier
 * (`LOCAL_INTENT_CLASSIFIER=off`). When disabled, assets are never loaded —
 * keeping the ~615MB model out of process memory for deployments that use
 * neither Expert Routing nor /v1/intent/classify. Expert Routing falls back
 * to LLM second pass / fallback; the intent API returns 503 classifier_disabled.
 */
export function isLocalClassifierDisabled(): boolean {
  const raw = (process.env.LOCAL_INTENT_CLASSIFIER ?? "").trim().toLowerCase();
  return CLASSIFIER_DISABLED_VALUES.has(raw);
}

export interface LoadedAssets {
  session: any;
  tokenizer: any;
  coef: Float64Array;
  intercept: Float64Array;
  hidden: number;
  numClasses: number;
  labels: string[];
  policy: RejectionPolicy;
  revision: string;
  modelDir: string;
}

interface AssetState {
  status: "unloaded" | "loading" | "ready" | "failed";
  assets?: LoadedAssets;
  error?: string;
}

const state: AssetState = { status: "unloaded" };
let loadPromise: Promise<LoadedAssets> | null = null;

export function getModelDir(): string {
  return MODEL_DIR;
}

export function isLocalClassifierReady(): boolean {
  return state.status === "ready" && !!state.assets;
}

export function getLocalClassifierError(): string | undefined {
  return state.status === "failed" ? state.error : undefined;
}

export function getAssets(): LoadedAssets | undefined {
  return state.assets;
}

/**
 * Lazily load and validate the local ONNX classifier assets. Safe to call
 * concurrently; the first call wins and others await the same promise (FR-15).
 */
export function loadLocalClassifierAssets(): Promise<LoadedAssets> {
  if (state.status === "ready" && state.assets) {
    return Promise.resolve(state.assets);
  }
  if (loadPromise) return loadPromise;
  loadPromise = doLoad().catch((e) => {
    state.status = "failed";
    state.error = e?.message || String(e);
    loadPromise = null;
    memoryLogger.error(
      `Local ONNX classifier assets failed to load: ${state.error}. ` +
        `Expert Routing will fall back until artifacts are present at ${MODEL_DIR}.`,
      "ExpertRouter",
    );
    throw e;
  });
  return loadPromise;
}

async function doLoad(): Promise<LoadedAssets> {
  // Defense in depth: initLocalClassifier() already skips when disabled, but
  // any future lazy-load path must also refuse rather than silently loading.
  if (isLocalClassifierDisabled()) {
    throw new Error("local classifier disabled by LOCAL_INTENT_CLASSIFIER env");
  }
  state.status = "loading";

  if (!existsSync(MODEL_DIR)) {
    throw new Error(`model directory not found: ${MODEL_DIR}`);
  }

  // Verify the on-disk artifacts are pinned to the required revision.
  const markerPath = resolve(MODEL_DIR, REVISION_MARKER_FILE);
  if (!existsSync(markerPath)) {
    throw new Error(
      `missing revision marker (${REVISION_MARKER_FILE}); run the download script`,
    );
  }
  const onDiskRevision = readFileSync(markerPath, "utf8").trim();
  if (onDiskRevision !== EXPERT_ROUTING_MODEL_REVISION) {
    throw new Error(
      `artifact revision mismatch: expected ${EXPERT_ROUTING_MODEL_REVISION}, found ${onDiskRevision}`,
    );
  }

  // IMPORTANT: load the ONNX Runtime native binding BEFORE @xenova/transformers.
  // Transformers.js pulls in onnxruntime-web/onnxruntime-common, and loading it
  // first corrupts the native .node dlopen for onnxruntime-node on some
  // platforms (Windows ERR_DLOPEN_FAILED). Importing ORT first is safe.
  const ortModule: any = await import("onnxruntime-node");
  const ort = ortModule?.default ?? ortModule;
  const onnxPath = resolve(MODEL_DIR, EXPERT_ROUTING_ONNX_FILE);
  if (!existsSync(onnxPath)) {
    throw new Error(`ONNX model file not found: ${onnxPath}`);
  }
  const session = await ort.InferenceSession.create(onnxPath, {
    graphOptimizationLevel: "all",
  });

  // Tokenizer (Qwen via Transformers.js). Transformers.js v2 joins
  // `env.localModelPath` + modelId, so point localModelPath at the parent
  // directory and pass the model folder name as the id.
  ensureTokenizerCompat(MODEL_DIR);
  const { AutoTokenizer, env } = await import("@xenova/transformers");
  try {
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = dirname(MODEL_DIR);
  } catch {
    // env shape varies across versions; non-fatal.
  }
  const tokenizer = await AutoTokenizer.from_pretrained(basename(MODEL_DIR));

  // Linear head weights.
  const coef = parseNpy(readFileSync(resolve(MODEL_DIR, "head_coef.npy")));
  const intercept = parseNpy(
    readFileSync(resolve(MODEL_DIR, "head_intercept.npy")),
  );
  if (coef.shape.length !== 2 || coef.shape[1] !== 1024) {
    throw new Error(
      `unexpected head_coef shape: ${JSON.stringify(coef.shape)} (expected [C, 1024])`,
    );
  }
  if (intercept.shape.length !== 1 || intercept.shape[0] !== coef.shape[0]) {
    throw new Error(
      `unexpected head_intercept shape: ${JSON.stringify(intercept.shape)} (expected [${coef.shape[0]}])`,
    );
  }

  // Labels + rejection policy.
  const labelsDoc = readJsonSync(MODEL_DIR, "labels.json");
  const labels: string[] = labelsDoc.labels;
  if (!Array.isArray(labels) || labels.length !== coef.shape[0]) {
    throw new Error(
      `labels/m head size mismatch: labels=${labels?.length}, head classes=${coef.shape[0]}`,
    );
  }
  const policy = parsePolicy(readJsonSync(MODEL_DIR, "rejection_policy.json"));

  const assets: LoadedAssets = {
    session,
    tokenizer,
    coef: coef.data,
    intercept: intercept.data,
    hidden: coef.shape[1],
    numClasses: coef.shape[0],
    labels,
    policy,
    revision: onDiskRevision,
    modelDir: MODEL_DIR,
  };

  state.status = "ready";
  state.assets = assets;
  state.error = undefined;
  memoryLogger.info(
    `Local ONNX classifier ready | repo=${EXPERT_ROUTING_MODEL_REPO} | revision=${onDiskRevision} | classes=${assets.numClasses} | hidden=${assets.hidden}`,
    "ExpertRouter",
  );
  return assets;
}

/**
 * Modern HF `tokenizer.json` files emit BPE `merges` as 2-element arrays
 * (`["Ġ","Ġ"]`), but @xenova/transformers v2 expects space-joined strings
 * (`"Ġ Ġ"`). Normalize the local deployment copy idempotently so the older
 * library can load the Qwen tokenizer. The REVISION marker still pins the
 * source revision; this is purely a runtime-compat transformation.
 */
function ensureTokenizerCompat(modelDir: string): void {
  const tokenizerPath = resolve(modelDir, "tokenizer.json");
  if (!existsSync(tokenizerPath)) return;
  let raw: string;
  try {
    raw = readFileSync(tokenizerPath, "utf8");
  } catch {
    return;
  }
  let doc: any;
  try {
    doc = JSON.parse(raw);
  } catch {
    return;
  }
  const merges = doc?.model?.merges;
  if (!Array.isArray(merges) || merges.length === 0) return;
  if (typeof merges[0] === "string") return; // already string format
  if (!Array.isArray(merges[0])) return; // unrecognized format; leave untouched

  doc.model.merges = merges.map((pair: any) =>
    Array.isArray(pair)
      ? pair.map((p: any) => String(p)).join(" ")
      : String(pair),
  );
  const tmp = `${tokenizerPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(doc), "utf8");
  renameSync(tmp, tokenizerPath);
  memoryLogger.info(
    "Normalized tokenizer.json merges (array → string) for Transformers.js v2 compatibility",
    "ExpertRouter",
  );
}

function readJsonSync(modelDir: string, file: string): any {
  try {
    return JSON.parse(readFileSync(resolve(modelDir, file), "utf8"));
  } catch (e: any) {
    // Identify which artifact is missing or corrupt; callers degrade to the
    // standard failed-load path with this message.
    throw new Error(`failed to read ${file}: ${e?.message || e}`);
  }
}

function parsePolicy(raw: any): RejectionPolicy {
  return {
    version: Number(raw.version),
    max_probability: Number(raw.max_probability),
    min_margin: Number(raw.min_margin ?? 0),
    short_text_max_chars: Number(raw.short_text_max_chars ?? 0),
    fallback_intent: String(raw.fallback_intent ?? "out_of_scope"),
    temperature: Number(raw.temperature ?? 1),
    enable_flip_rules: raw.enable_flip_rules !== false,
    enable_keyword_rules: raw.enable_keyword_rules !== false,
    flip_rules: Array.isArray(raw.flip_rules) ? raw.flip_rules : [],
    keyword_rules: Array.isArray(raw.keyword_rules) ? raw.keyword_rules : [],
  };
}
