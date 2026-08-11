#!/usr/bin/env node
// Diagnostic probe for the local ONNX classifier. Dumps the full ranked
// probability distribution and the rejection-policy decision so we can see
// exactly why a prompt is (mis)classified.
//
//   tsx packages/backend/scripts/diagnose-classifier.ts

import { loadLocalClassifierAssets } from '../src/services/expert-router/local/model-assets.js';
import { classifyWithLocalOnnx } from '../src/services/expert-router/local/classifier.js';

interface Case {
  label: string;
  text: string;
  expect?: string;
}

const CASES: Case[] = [
  {
    label: '用户报告的原始 prompt',
    text: '检查一下当前项目的证书管理功能逻辑都在哪里',
    expect: 'code_search',
  },
  {
    label: '变体: 前置名词 + 在哪里',
    text: '证书管理功能的逻辑在哪里',
    expect: 'code_search',
  },
  {
    label: '变体: 在哪 + 实现 (应命中 keyword)',
    text: '证书管理功能的实现在哪里',
    expect: 'code_search',
  },
  {
    label: '变体: 查找 + 实现 (应命中 keyword)',
    text: '查找证书管理功能的实现',
    expect: 'code_search',
  },
  {
    label: '变体: 帮我找 + 代码',
    text: '帮我找一下证书管理相关的代码',
    expect: 'code_search',
  },
  {
    label: '变体: ...逻辑写在哪里 (常见口语)',
    text: '证书管理的逻辑写在哪里',
    expect: 'code_search',
  },
  {
    label: '变体: 哪里有 ... 逻辑',
    text: '项目里哪里有证书管理的逻辑',
    expect: 'code_search',
  },
  {
    label: '对比: 监控查询',
    text: '查看一下线上服务的错误率和延迟',
    expect: 'monitoring_query',
  },
  {
    label: '对比: 部署',
    text: '把这个服务部署到生产环境',
    expect: 'deployment',
  },
];

function bar(score: number, width = 24): string {
  const filled = Math.round(score * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

async function main() {
  console.log('Loading local ONNX classifier assets…');
  const t0 = Date.now();
  const assets = await loadLocalClassifierAssets();
  console.log(
    `Loaded in ${Date.now() - t0}ms | classes=${assets.numClasses} hidden=${assets.hidden} revision=${assets.revision.slice(0, 8)}`
  );
  console.log(`Thresholds: max_prob=${assets.policy.max_probability} min_margin=${assets.policy.min_margin} short_text=${assets.policy.short_text_max_chars} chars\n`);

  for (const c of CASES) {
    const res = await classifyWithLocalOnnx(c.text, 1024);
    const p = res.policy;

    console.log('══════════════════════════════════════════════════════════════════════');
    console.log(`▌ ${c.label}`);
    if (c.expect) console.log(`  expected: ${c.expect}`);
    console.log(`  input:    "${c.text}"`);
    console.log(`  chosen:   ${p.chosenLabel} | rejected=${p.rejected}(${p.rejectionReason ?? '-'})`);
    if (p.matchedKeywordIntent) console.log(`  keyword:  ${p.matchedKeywordIntent}`);
    if (p.appliedFlip) {
      console.log(`  flip:     ${p.appliedFlip.from} → ${p.appliedFlip.to} (margin=${p.appliedFlip.margin.toFixed(3)})`);
    }
    console.log(`  latency:  ${res.latencyMs}ms | seqLen=${res.seqLen} truncated=${res.truncated}`);

    const top = res.ranked[0]?.score ?? 0;
    const thresholdTag = top < assets.policy.max_probability ? '  ← BELOW threshold (rejected)' : '';
    console.log(`  top1:     ${top.toFixed(4)}${thresholdTag}`);

    // Full distribution, sorted by score desc.
    console.log('  ── ranked distribution ─────────────────────────────────────────────');
    for (const r of res.ranked) {
      const mark = r.label === p.chosenLabel ? ' ★' : r.label === p.top1.label ? ' ·top1' : '';
      const expectMark = c.expect && r.label === c.expect ? '  ← EXPECTED' : '';
      const belowTag = r.score < assets.policy.max_probability ? '' : '';
      console.log(
        `    ${r.label.padEnd(30)} ${r.score.toFixed(4)} ${bar(r.score)}${mark}${expectMark}${belowTag}`
      );
    }
    console.log('');
  }

  // Summary table.
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log('┌─────────────────────────────────────────────────┬──────────────────────┬────────────┬───────────┐');
  console.log('│ case                                            │ chosen               │ top1 score │ expected  │');
  console.log('├─────────────────────────────────────────────────┼──────────────────────┼────────────┼───────────┤');
  for (const c of CASES) {
    const res = await classifyWithLocalOnnx(c.text, 1024);
    const chosen = (res.policy.rejected ? `${res.policy.chosenLabel}(rej)` : res.policy.chosenLabel).padEnd(20);
    const top = (res.policy.top1.score ?? 0).toFixed(3);
    const expect = c.expect ?? '-';
    const label = c.label.length > 47 ? c.label.slice(0, 46) + '…' : c.label;
    console.log(`│ ${label.padEnd(47)} │ ${chosen} │ ${top.padEnd(10)} │ ${expect.padEnd(9)} │`);
  }
  console.log('└─────────────────────────────────────────────────┴──────────────────────┴────────────┴───────────┘');
}

main().catch((e) => {
  console.error('Diagnose error:', e);
  process.exit(1);
});
