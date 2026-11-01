<template>
  <div class="quota-info">
    <div class="quota-info-row">
      <span class="quota-info-title">{{ title }}</span>
      <n-button
        size="tiny"
        quaternary
        circle
        class="quota-info-trigger"
        :aria-expanded="open ? 'true' : 'false'"
        :aria-controls="PANEL_ID"
        :aria-label="t('virtualKeys.quotas.infoAria')"
        @click="emit('update:open', !open)"
      >
        <template #icon>
          <n-icon :component="InfoOutlined" />
        </template>
      </n-button>
    </div>
    <!-- v-show (not v-if) so aria-controls always resolves to a real node. -->
    <div v-show="open" :id="PANEL_ID" class="quota-info-panel" role="note">
      <span class="quota-info-panel-title">{{ t('virtualKeys.quotas.hintTitle') }}</span>
      <p class="quota-info-panel-text">
        {{ t(period === 'daily' ? 'virtualKeys.quotas.hintDaily' : 'virtualKeys.quotas.hintWeekly') }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { NButton, NIcon } from 'naive-ui'
import { InfoOutlined } from '@vicons/material'
import type { VirtualKeyQuotaPeriod } from '@/api/virtual-key'

defineProps<{
  title: string
  period: VirtualKeyQuotaPeriod
  open: boolean
}>()

const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>()

const { t } = useI18n()

// Only one quota modal exists at a time; a constant id keeps the
// aria-controls wiring simple and stable.
const PANEL_ID = 'virtual-key-quota-info-panel'
</script>

<style scoped>
.quota-info {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.quota-info-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.quota-info-title {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.quota-info-trigger {
  flex-shrink: 0;
  color: #999;
}

.quota-info-trigger:hover {
  color: var(--color-primary, #0f6b4a);
}

.quota-info-panel {
  font-size: 12px;
  line-height: 1.6;
  color: #666;
  background: #fafafa;
  border: 1px solid #ececec;
  border-radius: 6px;
  padding: 10px 12px;
  max-height: 200px;
  overflow-y: auto;
}

.quota-info-panel-title {
  display: block;
  font-weight: 600;
  color: #444;
  margin-bottom: 4px;
}

.quota-info-panel-text {
  margin: 0;
  white-space: pre-line;
}
</style>
