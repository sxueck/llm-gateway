<template>
  <div class="tier-model-card">
    <div class="card-main">
      <div class="card-title-row">
        <n-text class="card-name" :title="label">{{ label }}</n-text>
        <n-space :size="4" align="center" :wrap="false">
          <n-tag size="tiny" :bordered="false" type="info">
            {{
              expert.type === 'virtual'
                ? t('expertRouting.virtualModel')
                : t('expertRouting.realModel')
            }}
          </n-tag>
          <n-tag size="tiny" :bordered="false" :type="bandTagType">
            {{ t(`expertRouting.band.${expert.band}`) }}
          </n-tag>
        </n-space>
      </div>
      <div class="card-sub" :title="subtitle">{{ subtitle }}</div>
    </div>
    <div class="card-actions">
      <n-button
        size="tiny"
        quaternary
        :disabled="first"
        :aria-label="t('expertRouting.moveUp')"
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
        @click="emit('remove')"
      >
        <template #icon>
          <n-icon><CloseOutline /></n-icon>
        </template>
      </n-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NIcon, NSpace, NTag, NText } from 'naive-ui';
import {
  ArrowDownOutline,
  ArrowUpOutline,
  CloseOutline,
} from '@vicons/ionicons5';
import type { Band, ExpertTarget } from '@/api/expert-routing';

interface Props {
  expert: ExpertTarget;
  label: string;
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

const bandTagType = computed(() => {
  const map: Record<Band, 'success' | 'warning' | 'error'> = {
    low: 'success',
    medium: 'warning',
    high: 'error',
  };
  return map[props.expert.band] ?? 'default';
});

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
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid #e8e8e8;
  border-radius: 8px;
  background: #ffffff;
  transition: border-color 0.2s ease;
}

.tier-model-card:hover {
  border-color: #bbb;
}

.card-main {
  min-width: 0;
  flex: 1;
}

.card-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.card-name {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-sub {
  margin-top: 2px;
  font-size: 12px;
  color: #8c8c8c;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}
</style>
