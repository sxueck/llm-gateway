import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPresetResolver, type PricingMatch } from './pricing-normalize.js';

interface FakePreset {
  provider?: string;
  litellm_provider?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_cost_per_token?: number;
}

const PRESETS: Record<string, FakePreset> = {
  'gpt-5.5': { provider: 'openai', input_cost_per_token: 5e-6, output_cost_per_token: 3e-5 },
  'openai/gpt-5.5': { provider: 'openrouter', input_cost_per_token: 6e-6, output_cost_per_token: 3.3e-5 },
  'claude-opus-4-8': { provider: 'anthropic', input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5, cache_read_cost_per_token: 5e-7 },
  'kimi-k2.6': { provider: 'moonshotai-cn', input_cost_per_token: 2e-6, output_cost_per_token: 8e-6 },
};

const getEnabledMappings = vi.hoisted(() => vi.fn());
const resolvePreset = vi.hoisted(() => vi.fn());
const getModelInfo = vi.hoisted(() => vi.fn());

vi.mock('../db/index.js', () => ({ costMappingDb: { getEnabledMappings } }));
vi.mock('./model-presets.js', () => ({
  modelPresetsService: { resolvePreset, getModelInfo },
}));

const { costMappingService, hasTokenPricing } = await import('./cost-mapping.js');

/** 用真实解析器跑预设表，只把 service 的两个读接口桩掉。 */
beforeEach(() => {
  const resolver = createPresetResolver<FakePreset>(PRESETS);
  resolvePreset.mockImplementation((name: string) => resolver(name) as PricingMatch<never> | null);
  getModelInfo.mockImplementation((name: string) => PRESETS[name] ?? null);
  getEnabledMappings.mockResolvedValue([]);
});

describe('hasTokenPricing', () => {
  it('显式零价也属于已知价格', () => {
    expect(hasTokenPricing({ input_cost_per_token: 0, output_cost_per_token: 0 })).toBe(true);
    expect(hasTokenPricing({ cache_read_cost_per_token: 0 })).toBe(true);
  });

  it('没有 token 单价时不是已知价格', () => {
    expect(hasTokenPricing({ max_tokens: 128000 })).toBe(false);
  });
});

describe('resolveModelCost 取价优先级', () => {
  it('原名精确命中记为 direct', async () => {
    const cost = await costMappingService.resolveModelCost('gpt-5.5');
    expect(cost?.source).toBe('direct');
    expect(cost?.provider).toBe('openai');
    expect(cost?.info.input_cost_per_token).toBe(5e-6);
  });

  it('带装饰后缀的名字归一到官方牌价，不再是 0 成本', async () => {
    const cost = await costMappingService.resolveModelCost('gpt-5.5-0424-global');
    expect(cost?.source).toBe('official');
    expect(cost?.model).toBe('gpt-5.5');
    expect(cost?.info.input_cost_per_token).toBe(5e-6);
  });

  it('聚合商前缀写法也按官方实验室计价', async () => {
    const cost = await costMappingService.resolveModelCost('openai/gpt-5.5');
    // 聚合商自己的加价条目不能当成本基准
    expect(cost?.source).not.toBe('direct');
    expect(cost?.info.input_cost_per_token).toBe(5e-6);
  });

  it('人工映射赢过任何推断', async () => {
    getEnabledMappings.mockResolvedValue([
      { pattern: 'gpt-5.5-*', target_model: 'claude-opus-4-8', enabled: 1 },
    ]);
    const cost = await costMappingService.resolveModelCost('gpt-5.5-0424-global');
    expect(cost?.source).toBe('mapping');
    expect(cost?.mapping_pattern).toBe('gpt-5.5-*');
    expect(cost?.info.input_cost_per_token).toBe(5e-6);
  });

  it('预设表没有这个型号时给同家族参考价并标成 approx', async () => {
    const cost = await costMappingService.resolveModelCost('kimi-k2.9-fast');
    expect(cost?.source).toBe('approx');
    expect(cost?.model).toBe('kimi-k2.6');
  });

  it('完全无关的名字仍是 null（展示为未知而不是 0）', async () => {
    expect(await costMappingService.resolveModelCost('no-such-lab-model')).toBeNull();
  });
});

describe('estimateUsageCost', () => {
  it('按官方单价计算输入/输出/缓存读', async () => {
    const cost = await costMappingService.estimateUsageCost('claude-opus-4-8[1m]', {
      promptTokens: 1_000_000,
      completionTokens: 100_000,
      cachedTokens: 500_000,
    });
    // 5M in + 2.5M out(=2.5) + cache_read 0.5/M*0.5M(0.25)
    expect(cost).toBeCloseTo(5 + 2.5 + 0.25, 6);
  });

  it('无价模型返回 null 而不是 0', async () => {
    expect(
      await costMappingService.estimateUsageCost('no-such-lab-model', {
        promptTokens: 1000,
        completionTokens: 1000,
      }),
    ).toBeNull();
  });
});
