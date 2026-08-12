#!/usr/bin/env node
// Downloads and pins the local ONNX intent-router artifacts to the exact HF
// revision required by the spec. Run once per deployment before enabling Expert
// Routing:
//
//   bun run packages/backend/scripts/download-onnx-model.ts
//   # or: tsx packages/backend/scripts/download-onnx-model.ts
//
// Mutable `main` downloads are prohibited (NFR-1); this script always pins the
// configured revision and writes a REVISION marker the asset loader validates.

import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'fs';
import { resolve } from 'path';

// NOTE: these literals are intentionally duplicated from
// `@llm-gateway/shared` (EXPERT_ROUTING_MODEL_REPO / _REVISION). The Docker
// `model-assets` build stage copies ONLY this script into a bare context with
// no node_modules, so it cannot import the shared package. A drift-detection
// test (scripts/download-onnx-model.test.ts) asserts these stay in sync with
// the shared constants — update both together when bumping the pin.
const REPO = 'snival/intent-router-zh-setfit-v1';
const REVISION = 'e2cc76b77de09cdc46ac7877ec779a914d466660';

const TARGET_DIR = process.env.EXPERT_ROUTING_MODEL_DIR
  ? resolve(process.env.EXPERT_ROUTING_MODEL_DIR)
  : resolve(process.cwd(), 'model-assets', 'intent-router-zh-setfit-v1');

// Core artifacts required for inference.
const REQUIRED = [
  'encoder-woq8.onnx',
  'encoder-woq8.onnx.data',
  'head_coef.npy',
  'head_intercept.npy',
  'labels.json',
  'rejection_policy.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'special_tokens_map.json',
];

// Tokenizer support files; some Qwen checkpoints ship a subset — 404s here are tolerated.
const OPTIONAL = [
  'vocab.json',
  'merges.txt',
  'added_tokens.json',
];

function fileUrl(name: string): string {
  return `https://huggingface.co/${REPO}/resolve/${REVISION}/${name}`;
}

async function download(name: string, dest: string): Promise<number> {
  const url = fileUrl(name);
  const tmp = `${dest}.tmp`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} for ${name}`);
  }
  // Stream the response body to disk via the Web Streams reader. This avoids
  // `Readable.fromWeb` (whose support varies across runtimes) so the script
  // works identically under bun (Docker build) and node.
  const writer = createWriteStream(tmp);
  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      writer.write(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
    await new Promise<void>((resolve, reject) => {
      writer.on('error', reject);
      writer.end(resolve);
    });
  }
  renameSync(tmp, dest);
  return statSync(dest).size;
}

async function main() {
  console.log(`Pinning ${REPO} @ ${REVISION}`);
  console.log(`Target dir: ${TARGET_DIR}`);
  mkdirSync(TARGET_DIR, { recursive: true });

  const manifest = [
    ...REQUIRED.map((f) => ({ f, required: true })),
    ...OPTIONAL.map((f) => ({ f, required: false })),
  ];

  let total = 0;
  for (const { f, required } of manifest) {
    const dest = resolve(TARGET_DIR, f);
    // Skip files already present (idempotent re-runs).
    if (existsSync(dest)) {
      const size = statSync(dest).size;
      total += size;
      console.log(`  ✓ ${f} (cached, ${(size / 1024 / 1024).toFixed(1)} MB)`);
      continue;
    }
    try {
      const size = await download(f, dest);
      total += size;
      console.log(`  ✓ ${f} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    } catch (e: any) {
      if (required) {
        console.error(`  ✗ ${f} FAILED: ${e.message}`);
        throw e;
      }
      console.log(`  - ${f} skipped (${e.message})`);
    }
  }

  // Write the revision marker the loader validates.
  const { writeFileSync } = await import('fs');
  writeFileSync(resolve(TARGET_DIR, 'REVISION'), REVISION, 'utf8');

  console.log(`\nDone. ${manifest.length} file(s), total ${(total / 1024 / 1024).toFixed(1)} MB.`);
  console.log(`Expert Routing assets pinned to revision ${REVISION}.`);
}

main().catch((e) => {
  console.error('Download failed:', e?.message || e);
  process.exit(1);
});
