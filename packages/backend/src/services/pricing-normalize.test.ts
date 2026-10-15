import { describe, expect, it } from 'vitest';
import {
  createPresetResolver,
  isFamilyOwner,
  normalizePricingKey,
  pricingCandidates,
  providerPriority,
  versionDistance,
  versionTuple,
} from './pricing-normalize.js';

interface Fake {
  provider?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
}

const presets: Record<string, Fake> = {
  'claude-opus-4-8': { provider: 'anthropic', input_cost_per_token: 5e-6, output_cost_per_token: 2.5e-5 },
  'claude-haiku-4-5-20251001': { provider: 'anthropic', input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 },
  'gpt-5.5': { provider: 'openai', input_cost_per_token: 5e-6, output_cost_per_token: 3e-5 },
  'openai/gpt-5.5': { provider: 'openrouter', input_cost_per_token: 6e-6, output_cost_per_token: 3.3e-5 },
  'glm-5.2': { provider: 'alibaba', input_cost_per_token: 1.4e-6, output_cost_per_token: 4.4e-6 },
  'z-ai/glm-5.2': { provider: 'zai', input_cost_per_token: 1.4e-6, output_cost_per_token: 4.4e-6 },
  'kimi-k2.6': { provider: 'moonshotai-cn', input_cost_per_token: 2e-6, output_cost_per_token: 8e-6 },
  'qwen3.7-max': { provider: 'alibaba', input_cost_per_token: 2.5e-6, output_cost_per_token: 7.5e-6 },
  'deepinfra-llama-3.3-70b': { provider: 'deepinfra', input_cost_per_token: 1e-7 },
};

const resolve = createPresetResolver<Fake>(presets);

describe('pricingCandidates', () => {
  it('剥掉装饰后缀并逐级回退', () => {
    const candidates = pricingCandidates('gpt-5.5-0424-global');
    expect(candidates).toContain('gpt-5.5');
    expect(candidates[0]).toBe('gpt-5.5-0424-global');
    // 越靠前越忠实于原名
    expect(candidates.indexOf('gpt-5.5')).toBeGreaterThan(candidates.indexOf('gpt-5.5-0424'));
  });

  it('去方括号标记与前缀', () => {
    expect(normalizePricingKey('claude-opus-4-8[1m]')).toBe('claude-opus-4-8');
    expect(pricingCandidates('openrouter/anthropic/claude-sonnet-4.5')).toContain('claude-sonnet-4.5');
  });

  it('保留真实的价格档位', () => {
    // pro / mini / vision 是独立计价，不能当噪声剥掉
    expect(pricingCandidates('deepseek-v4-pro')).toContain('deepseek-v4-pro');
    expect(pricingCandidates('gpt-5.4-mini').some(c => c.includes('mini'))).toBe(true);
  });
});

describe('providerPriority / isFamilyOwner', () => {
  it('官方实验室高于任何代售', () => {
    expect(providerPriority('anthropic')).toBeGreaterThan(providerPriority('openrouter'));
    expect(providerPriority('moonshotai-cn')).toBeGreaterThan(providerPriority('alibaba'));
    // 包月套餐入口不代表 API 牌价
    expect(providerPriority('kimi-code-plan-cn')).toBeLessThan(providerPriority('moonshotai-cn'));
    expect(providerPriority('zhipuai-coding-plan')).toBeLessThan(providerPriority('zai'));
  });

  it('识别模型的自研方', () => {
    expect(isFamilyOwner('kimi-k2.6', 'moonshotai-cn')).toBe(true);
    expect(isFamilyOwner('kimi-k2.6', 'alibaba')).toBe(false);
    expect(isFamilyOwner('glm-5.2', 'zai')).toBe(true);
    expect(isFamilyOwner('qwen3.7-max', 'alibaba')).toBe(true);
  });
});

describe('createPresetResolver', () => {
  it('原名精确命中优先于一切归一', () => {
    const hit = resolve('gpt-5.5');
    expect(hit?.strategy).toBe('exact');
    expect(hit?.provider).toBe('openai');
  });

  it('带上下文标记的名字归一到官方条目', () => {
    const hit = resolve('claude-opus-4-8[1m]');
    expect(hit?.modelId).toBe('claude-opus-4-8');
    expect(hit?.entry.input_cost_per_token).toBe(5e-6);
    expect(hit?.strategy).not.toBe('exact');
  });

  it('日期 + 渠道标签一起剥', () => {
    expect(resolve('gpt-5.5-0424-global')?.modelId).toBe('gpt-5.5');
    expect(resolve('claude-haiku-4-5')?.modelId).toBe('claude-haiku-4-5-20251001');
  });

  it('同一牌价的多个键里取官方实验室', () => {
    // openai/gpt-5.5 是聚合商加价条目，必须输给 gpt-5.5(openai)
    expect(resolve('openai/gpt-5.5')?.provider).toBe('openai');
    // 裸名 glm-5.2 被 alibaba 抢走，但 zai 的同价条目权重更高
    expect(resolve('glm-5.2')?.provider).toBe('zai');
  });

  it('跨前缀写法也能归一', () => {
    expect(resolve('moonshot-ai/kimi-k2.6')?.modelId).toBe('kimi-k2.6');
    expect(resolve('qwen/qwen3.7-max')?.provider).toBe('alibaba');
  });

  it('同族最近邻兜底，且只在官方实验室里找', () => {
    const hit = resolve('kimi-k2.9');
    expect(hit?.strategy).toBe('family');
    expect(hit?.modelId).toBe('kimi-k2.6');
    // 跨代（主版本不同）不可比价
    expect(resolve('deepinfra-llama-3.3-70b')?.strategy).toBe('exact');
    expect(resolve('kimi-k9')).toBeNull(); // 跨代不可比价（主版本 9 vs 2）
    expect(resolve('llama-3.3-90b')).toBeNull(); // deepinfra 非自研方，不参与家族回退
  });

  it('完全无关的名字返回 null 而不是硬塞一个价', () => {
    expect(resolve('zzz-unknown-model')).toBeNull();
    expect(resolve('')).toBeNull();
  });

  it('版本工具按主版本判代', () => {
    expect(versionTuple('claude-opus-4-8')).toEqual([4, 8]);
    expect(versionDistance([4, 8], [4, 5])).toBe(3);
    expect(versionDistance([5], [4])).toBeNull();
    // 日期尾巴不参与比价
    expect(versionDistance([4, 5, 20251001], [4, 8])).toBe(3);
  });
});

describe('家族最近邻的并列取舍', () => {
  it('同距离同来源时取修饰最少的型号（不借 -highspeed 价档）', () => {
    const local = createPresetResolver<Fake>({
      'kimi-k2.7-code-highspeed': { provider: 'moonshotai-cn', input_cost_per_token: 1.9e-6, output_cost_per_token: 9e-6 },
      'kimi-k2.7-code': { provider: 'moonshotai-cn', input_cost_per_token: 0.95e-6, output_cost_per_token: 4e-6 },
    });
    const hit = local('kimi-k2.9');
    expect(hit?.modelId).toBe('kimi-k2.7-code');
  });
});
