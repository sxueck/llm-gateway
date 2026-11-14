<template>
  <NTooltip v-if="availability" trigger="hover" placement="top">
    <template #trigger>
      <div class="availability-cell">
        <span class="dot" :class="dotClass" />
        <span class="rate" :class="rateTextClass">{{ rateText }}</span>
        <div class="bars">
          <span v-for="slot in hourSlots" :key="slot.start" class="bar" :class="slot.cls" />
        </div>
      </div>
    </template>
    {{ tooltipText }}
  </NTooltip>
  <span v-else class="no-traffic">{{ t('models.availabilityNoTraffic') }}</span>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { NTooltip } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import type { ModelAvailability } from '@/types';

const props = defineProps<{ availability: ModelAvailability | null }>();
const { t } = useI18n();

const successRate = computed(() => {
  if (!props.availability || props.availability.total <= 0) return null;
  return props.availability.success / props.availability.total;
});

// 圆点与成功率颜色同一口径：≥95% 绿 / ≥50% 黄 / 其余红；无调用由父级展示"暂无调用"
const dotClass = computed(() => {
  const rate = successRate.value;
  if (rate === null) return 'dot-gray';
  if (rate >= 0.95) return 'dot-green';
  if (rate >= 0.5) return 'dot-amber';
  return 'dot-red';
});

const rateTextClass = computed(() =>
  dotClass.value === 'dot-gray' ? 'rate-gray' : dotClass.value.replace('dot-', 'rate-')
);

const rateText = computed(() => {
  const rate = successRate.value;
  if (rate === null) return '—';
  return `${(rate * 100).toFixed(rate >= 0.999 ? 0 : 1)}%`;
});

// 近 24 个整点小时槽（含当前小时）；稀疏桶补空，Uptime-Kuma 心跳条风格：
// 绿=全成功，黄=部分成功，红=全失败，灰=该小时无调用
const hourSlots = computed(() => {
  const byStart = new Map<number, { total: number; success: number }>();
  for (const bucket of props.availability?.buckets ?? []) {
    byStart.set(bucket.start, { total: bucket.total, success: bucket.success });
  }
  const currentHour = Math.floor(Date.now() / 3_600_000);
  const slots: { start: number; cls: string }[] = [];
  for (let i = 23; i >= 0; i--) {
    const start = (currentHour - i) * 3_600_000;
    const bucket = byStart.get(start);
    let cls = 'bar-empty';
    if (bucket && bucket.total > 0) {
      cls = bucket.success === bucket.total
        ? 'bar-ok'
        : bucket.success === 0 ? 'bar-fail' : 'bar-partial';
    }
    slots.push({ start, cls });
  }
  return slots;
});

// 复用 agentMetrics.relative 的通用相对时间文案（仓库无共享工具）
function formatRelativeTime(timestamp: number): string {
  const minutes = Math.floor(Math.max(0, Date.now() - timestamp) / 60_000);
  if (minutes < 1) return t('agentMetrics.relative.justNow');
  if (minutes < 60) return t('agentMetrics.relative.minutesAgo', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('agentMetrics.relative.hoursAgo', { n: hours });
  return t('agentMetrics.relative.daysAgo', { n: Math.floor(hours / 24) });
}

const tooltipText = computed(() =>
  props.availability
    ? t('models.availabilityTooltip', {
        total: props.availability.total,
        success: props.availability.success,
        time: formatRelativeTime(props.availability.lastUsedAt),
      })
    : ''
);
</script>

<style scoped>
.availability-cell {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.dot-green {
  background: var(--color-success);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-success) 15%, transparent);
}

.dot-amber {
  background: var(--color-warning);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-warning) 15%, transparent);
}

.dot-red {
  background: var(--color-error);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-error) 15%, transparent);
}

.dot-gray {
  background: var(--color-neutral-300);
}

.rate {
  flex-shrink: 0;
  min-width: 42px;
  font-size: 12px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.rate-green { color: var(--color-success); }
.rate-amber { color: var(--color-warning); }
.rate-red { color: var(--color-error); }
.rate-gray { color: var(--color-neutral-700); }

.bars {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 14px;
}

.bar {
  width: 5px;
  height: 100%;
  border-radius: 1.5px;
  background: var(--color-neutral-200);
}

.bar-ok { background: var(--color-success); }
.bar-partial { background: var(--color-warning); }
.bar-fail { background: var(--color-error); }
.bar-empty { background: var(--color-neutral-200); }

.no-traffic {
  color: var(--color-neutral-700);
  font-size: 12px;
}
</style>
