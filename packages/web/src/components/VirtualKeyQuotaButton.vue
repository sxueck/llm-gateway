<template>
  <n-tooltip placement="top">
    <template #trigger>
      <n-button
        size="small"
        quaternary
        circle
        class="quota-status-button"
        :class="{ 'is-exhausted': isExhausted }"
        :style="iconColor ? { color: iconColor } : undefined"
        :loading="isLoading"
        :aria-label="label"
        @click="emit('select')"
      >
        <template #icon>
          <n-icon :component="SpeedometerOutline" />
        </template>
      </n-button>
    </template>
    {{ label }}
  </n-tooltip>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NIcon, NTooltip } from 'naive-ui'
import { SpeedometerOutline } from '@vicons/ionicons5'
import { quotaHealthColor } from '@/utils/virtual-key-quota'
import { formatTokenNumber } from '@/utils/format'
import type { VirtualKeyQuotaStatus } from '@/composables/useVirtualKeyQuotaStatus'

const props = defineProps<{
  status: VirtualKeyQuotaStatus | null
}>()

const emit = defineEmits<{ (e: 'select'): void }>()

const { t } = useI18n()

const isLoading = computed(() => props.status == null || props.status.phase === 'loading')

const isExhausted = computed(() => props.status?.phase === 'loaded' && props.status.health.state === 'exhausted')

const iconColor = computed(() => {
  if (props.status?.phase !== 'loaded') return null
  const { state, ratio } = props.status.health
  if (state === 'unconfigured') return null
  return quotaHealthColor(ratio)
})

const label = computed(() => {
  const status = props.status
  if (!status || status.phase === 'loading') return t('virtualKeys.quotaStatus.loading')
  if (status.phase === 'error') return t('virtualKeys.quotaStatus.loadError')
  const { state, ratio, detail } = status.health
  if (state === 'unconfigured' || !detail) return t('virtualKeys.quotaStatus.unconfigured')
  const params = {
    percent: String(Math.round(ratio * 100)),
    model: detail.model,
    used: formatTokenNumber(detail.usedTokens),
    limit: formatTokenNumber(detail.limitTokens),
    period: t(
      detail.period === 'daily'
        ? 'virtualKeys.quotaStatus.periodDaily'
        : 'virtualKeys.quotaStatus.periodWeekly'
    )
  }
  return t(state === 'exhausted' ? 'virtualKeys.quotaStatus.exhausted' : 'virtualKeys.quotaStatus.usage', params)
})
</script>

<style scoped>
.quota-status-button.is-exhausted {
  font-weight: 600;
}
</style>
