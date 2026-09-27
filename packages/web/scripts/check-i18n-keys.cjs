// 校验：视图里用到的 i18n key 在两个 locale 文件里都存在（含动态命名空间展开）。
const fs = require('fs');
const path = require('path');

const root = process.cwd();
const locales = {};
for (const name of ['zh-CN', 'en-US']) {
  const src = fs
    .readFileSync(path.join(root, 'src/i18n/locales/' + name + '.ts'), 'utf8')
    .replace(/export default/, 'module.exports =');
  const tmp = path.join('/tmp', 'loc-' + name + '.cjs');
  fs.writeFileSync(tmp, src);
  locales[name] = require(tmp);
}

const files = [
  'src/views/PlaygroundView.vue',
  'src/components/AgentMetricsPanel.vue',
  'src/views/OperationsMonitoringView.vue',
  'src/components/PageHeader.vue',
  'src/layouts/MainLayout.vue',
  'src/views/DeveloperSettingsView.vue',
];

const used = new Map();
const dyn = new Map();
for (const f of files) {
  const s = fs.readFileSync(path.join(root, f), 'utf8');
  for (const m of s.matchAll(/(?:\$t|\bt|\bte)\(\s*['"]([a-zA-Z0-9_.]+)['"]/g)) {
    if (!used.has(m[1])) used.set(m[1], f);
  }
  for (const m of s.matchAll(/(?:\bt|\bte)\(\s*`([a-zA-Z0-9_.]+)\$\{/g)) {
    if (!dyn.has(m[1])) dyn.set(m[1], f);
  }
}

// 动态前缀需要展开的候选值（从代码里出现的枚举推断）
const candidates = {
  'agentMetrics.category.': ['coding-agent', 'sdk', 'script', 'browser', 'worker', 'unknown'],
  'agentMetrics.status.': [
    'completed', 'failed', 'cancelled', 'running', 'queued', 'timed_out', 'budget_exceeded', 'expired',
  ],
  'playground.chat.role.': ['user', 'assistant', 'system'],
  // tabs 动态前缀只用于 DIMENSIONS 三个分支（见模板里的三元表达式）
  'operationsMonitoring.tabs.': ['virtualKeys', 'models', 'providers'],
  'operationsMonitoring.filters.search': ['VirtualKey', 'Model', 'Provider'],
};

function lookup(obj, dotted) {
  let cur = obj;
  for (const p of dotted.split('.')) {
    if (cur == null || typeof cur !== 'object' || !(p in cur)) return false;
    cur = cur[p];
  }
  return true;
}

const problems = [];
for (const [k, f] of used) {
  for (const name of Object.keys(locales)) {
    if (!lookup(locales[name], k)) problems.push(`${name}: ${k}  (${f})`);
  }
}
for (const [prefix, f] of dyn) {
  const vals = candidates[prefix];
  if (!vals) {
    problems.push(`DYN-NOCHECK ${prefix} (${f})`);
    continue;
  }
  for (const v of vals) {
    const k = prefix + v;
    for (const name of Object.keys(locales)) {
      if (!lookup(locales[name], k)) problems.push(`${name}: ${k}  (${f})`);
    }
  }
}

console.log('static keys checked:', used.size, ' dynamic prefixes:', dyn.size);
console.log(problems.length ? 'MISSING:\n' + problems.join('\n') : 'ALL I18N KEYS RESOLVE');
