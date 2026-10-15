/**
 * 模型名 → 定价键的归一化与官方实验室（official lab）择优。
 *
 * 背景：定价预设表（models.dev）按 modelId 建索引，而网关里实际跑的名字经常带装饰后缀
 * （`claude-opus-4-8[1m]`、`gpt-5.5-0424-global`）或聚合商前缀（`openrouter/anthropic/claude-...`）。
 * 精确匹配落空后 `resolveModelCost` 返回 null，成本就被记成 0——成本分析因此长期偏低。
 *
 * 另一个偏差来源：同一个 modelId 会被多家供应商重复登记（官方实验室 + 云托管 + 聚合商），
 * 预设表按 providerPriority 择优。表里缺实验室就会让转售商（如 alibaba 代售的 kimi）拿到牌价，
 * 所以这里的优先级同时承担“往官方实验室靠拢”的语义。
 */

/** 上下文窗口/推理档位等方括号标记：`claude-opus-4-8[1m]` */
const BRACKET_TAG = /\[[^\]]*\]/g;
/** 显式版本尾巴：`@default` / Bedrock 的 `-v1:0` */
const REVISION_SUFFIX = /(?:@|:)v?\d[\w.]*$/i;
/** 日期快照：`-20251001`、`-2025-10-01`、Azure 式短日期 `-0424` */
const DATE_SUFFIX = /-(?:\d{4}-\d{2}-\d{2}|\d{8}|\d{4})$/;
/** 路由/渠道标签：官方牌价不会带这些（pro/mini/vision 等是真价阶，不能剥） */
const CHANNEL_SUFFIX =
  /-(?:latest|global|stable|agent|beta|exp|rc\d*|online|v\d+)$/;

/** 官方实验室（模型自研方）。牌价以其为准，转售渠道只在缺失时兜底。 */
const OFFICIAL_LAB_PRIORITY: Record<string, number> = {
  openai: 1000,
  anthropic: 980,
  google: 960,
  'google-ai-studio': 930,
  deepseek: 950,
  moonshot: 940,
  moonshotai: 940,
  'moonshotai-cn': 940,
  kimi: 935,
  zai: 930,
  zhipu: 930,
  zhipuai: 930,
  qwen: 925,
  alibaba: 920,
  'alibaba-cn': 900,
  minimax: 915,
  stepfun: 910,
  'stepfun-ai': 910,
  sensenova: 905,
  longcat: 900,
  xiaomi: 895,
  tencent: 890,
  bailing: 885,
  volcengine: 880,
  bytedance: 880,
  mistral: 875,
  cohere: 870,
  xai: 865,
  meta: 860,
  nvidia: 855,
  sarvam: 850,
  upstage: 845,
  ibm: 840,
  ai21: 838,
  inception: 836,
  sakana: 834,
  arcee: 832,
  think: 830,
};

/** 云托管与聚合网关：牌价含加价/折扣，权重一律低于实验室。 */
const HOSTED_PRIORITY: Record<string, number> = {
  'google-vertex': 720,
  'google-vertex-anthropic': 715,
  'vertex-ai': 720,
  'amazon-bedrock': 700,
  bedrock: 700,
  'aws-bedrock': 700,
  azure: 690,
  'azure-openai': 688,
  'azure-anthropic': 687,
  azureai: 685,
  watsonx: 680,
  sap: 675,
  'sap-ai-core': 675,
  github: 670,
  'github-copilot': 670,
  gitlab: 665,
  groq: 650,
  together: 620,
  togetherai: 620,
  fireworks: 610,
  'fireworks-ai': 610,
  huggingface: 550,
  hf: 550,
  openrouter: 500,
  deepinfra: 480,
  novita: 470,
  'novita-ai': 470,
  siliconflow: 460,
  'siliconflow-cn': 455,
  cerebras: 450,
  chutes: 440,
  nearai: 435,
  modal: 430,
  baseten: 425,
  ollama: 420,
  'ollama-cloud': 420,
  lmstudio: 415,
  vercel: 410,
  cloudflare: 405,
  'cloudflare-ai-gateway': 405,
  'cloudflare-workers-ai': 405,
  scaleway: 400,
  ovhcloud: 398,
  nebius: 396,
  digitalocean: 394,
  vultr: 392,
  perplexity: 390,
  venice: 388,
  requesty: 386,
  zenmux: 384,
  modelscope: 382,
  snowflake: 380,
  'snowflake-cortex': 380,
  databricks: 378,
  stackit: 376,
  clarifai: 374,
  edenai: 372,
  'wandb': 370,
};

/**
 * 订阅套餐入口（coding plan / token plan）：按包月计费，牌价不代表 API 单价，
 * 因此压在最低档，只可能在没有其他来源时被选中。
 */
const PLAN_GATEWAY_PRIORITY = 200;

/** 家族 → 自研方；用于“这张牌价是不是模型自己家的”判定。 */
const FAMILY_OWNERS: Record<string, string[]> = {
  claude: ['anthropic'],
  gpt: ['openai'],
  codex: ['openai'],
  chatgpt: ['openai'],
  o1: ['openai'],
  o3: ['openai'],
  o4: ['openai'],
  gemini: ['google'],
  gemma: ['google'],
  kimi: ['moonshot', 'moonshotai', 'kimi'],
  glm: ['zai', 'zhipu'],
  qwen: ['qwen', 'alibaba'],
  qwq: ['qwen', 'alibaba'],
  deepseek: ['deepseek'],
  doubao: ['volcengine', 'bytedance'],
  hunyuan: ['tencent'],
  ernie: ['baidu'],
  minimax: ['minimax', 'hailuo'],
  hailuo: ['minimax'],
  mimo: ['xiaomi'],
  step: ['stepfun'],
  llama: ['meta'],
  mistral: ['mistral'],
  mixtral: ['mistral'],
  codestral: ['mistral'],
  devstral: ['mistral'],
  magistral: ['mistral'],
  grok: ['xai'],
  command: ['cohere'],
  nemotron: ['nvidia'],
  nova: ['amazon', 'aws'],
  sarvam: ['sarvam'],
  sensenova: ['sensenova'],
  longcat: ['longcat', 'meituan'],
  ring: ['stepfun'],
};

/** 自研方命中加权：同 normalized 键组内，模型自己家的牌价必须赢过任何代售。 */
const FAMILY_OWNER_BONUS = 5000;

export function normalizePricingKey(name: string): string {
  return name.toLowerCase().trim().replace(BRACKET_TAG, '').replace(/[\s_]+/g, '-');
}

/**
 * 分隔符无关键：把 `gpt-5.5` 与 `gpt-5-5` 归到同一组。
 * 预设表里同一牌价常有两种写法（如 frogbot 的 `gpt-5-5` 就是 openai 的 `gpt-5.5`），
 * 不归并就会用转售商的拼写抢到官方牌价。
 */
export function separatorAgnosticKey(name: string): string {
  return normalizePricingKey(name).replace(/\.+|-{2,}/g, '-').replace(/-+$/, '');
}

function stripRevision(name: string): string {
  return name.replace(REVISION_SUFFIX, '');
}

/**
 * 供应商权重：实验室 > 托管/聚合 > 订阅套餐 > 未知。
 * 未知供应商返回 100，保证有实验室来源时一定输。
 */
export function providerPriority(providerId: string | undefined): number {
  const raw = (providerId || '').toLowerCase().trim();
  if (!raw) return 100;
  const explicit = OFFICIAL_LAB_PRIORITY[raw] ?? HOSTED_PRIORITY[raw];
  if (explicit !== undefined) return explicit;
  if (/(?:coding-plan|token-plan|-plan-|step-plan)/.test(raw)) return PLAN_GATEWAY_PRIORITY;
  // 复合 id（如 moonshotai-cn / zai-coding-plan）按首段回退到已知档位
  const head = raw.split(/[-_]/)[0];
  const byHead = OFFICIAL_LAB_PRIORITY[head] ?? HOSTED_PRIORITY[head];
  if (byHead !== undefined) return byHead;
  return 100;
}

/** 该型号已知的自研方名单；无法识别家族时返回 null。 */
export function familyOwnersOf(modelId: string): string[] | null {
  const normalized = normalizePricingKey(modelId);
  for (const [family, owners] of Object.entries(FAMILY_OWNERS)) {
    if (normalized.includes(family)) return owners;
  }
  return null;
}

/** 该 modelId 的这个供应商条目是否是自研方牌价。 */
export function isFamilyOwner(modelId: string, providerId: string | undefined): boolean {
  const provider = (providerId || '').toLowerCase();
  if (!provider) return false;
  const owners = familyOwnersOf(modelId);
  if (!owners) return false;
  return owners.some(
    owner => provider === owner || provider.startsWith(`${owner}-`) || provider.startsWith(`${owner}_`),
  );
}

/** 同一归一化键组内的择优分：自研方牌价 > 有价 > 供应商档位。 */
export function presetEntryScore(
  modelId: string,
  entry: { provider?: string; input_cost_per_token?: number; output_cost_per_token?: number },
): number {
  let score = providerPriority(entry.provider);
  if (isFamilyOwner(modelId, entry.provider)) score += FAMILY_OWNER_BONUS;
  // 只有非 0 实价才加分：订阅套餐条目常记 0 价，不能抢过真实牌价
  if (
    (typeof entry.input_cost_per_token === 'number' && entry.input_cost_per_token > 0) ||
    (typeof entry.output_cost_per_token === 'number' && entry.output_cost_per_token > 0)
  ) {
    score += 10;
  }
  return score;
}

function stripProviderPrefixes(name: string): string[] {
  const result: string[] = [];
  let current = name.trim();
  // 斜杠前缀：openrouter/anthropic/claude-x -> anthropic/claude-x -> claude-x
  while (/^[a-z0-9][a-z0-9.-]*\//i.test(current)) {
    current = current.slice(current.indexOf('/') + 1).trim();
    if (current) result.push(current);
  }
  // 点号前缀：Bedrock ARN 写法 `anthropic.claude-3-5-sonnet-...`；只在头部确实是供应商名时才剔
  const dotted = separatorAgnosticKey(current);
  const head = dotted.split('-')[0];
  if (current.includes('.') && dotted.includes('-') && KNOWN_PROVIDER_TOKENS.has(head)) {
    const rest = current.slice(current.indexOf('.') + 1).trim();
    if (rest) result.push(rest);
  }
  return result;
}

/** 点号前缀只认已知供应商名，避免把 `gpt-5.5` 这类型号里的点当分隔符剔掉 */
const KNOWN_PROVIDER_TOKENS = new Set([
  ...Object.keys(OFFICIAL_LAB_PRIORITY),
  ...Object.keys(HOSTED_PRIORITY),
].flatMap(id => [id, id.split('-')[0]!]));

function stripSuffixes(name: string): string[] {
  const result: string[] = [];
  let current = name.trim();
  // 反复剥离直到不再变化：gpt-5.5-0424-global -> gpt-5.5-0424 -> gpt-5.5
  for (let guard = 0; guard < 6; guard++) {
    const next = stripRevision(current)
      .replace(DATE_SUFFIX, '')
      .replace(CHANNEL_SUFFIX, '');
    if (next === current || !next.trim()) break;
    current = next;
    result.push(current);
  }
  return result;
}

/**
 * 生成定价候选名（按优先级，越靠前越忠实于原名）。含原名本身，
 * 调用方可当作“逐级回退”列表直接用。
 */
/**
 * 生成定价候选名（越靠前越忠实于原名）。只管“名字写法”，
 * 大小写 / 括号 / 分隔符由键归一（separatorAgnosticKey）负责，不在这里重复。
 */
export function pricingCandidates(rawName: string): string[] {
  const out: string[] = [];
  const push = (value: string) => {
    const trimmed = (value || '').trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  };

  const raw = (rawName || '').trim();
  if (!raw) return [];
  const prefixesOf = stripProviderPrefixes(raw);

  // 第一层：只动前缀（openrouter/anthropic/claude-x -> claude-x）
  push(raw);
  push(stripRevision(raw));
  for (const variant of prefixesOf) {
    push(variant);
    push(stripRevision(variant));
  }

  // 第二层：在每种前缀写法上再剥装饰后缀（日期快照、-global、Bedrock -v1:0）
  for (const base of [raw, ...prefixesOf]) {
    for (const stripped of stripSuffixes(base)) {
      push(stripped);
      for (const deeper of stripProviderPrefixes(stripped)) push(deeper);
    }
  }

  return out;
}

/** 家族前缀：`claude-opus-4-8` -> `claude-opus`，用于在同家族里找最近邻。 */
export function modelFamily(name: string): string {
  return normalizePricingKey(name)
    .replace(/-?\d+(?:[.-]\d+)*.*$/, '')
    .replace(/-+$/, '');
}

/** 家族键：`claude-opus-4-8` -> ['claude-opus', 'opus']，让 `opus-4-8` 这类省了厂商前缀的别名也能回得来。 */
export function familyKeysOf(name: string): string[] {
  const family = modelFamily(name);
  if (family.length < 3) return [];
  const tail = family.split('-').filter(Boolean).pop() || '';
  return tail.length >= 3 && tail !== family ? [family, tail] : [family];
}

/** 版本序列：`claude-opus-4-8` -> [4,8]，用于同家族内的“最贴近”判定。 */
export function versionTuple(name: string): number[] {
  const matches = normalizePricingKey(name).match(/\d+(?:[.-]\d+)*/g);
  if (!matches) return [];
  return matches
    .join('.')
    .split(/[.-]/)
    .map(value => Number.parseInt(value, 10))
    .filter(value => Number.isFinite(value));
}

/** 同一家族内的版本距离；主版本不同判为不同代（返回 null，不可比价）。 */
export function versionDistance(a: number[], b: number[]): number | null {
  const trim = (v: number[]) => v.filter(n => n < 10000);
  const left = trim(a);
  const right = trim(b);
  if (!left.length || !right.length) return null;
  if (left[0] !== right[0]) return null;
  let distance = 0;
  const len = Math.max(left.length, right.length);
  for (let i = 1; i < len; i++) {
    distance += Math.abs((left[i] ?? 0) - (right[i] ?? 0));
  }
  return distance;
}

/** 解析器只用到这几个字段，避免与 ModelPresetInfo 结偶。 */
export interface PricingPresetEntry {
  provider?: string;
  litellm_provider?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
}

export type PricingMatchStrategy = 'exact' | 'alias' | 'normalized' | 'family';

export interface PricingMatch<T extends PricingPresetEntry> {
  /** 预设表里真正命中的键 */
  modelId: string;
  entry: T;
  strategy: PricingMatchStrategy;
  provider?: string;
}

const entryProvider = (entry: PricingPresetEntry) => entry.litellm_provider || entry.provider;
/** 0 不记作“有价”——免费模型的 0 价仍是牌价，但缺数据时不能当作命中。 */
const hasPricing = (entry: PricingPresetEntry) =>
  (typeof entry.input_cost_per_token === 'number' && entry.input_cost_per_token > 0) ||
  (typeof entry.output_cost_per_token === 'number' && entry.output_cost_per_token > 0);

/** 家族回退只允许靠官方实验室牌价，否则宁可不定价——错价的数字比 0 更难被发现。 */
const OFFICIAL_LAB_FLOOR = 800;

/**
 * 能否把这家当作该型号的官方牌价来源。
 * 型号家族已知自研方时必须就是自研方（alibaba 代售的 kimi 不算），
 * 认不出家族才退而求其次用供应商权重。
 */
function isOfficialSource(modelId: string, provider: string | undefined): boolean {
  if (isFamilyOwner(modelId, provider)) return true;
  if (familyOwnersOf(modelId)) return false;
  return providerPriority(provider) >= OFFICIAL_LAB_FLOOR;
}

/**
 * 在预设表上建一次索引，返回“模型名 → 牌价条目”的解析器。
 *
 * 两层设计：
 * 1. 同一归一化键下挂着同一模型的所有写法（官方裸名 / `openai/gpt-5.5` 这种带前缀的转售键 /
 *    `gpt-5-5` 这种拼写变体），取最高分——这就是“往官方实验室靠拢”。
 * 2. 键完全找不到时，才在同家族官方牌价里找版本最近邻（策略标为 family）。
 */
export function createPresetResolver<T extends PricingPresetEntry>(
  data: Record<string, T>,
): (name: string) => PricingMatch<T> | null {
  const keyGroups = new Map<string, Array<{ id: string; score: number }>>();
  const familyGroups = new Map<string, Array<{ id: string; score: number; version: number[] }>>();

  const register = (key: string, id: string, score: number) => {
    if (!key) return;
    const bucket = keyGroups.get(key);
    if (!bucket) {
      keyGroups.set(key, [{ id, score }]);
      return;
    }
    if (!bucket.some(item => item.id === id)) bucket.push({ id, score });
  };

  for (const [id, entry] of Object.entries(data)) {
    if (!entry) continue;
    const provider = entryProvider(entry);
    const score = presetEntryScore(id, { ...entry, provider });
    register(separatorAgnosticKey(id), id, score);
    for (const bare of stripProviderPrefixes(id)) register(separatorAgnosticKey(bare), id, score);

    if (!hasPricing(entry)) continue;
    if (!isOfficialSource(id, provider)) continue;
    // 家族键同时登记尾段，使 `opus-4-8` 这类省了厂商前缀的别名也能回到 `claude-opus`
    for (const family of familyKeysOf(id)) {
      const bucket = familyGroups.get(family) || [];
      bucket.push({ id, score, version: versionTuple(id) });
      familyGroups.set(family, bucket);
    }
  }

  const bestOf = (
    bucket: Array<{ id: string; score: number }> | undefined,
  ): { id: string; score: number } | null => {
    if (!bucket || !bucket.length) return null;
    return bucket.reduce((a, b) => (b.score > a.score ? b : a));
  };

  /**
   * 同一模型的不同写法（原名 / 去供应商前缀 / 点号 ARN）合并竞价。
   * `openai/gpt-5.5`（聚合商拼写的键）与 `gpt-5.5`（官方裸键）是同一个模型，
   * 先命中先赢会让聚合商抢走官方牌价，所以要跨写法取最高分。
   */
  const bestAcrossWritings = (name: string): { id: string; score: number } | null => {
    let best: { id: string; score: number } | null = null;
    for (const writing of [name, ...stripProviderPrefixes(name)]) {
      const hit = bestOf(keyGroups.get(separatorAgnosticKey(writing)));
      if (hit && (!best || hit.score > best.score)) best = hit;
    }
    return best;
  };

  return (name: string): PricingMatch<T> | null => {
    const raw = (name || '').trim();
    if (!raw) return null;

    const toMatch = (id: string, strategy: PricingMatchStrategy): PricingMatch<T> | null => {
      const entry = data[id];
      if (!entry) return null;
      return { modelId: id, entry, strategy, provider: entryProvider(entry) };
    };

    // 1) 同一个模型的不同写法（前缀 / 括号 / 分隔符）：不开新模型，只跨写法竞价
    const sameModel = bestAcrossWritings(raw);
    if (sameModel) {
      return toMatch(sameModel.id, sameModel.id === raw ? 'exact' : 'normalized');
    }

    // 2) 剥装饰后缀（快照日期、-global、@default、Bedrock ARN 等），仍按官方牌价择优
    for (const candidate of pricingCandidates(raw)) {
      if (candidate === raw) continue;
      const hit = bestAcrossWritings(candidate);
      const matched = hit && toMatch(hit.id, 'alias');
      if (matched) return matched;
    }

    // 3) 同家族最近邻（上层的 modelId 在预设表里根本不存在时）
    const family = modelFamily(raw);
    const bucket = familyGroups.get(family);
    if (bucket && bucket.length) {
      const target = versionTuple(raw);
      let bestId: string | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      let bestScore = Number.NEGATIVE_INFINITY;
      let bestLength = Number.POSITIVE_INFINITY;
      for (const item of bucket) {
        const distance = versionDistance(target, item.version);
        if (distance === null) continue;
        // 序：版本距离 > 名字修饰最少 > 牌价来源权重。同一版本常带多个价档后缀
        // （-highspeed / -flash），先取最素的那个，不然会把参考价定到另一个价档上。
        if (
          distance < bestDistance ||
          (distance === bestDistance &&
            (item.id.length < bestLength ||
              (item.id.length === bestLength && item.score > bestScore)))
        ) {
          bestDistance = distance;
          bestScore = item.score;
          bestLength = item.id.length;
          bestId = item.id;
        }
      }
      if (bestId) {
        const matched = toMatch(bestId, 'family');
        if (matched) return matched;
      }
    }

    return null;
  };
}
