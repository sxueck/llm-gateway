<template>
  <n-card class="overview-card">
    <template #header>
      <div class="card-header">
        <span class="card-title">提供商概览</span>
      </div>
    </template>

    <n-grid :cols="2" :x-gap="12" :y-gap="12">
      <n-gi>
        <div class="stat-item">
          <div class="stat-value">{{ stats.total }}</div>
          <div class="stat-label">总数</div>
        </div>
      </n-gi>
      <n-gi>
        <div class="stat-item">
          <div class="stat-value stat-enabled">{{ stats.enabled }}</div>
          <div class="stat-label">已启用</div>
        </div>
      </n-gi>
    </n-grid>
  </n-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import {
  NCard,
  NGrid,
  NGi,
} from 'naive-ui';
import type { Provider } from '@/types';

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
  border-radius: 8px;
  border: 1px solid #e8e8e8;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.card-title {
  font-size: 15px;
  font-weight: 600;
  color: #262626;
}

.stat-item {
  padding: 12px;
  background: #f8f9fa;
  border-radius: 8px;
  text-align: center;
  border: 1px solid #e8e8e8;
}

.stat-value {
  font-size: 28px;
  font-weight: 700;
  color: #262626;
  line-height: 1.2;
}

.stat-value.stat-enabled {
  color: #18a058;
}

.stat-label {
  font-size: 12px;
  color: #8c8c8c;
  margin-top: 4px;
}
</style>
