#!/usr/bin/env node
// "What if we drop the ops labels?" — conditional-softmax probe.
//
// Key identity: for softmax, conditioning on a label subset equals renormalizing
// the original probabilities over that subset (the exp(z_i) numerators are
// unchanged). So we can predict — without retraining — how the distribution
// shifts if ops labels were removed from the head.
//
//   tsx packages/backend/scripts/probe-drop-ops.ts

import { loadLocalClassifierAssets } from '../src/services/expert-router/local/model-assets.js';
import { classifyWithLocalOnnx } from '../src/services/expert-router/local/classifier.js';

// Label subsets (indices resolved at runtime against assets.labels).
const SCENARIOS: Array<{ name: string; keep: (label: string) => boolean }> = [
  {
    name: 'A. 现状 (21 类)',
    keep: () => true,
  },
  {
    name: 'B. 去掉 ops，保留 coding + general_control + out_of_scope',
    keep: (l) => ![
      'deployment', 'infrastructure_provisioning', 'monitoring_query',
      'incident_response', 'pipeline_operation', 'config_change',
      'security_operation', 'log_analysis',
    ].includes(l),
  },
  {
    name: 'C. 去掉 ops + general_control，只保留 coding + out_of_scope',
    keep: (l) => [
      'code_authoring', 'code_modification', 'code_repair', 'code_review',
      'code_explanation', 'test_generation', 'code_search',
      'architecture_consultation', 'dependency_management', 'out_of_scope',
    ].includes(l),
  },
  {
    name: 'D. 极端：只保留 code_search vs out_of_scope (二分类)',
    keep: (l) => l === 'code_search' || l === 'out_of_scope',
  },
];

const PROMPTS = [
  '检查一下当前项目的证书管理功能逻辑都在哪里',
  '证书管理的逻辑写在哪里',
  '帮我找一下证书管理相关的代码',
  '查看一下线上服务的错误率和延迟', // 真正的 monitoring_query
];

function bar(score: number, width = 20): string {
  const filled = Math.round(score * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

async function main() {
  console.log('Loading assets…');
  const assets = await loadLocalClassifierAssets();
  const labels = assets.labels;
  const indices = SCENARIOS.map((s) => labels.map((_, i) => i).filter((i) => s.keep(labels[i])));

  for (const text of PROMPTS) {
    const res = await classifyWithLocalOnnx(text, 1024);
    // Full probs are already computed in res.ranked; rebuild by label.
    const probByLabel = new Map<string, number>();
    for (const r of res.ranked) probByLabel.set(r.label, r.score);

    console.log('\n══════════════════════════════════════════════════════════════════════');
    console.log(`▌ "${text}"`);
    console.log(`  现状 top1: ${res.policy.top1.label}:${res.policy.top1.score.toFixed(4)} | code_search=${(probByLabel.get('code_search') ?? 0).toFixed(4)}`);

    for (let si = 0; si < SCENARIOS.length; si++) {
      const subset = indices[si];
      let sum = 0;
      for (const i of subset) sum += probByLabel.get(labels[i]) ?? 0;
      const ranked = subset
        .map((i) => ({ label: labels[i], score: (probByLabel.get(labels[i]) ?? 0) / sum }))
        .sort((a, b) => b.score - a.score);

      console.log(`\n  ── ${SCENARIOS[si].name} ──`);
      for (let k = 0; k < Math.min(5, ranked.length); k++) {
        const r = ranked[k];
        const mark = r.label === 'code_search' ? '  ← code_search' : '';
        const below = r.score < 0.15 ? '  (<0.15 仍被 reject)' : '';
        console.log(`    ${(k === 0 ? 'top1' : '    ')} ${r.label.padEnd(28)} ${r.score.toFixed(4)} ${bar(r.score)}${mark}${below}`);
      }
    }
  }

  // Verdict summary.
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('VERDICT: 看 code_search 在各场景下能否拿到 top1 且 score≥0.15');
  console.log('┌────────────────────────────────────────────────────────┬───────────┬───────────┬───────────┬───────────┐');
  console.log('│ prompt                                                │ A 现状    │ B 去ops   │ C 仅code  │ D 二分类  │');
  console.log('├────────────────────────────────────────────────────────┼───────────┼───────────┼───────────┼───────────┤');
  for (const text of PROMPTS) {
    const res = await classifyWithLocalOnnx(text, 1024);
    const probByLabel = new Map<string, number>();
    for (const r of res.ranked) probByLabel.set(r.label, r.score);
    const cells: string[] = [];
    for (let si = 0; si < SCENARIOS.length; si++) {
      const subset = indices[si];
      let sum = 0;
      for (const i of subset) sum += probByLabel.get(labels[i]) ?? 0;
      const ranked = subset
        .map((i) => ({ label: labels[i], score: (probByLabel.get(labels[i]) ?? 0) / sum }))
        .sort((a, b) => b.score - a.score);
      const top = ranked[0];
      const cs = ranked.find((r) => r.label === 'code_search')?.score ?? 0;
      const tag = top.label === 'code_search' && top.score >= 0.15 ? '✓CS' : top.label === 'code_search' ? '~CS' : top.label.slice(0, 6);
      cells.push(`${tag}:${top.score.toFixed(2)}`.padEnd(11));
    }
    const short = text.length > 54 ? text.slice(0, 53) + '…' : text;
    console.log(`│ ${short.padEnd(54)} │ ${cells.join('│ ')}`);
  }
  console.log('└────────────────────────────────────────────────────────┴───────────┴───────────┴───────────┴───────────┘');
  console.log('图例: ✓CS=code_search 拿到 top1 且≥0.15 (路由成功); ~CS=code_search top1 但<0.15 (仍被reject); 其他=top1 标签');
}

main().catch((e) => { console.error(e); process.exit(1); });
