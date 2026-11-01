import { createSSRApp, defineComponent, h } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@vicons/ionicons5', () => ({ SpeedometerOutline: 'icon-speedometer' }));
vi.mock('naive-ui', () => {
  const stub = defineComponent({
    inheritAttrs: false,
    setup(_, { attrs, slots }) {
      return () => h('div', attrs, [...(slots.trigger?.() ?? []), ...(slots.default?.() ?? [])]);
    },
  });
  return { NButton: stub, NIcon: stub, NTooltip: stub };
});

import VirtualKeyQuotaButton from './VirtualKeyQuotaButton.vue';
import type { VirtualKeyQuotaStatus } from '@/composables/useVirtualKeyQuotaStatus';

async function renderButton(status: VirtualKeyQuotaStatus | null) {
  return renderToString(createSSRApp({ render: () => h(VirtualKeyQuotaButton, { status }) }));
}

describe('VirtualKeyQuotaButton', () => {
  it('shows pending rather than an error before the status is fetched', async () => {
    const html = await renderButton(null);
    expect(html).toContain('aria-label="virtualKeys.quotaStatus.loading"');
    expect(html).not.toContain('virtualKeys.quotaStatus.loadError');
  });

  it('distinguishes a failed fetch from an active quota', async () => {
    expect(await renderButton({ phase: 'error', message: 'boom' })).toContain('aria-label="virtualKeys.quotaStatus.loadError"');
    const html = await renderButton({
      phase: 'loaded',
      health: { state: 'active', ratio: 0.5, detail: { model: 'm', period: 'daily', usedTokens: 500_000, limitTokens: 1_000_000 } },
    });
    expect(html).toContain('aria-label="virtualKeys.quotaStatus.usage"');
    expect(html).toContain('color:#f0a020');
  });
});
