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
              clearable
              @update:value="loadLogs"
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
          <n-descriptions :column="4" bordered size="small">
            <n-descriptions-item label="总日志数">
              {{ logsData?.stats?.total || 0 }}
            </n-descriptions-item>
            <n-descriptions-item label="INFO">
              <n-tag type="info" size="small">{{ logsData?.stats?.byLevel?.INFO || 0 }}</n-tag>
            </n-descriptions-item>
            <n-descriptions-item label="WARN">
              <n-tag type="warning" size="small">{{ logsData?.stats?.byLevel?.WARN || 0 }}</n-tag>
            </n-descriptions-item>
            <n-descriptions-item label="ERROR">
              <n-tag type="error" size="small">{{ logsData?.stats?.byLevel?.ERROR || 0 }}</n-tag>
            </n-descriptions-item>
          </n-descriptions>

          <n-input
            v-model:value="searchText"
            placeholder="搜索日志内容..."
            clearable
            @update:value="handleSearch"
          >
            <template #prefix>
              <n-icon><SearchOutline /></n-icon>
            </template>
          </n-input>

          <div class="log-container">
            <n-scrollbar style="max-height: 600px;">
              <div v-if="displayLogs.length > 0" class="log-list">
                <div v-for="(log, index) in displayLogs" :key="index" class="log-entry">
                  <n-tag :type="getLevelType(log.level)" size="small" style="width: 60px;">
                    {{ log.level }}
                  </n-tag>
                  <n-text depth="3" style="width: 150px;">
                    {{ formatTimestamp(log.timestamp) }}
                  </n-text>
                  <n-text v-if="log.module" depth="2" style="width: 100px;">
                    [{{ log.module }}]
                  </n-text>
                  <n-text>{{ log.message }}</n-text>
                </div>
              </div>
              <n-empty v-else description="暂无日志数据" />
            </n-scrollbar>
          </div>
        </n-space>
      </n-card>
    </n-space>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useMessage, NSpace, NCard, NButton, NSelect, NDescriptions, NDescriptionsItem, NInput, NIcon, NScrollbar, NEmpty, NText, NTag } from 'naive-ui';
import { SearchOutline } from '@vicons/ionicons5';
import { configApi, type LogEntry } from '@/api/config';
import { formatTimestamp } from '@/utils/common';

const message = useMessage();
const loading = ref(false);
const logsData = ref<any>(null);
const searchText = ref('');
const selectedLevel = ref<'INFO' | 'WARN' | 'ERROR' | 'DEBUG' | undefined>(undefined);
const logLimit = ref(100);
let autoRefreshTimer: number | null = null;

const levelOptions = [
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

const displayLogs = computed(() => {
  if (!logsData.value?.logs) return [];

  let logs = logsData.value.logs as LogEntry[];

  if (searchText.value) {
    const searchLower = searchText.value.toLowerCase();
    logs = logs.filter(log =>
      log.message.toLowerCase().includes(searchLower) ||
      log.module?.toLowerCase().includes(searchLower)
    );
  }

  return logs;
});

function getLevelType(level: string) {
  switch (level) {
    case 'ERROR':
      return 'error';
    case 'WARN':
      return 'warning';
    case 'INFO':
      return 'info';
    case 'DEBUG':
      return 'default';
    default:
      return 'default';
  }
}

async function loadLogs() {
  try {
    loading.value = true;
    logsData.value = await configApi.getLogs({
      level: selectedLevel.value,
      limit: logLimit.value,
    });
  } catch (error: any) {
    message.error(error.message);
  } finally {
    loading.value = false;
  }
}

function handleSearch() {
  // 触发计算属性重新计算
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
.log-container {
  background-color: #fafafa;
  border: 1px solid #e8e8e8;
  border-radius: 4px;
  padding: 12px;
}

.log-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.log-entry {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 8px;
  background-color: #ffffff;
  border: 1px solid #f0f0f0;
  border-radius: 4px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 13px;
}
</style>

