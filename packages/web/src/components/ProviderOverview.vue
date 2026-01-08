<template>
  <n-card class="overview-card">
    <template #header>
      <div class="card-header">
        <span class="card-title">{{ t('providers.overview') }}</span>
      </div>
    </template>

    <n-grid :cols="2" :x-gap="12" :y-gap="12">
      <n-gi>
        <div class="stat-item">
          <div class="stat-value">{{ stats.total }}</div>
          <div class="stat-label">{{ t('common.total') }}</div>
        </div>
      </n-gi>
      <n-gi>
        <div class="stat-item">
          <div class="stat-value stat-enabled">{{ stats.enabled }}</div>
          <div class="stat-label">{{ t('common.enabled') }}</div>
        </div>
      </n-gi>
    </n-grid>
  </n-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NCard,
  NGrid,
  NGi,
} from 'naive-ui';
import type { Provider } from '@/types';

const { t } = useI18n();

interface Props {
  providers: Provider[];
}

const props = defineProps<Props>();

const stats = computed(() => {
  const total = props.providers.length;
  const enabled = props.providers.filter(p => p.enabled).length;

  return {
    total,
    enabled,
  };
});
</script>

<style scoped>
.overview-card {
  background: #ffffff;
  border-radius: 16px;
  border: none;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-title {
  font-size: 16px;
  font-weight: 600;
  color: #1a1a1a;
  letter-spacing: -0.02em;
}

.stat-item {
  padding: 16px;
  background: linear-gradient(135deg, #f8f9fa 0%, #f0f1f3 100%);
  border-radius: 12px;
  text-align: center;
  border: none;
  transition: all 0.3s ease;
}

.stat-item:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
}

.stat-value {
  font-size: 32px;
  font-weight: 600;
  color: #1a1a1a;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}

.stat-value.stat-enabled {
  color: #0f6b4a;
}

.stat-label {
  font-size: 13px;
  color: #8c8c8c;
  margin-top: 6px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}
</style>
