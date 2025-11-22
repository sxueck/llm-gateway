<template>
  <div class="health-timeline-component">
    <div v-if="history && history.length > 0" class="timeline-blocks">
      <div
        v-for="(check, idx) in history"
        :key="idx"
        class="timeline-block"
        :class="getCheckStatusClass(check.status)"
        :title="formatCheckTooltip(check)"
        @click="handleClick(check)"
      />
    </div>
    <div v-else class="no-data">
      <n-text depth="3" style="font-size: 12px">暂无检查记录</n-text>
    </div>
  </div>
</template>

<script setup lang="ts">
import { NText } from 'naive-ui';

interface HealthCheck {
  status: 'success' | 'error';
  timestamp: number;
  latencyMs: number;
  errorMessage?: string;
}

const props = defineProps<{
  history: HealthCheck[];
}>();

const emit = defineEmits<{
  (e: 'check-click', check: HealthCheck): void;
}>();

function getCheckStatusClass(status: 'success' | 'error') {
  return status === 'success' ? 'check-success' : 'check-error';
}

function formatTimestamp(ts: number) {
  const date = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - ts;

  if (diff < 60000) {
    return '刚刚';
  } else if (diff < 3600000) {
    return `${Math.floor(diff / 60000)} 分钟前`;
  } else if (diff < 86400000) {
    return `${Math.floor(diff / 3600000)} 小时前`;
  } else {
    return date.toLocaleString('zh-CN');
  }
}

function formatCheckTooltip(check: HealthCheck) {
  const time = formatTimestamp(check.timestamp);
  const statusText = check.status === 'success' ? '成功' : '失败';
  let tooltip = `${time} - ${statusText} (${check.latencyMs}ms)`;
  if (check.errorMessage) {
    tooltip += `\n错误: ${check.errorMessage}`;
  }
  return tooltip;
}

function handleClick(check: HealthCheck) {
  emit('check-click', check);
}
</script>

<style scoped>
.health-timeline-component {
  width: 100%;
}

.timeline-blocks {
  display: flex;
  gap: 2px;
  flex-wrap: wrap;
}

.timeline-block {
  width: 6px;
  height: 20px;
  border-radius: 1px;
  cursor: pointer;
  transition: all 0.2s;
}

.timeline-block:hover {
  transform: scaleY(1.3);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3);
  z-index: 10;
}

.timeline-block.check-success {
  background-color: #18a058;
}

.timeline-block.check-error {
  background-color: #d03050;
}

.no-data {
  text-align: center;
  padding: 8px 0;
}
</style>
