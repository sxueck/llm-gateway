<template>
  <n-modal
    :show="show"
    preset="card"
    title="检查详情"
    style="width: 500px"
    :bordered="false"
    size="small"
    @update:show="$emit('update:show', $event)"
  >
    <div v-if="check">
      <n-descriptions bordered :column="1" size="small">
        <n-descriptions-item label="状态">
          <n-tag :type="check.status === 'success' ? 'success' : 'error'" size="small">
            {{ check.status === 'success' ? '成功' : '失败' }}
          </n-tag>
        </n-descriptions-item>
        <n-descriptions-item label="检查时间">
          {{ new Date(check.timestamp).toLocaleString('zh-CN') }}
        </n-descriptions-item>
        <n-descriptions-item label="延迟">
          {{ check.latencyMs }}ms
        </n-descriptions-item>
        <n-descriptions-item v-if="check.errorMessage" label="错误信息">
          <n-text type="error">{{ check.errorMessage }}</n-text>
        </n-descriptions-item>
      </n-descriptions>
    </div>
  </n-modal>
</template>

<script setup lang="ts">
import {
  NModal,
  NDescriptions,
  NDescriptionsItem,
  NTag,
  NText,
} from 'naive-ui';

interface HealthCheck {
  status: 'success' | 'error';
  timestamp: number;
  latencyMs: number;
  errorMessage?: string;
}

defineProps<{
  show: boolean;
  check: HealthCheck | null;
}>();

defineEmits<{
  (e: 'update:show', value: boolean): void;
}>();
</script>
