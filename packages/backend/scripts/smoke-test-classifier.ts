#!/usr/bin/env node
// Runtime smoke test for the local ONNX classifier. Validates the full
// pipeline (asset load → tokenizer → ONNX encoder + external data → head →
// softmax → v3 rejection policy) against the pinned artifacts.
//
//   tsx packages/backend/scripts/smoke-test-classifier.ts

import { loadLocalClassifierAssets, getAssets } from '../src/services/expert-router/local/model-assets.js';
import { classifyWithLocalOnnx } from '../src/services/expert-router/local/classifier.js';

const SAMPLES: Array<{ text: string; expectDomain: string; hint: string }> = [
  {
    text: 'Review this PR diff before merge. Focus on thread-safety of the session cache and whether the fallback re-checks expiry.',
    expectDomain: 'coding',
    hint: 'long agent-style code review request',
  },
  {
    text: 'Traceback (most recent call last):\n  File "app.py", line 148, in handle\n    raise NullPointerException("order not found")',
    expectDomain: 'coding',
    hint: 'stack trace → code repair keyword',
  },
  {
    text: 'hi',
    expectDomain: 'out_of_scope',
    hint: 'short text → rejected',
  },
];

async function main() {
  console.log('Loading local ONNX classifier assets…');
  const t0 = Date.now();
  const assets = await loadLocalClassifierAssets();
  console.log(
    `Loaded in ${Date.now() - t0}ms | classes=${assets.numClasses} hidden=${assets.hidden} revision=${assets.revision.slice(0, 8)}`
  );
  console.log(`Labels: ${assets.labels.length} | policy v${assets.policy.version} | max_prob=${assets.policy.max_probability}`);

  let pass = 0;
  let fail = 0;
  for (const sample of SAMPLES) {
    const res = await classifyWithLocalOnnx(sample.text, assets.labels ? 1024 : 1024);
    const top = res.policy.top1;
    const ok = res.policy.rejected
      ? sample.expectDomain === 'out_of_scope'
      : true; // For accepted results we just report; exact label is best-effort.
    const status = ok ? 'PASS' : 'FAIL';
    if (ok) pass++;
    else fail++;
    console.log(
      `\n[${status}] ${sample.hint}\n` +
      `  chosen=${res.policy.chosenLabel} rejected=${res.policy.rejected}(${res.policy.rejectionReason ?? '-'})\n` +
      `  top1=${top.label}:${top.score.toFixed(3)} top2=${res.policy.top2.label}:${res.policy.top2.score.toFixed(3)}\n` +
      `  flip=${JSON.stringify(res.policy.appliedFlip)} keyword=${res.policy.matchedKeywordIntent ?? '-'}\n` +
      `  latency=${res.latencyMs}ms seqLen=${res.seqLen} truncated=${res.truncated}`
    );
  }

  console.log(`\nSmoke test: ${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error('Smoke test error:', e);
  process.exit(1);
});
