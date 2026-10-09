<template>
  <div class="tier-model-card" :style="{ borderColor: themeVars.borderColor, background: themeVars.cardColor, '--model-muted': themeVars.textColor3 }">
    <div class="card-main">
      <div class="card-title-row">
        <n-text class="card-name" :title="label">{{ label }}</n-text>
        <div class="card-meta">
          <n-tag size="tiny" :bordered="false" type="info">
            {{
              expert.type === 'virtual'
                ? t('expertRouting.virtualModel')
                : t('expertRouting.realModel')
            }}
          </n-tag>
        </div>
      </div>
      <div class="card-sub" :title="subtitle">{{ subtitle }}</div>
    </div>
    <div class="card-footer">
      <n-text depth="3" class="card-priority">{{ t('expertRouting.ui.priority', { order: priority }) }}</n-text>
      <div class="card-actions">
      <n-button
        size="tiny"
        quaternary
        :disabled="first"
        :aria-label="t('expertRouting.moveUp')"
        :title="t('expertRouting.moveUp')"
        @click="emit('moveUp')"
      >
        <template #icon>
          <n-icon><ArrowUpOutline /></n-icon>
        </template>
      </n-button>
      <n-button
        size="tiny"
        quaternary
        :disabled="last"
        :aria-label="t('expertRouting.moveDown')"
        :title="t('expertRouting.moveDown')"
        @click="emit('moveDown')"
      >
        <template #icon>
          <n-icon><ArrowDownOutline /></n-icon>
        </template>
      </n-button>
      <n-button
        size="tiny"
        quaternary
        type="error"
        :aria-label="t('expertRouting.remove')"
        :title="t('expertRouting.remove')"
        @click="emit('remove')"
      >
        <template #icon>
          <n-icon><CloseOutline /></n-icon>
        </template>
      </n-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NIcon, NTag, NText, useThemeVars } from 'naive-ui';
import {
  ArrowDownOutline,
  ArrowUpOutline,
  CloseOutline,
} from '@vicons/ionicons5';
import type { ExpertTarget } from '@/api/expert-routing';

interface Props {
  expert: ExpertTarget;
  label: string;
  priority: number;
  first?: boolean;
  last?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  first: false,
  last: false,
});

const emit = defineEmits<{
  moveUp: [];
  moveDown: [];
  remove: [];
}>();

const { t } = useI18n();

const themeVars = useThemeVars();

// 简单兜底：虚拟模型显示 model_id，实际模型显示 provider / model。
const subtitle = computed(() => {
  const e = props.expert;
  if (e.type === 'virtual') return e.model_id ?? '';
  return [e.provider_id, e.model].filter(Boolean).join(' / ');
});
</script>

<style scoped>
.tier-model-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid;
  border-radius: 8px;
  transition: box-shadow 0.2s ease;
}

.tier-model-card:hover {
  box-shadow: inset 0 0 0 1px var(--color-primary);
}

.card-main {
  min-width: 0;
  width: 100%;
}

.card-title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.card-name {
  font-size: 13px;
  font-weight: 500;
  overflow-wrap: anywhere;
}

.card-meta {
  flex: none;
}

.card-sub {
  margin-top: 2px;
  font-size: 12px;
  color: var(--model-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.card-priority {
  font-size: 12px;
}

.card-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  justify-content: flex-end;
  align-self: flex-end;
}
</style>
