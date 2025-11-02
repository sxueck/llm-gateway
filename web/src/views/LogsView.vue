<template>
  <div>
    <n-space vertical :size="24">
      <n-card title="系统日志">
        <template #header-extra>
          <n-space>
            <n-select
              v-model:value="selectedLevel"
              :options="levelOptions"
              style="width: 120px;"
              placeholder="日志级别"
            />
            <n-select
              v-model:value="logLimit"
              :options="limitOptions"
              style="width: 150px;"
              @update:value="loadLogs"
            />
            <n-button @click="loadLogs" :loading="loading">
              刷新
            </n-button>
          </n-space>
        </template>

        <n-space vertical :size="12">
          <n-input
            v-model:value="searchText"
            placeholder="搜索日志内容..."
            clearable
          >
            <template #prefix>
              <n-icon><SearchOutline /></n-icon>
            </template>
          </n-input>

          <div class="terminal-container">
            <n-scrollbar ref="scrollbarRef" style="max-height: 900px;">
              <pre v-if="filteredLogText" class="terminal-output">{{ filteredLogText }}</pre>
              <n-empty v-else description="暂无日志数据" :show-icon="false" />
            </n-scrollbar>
          </div>
        </n-space>
      </n-card>
    </n-space>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import { useMessage, NSpace, NCard, NButton, NSelect, NInput, NIcon, NScrollbar, NEmpty } from 'naive-ui';
import { SearchOutline } from '@vicons/ionicons5';
import { configApi, type LogEntry } from '@/api/config';
import { formatTimestamp } from '@/utils/common';

const message = useMessage();
const loading = ref(false);
const scrollbarRef = ref<InstanceType<typeof NScrollbar> | null>(null);
const allLogsText = ref('');
const searchText = ref('');
const selectedLevel = ref<string>('ALL');
const logLimit = ref(100);
let autoRefreshTimer: number | null = null;

const levelOptions = [
  { label: 'ALL', value: 'ALL' },
  { label: 'INFO', value: 'INFO' },
  { label: 'WARN', value: 'WARN' },
  { label: 'ERROR', value: 'ERROR' },
  { label: 'DEBUG', value: 'DEBUG' },
];

const limitOptions = [
  { label: '最近 50 条', value: 50 },
  { label: '最近 100 条', value: 100 },
  { label: '最近 200 条', value: 200 },
  { label: '最近 500 条', value: 500 },
  { label: '最近 1000 条', value: 1000 },
];

const filteredLogText = computed(() => {
  let text = allLogsText.value;

  if (!text) return '';

  const lines = text.split('\n');
  let filteredLines = lines;

  if (selectedLevel.value && selectedLevel.value !== 'ALL') {
    const levelRegex = new RegExp(`\\[${selectedLevel.value}\\]`, 'i');
    filteredLines = filteredLines.filter(line => levelRegex.test(line));
  }

  if (searchText.value) {
    const searchRegex = new RegExp(searchText.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filteredLines = filteredLines.filter(line => searchRegex.test(line));
  }

  return filteredLines.join('\n');
});

function formatLogEntry(log: LogEntry): string {
  const timestamp = formatTimestamp(log.timestamp);
  const level = log.level;
  const module = log.module ? `[${log.module}]` : '';
  return `[${timestamp}] [${level}] ${module} ${log.message}`;
}

async function loadLogs() {
  try {
    loading.value = true;
    const logsData = await configApi.getLogs({
      limit: logLimit.value,
    });

    if (logsData?.logs && Array.isArray(logsData.logs)) {
      allLogsText.value = logsData.logs.map(formatLogEntry).join('\n');

      await nextTick();
      scrollbarRef.value?.scrollTo({ top: scrollbarRef.value.$el.scrollHeight });
    }
  } catch (error: any) {
    message.error(error.message);
  } finally {
    loading.value = false;
  }
}

function startAutoRefresh() {
  autoRefreshTimer = window.setInterval(() => {
    loadLogs();
  }, 10000);
}

function stopAutoRefresh() {
  if (autoRefreshTimer !== null) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

onMounted(() => {
  loadLogs();
  startAutoRefresh();
});

onUnmounted(() => {
  stopAutoRefresh();
});
</script>

<style scoped>
.terminal-container {
  background-color: #ffffff;
  border: 1px solid #e8e8e8;
  border-radius: 4px;
  padding: 16px;
}

.terminal-output {
  font-family: 'MiSans', 'Consolas', 'Monaco', 'Courier New', 'Menlo', monospace;
  font-size: 13px;
  line-height: 1.6;
  color: #000000;
  margin: 0;
  white-space: pre-wrap;
  word-wrap: break-word;
}

.terminal-output::selection {
  background-color: #b3d4fc;
}
</style>

