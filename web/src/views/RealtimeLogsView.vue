<template>
  <n-card title="实时日志">
    <template #header-extra>
      <n-button @click="clear">清空</n-button>
    </template>

    <div class="logs">
      <div v-for="log in logs" :key="log.time + log.message" class="log">
        <span class="time">{{ log.time }}</span>
        <span class="level" :class="log.level.toLowerCase()">{{ log.level }}</span>
        <span class="module" v-if="log.module">[{{ log.module }}]</span>
        <span class="message">{{ log.message }}</span>
      </div>
    </div>
  </n-card>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

const logs = ref<any[]>([]);
let eventSource: EventSource | null = null;

function connect() {
  eventSource = new EventSource('/api/admin/config/realtime-logs');
  eventSource.onmessage = (event) => {
    const log = JSON.parse(event.data);
    logs.value.push(log);

    // 简单限制日志数量
    if (logs.value.length > 500) {
      logs.value = logs.value.slice(-250);
    }
  };
}

function clear() {
  logs.value = [];
}

onMounted(connect);
onUnmounted(() => eventSource?.close());
</script>

<style scoped>
.logs {
  font-family: monospace;
  font-size: 12px;
  max-height: 600px;
  overflow-y: auto;
  background: #fafafa;
  padding: 12px;
  border-radius: 6px;
}

.log {
  padding: 4px 0;
  border-bottom: 1px solid #f0f0f0;
}

.time {
  color: #666;
  margin-right: 8px;
}

.level {
  padding: 2px 6px;
  border-radius: 3px;
  margin-right: 8px;
  font-weight: bold;
  font-size: 10px;
}

.level.info { background: #e6f7ff; color: #1890ff; }
.level.warn { background: #fff7e6; color: #fa8c16; }
.level.error { background: #fff2f0; color: #f5222d; }
.level.debug { background: #f6f6f6; color: #666; }

.module {
  color: #999;
  margin-right: 8px;
}

.message {
  color: #333;
}
</style>
