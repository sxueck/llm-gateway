<template>
  <div>
    <n-space vertical :size="24">
      <PageHeader eyebrow="TOOLS" :title="t('logs.title')" :subtitle="t('logs.subtitle')" />
      <n-card>
        <template #header-extra>
          <n-space>
            <n-select
              v-model:value="selectedLevel"
              :options="levelOptions"
              style="width: 120px;"
              :placeholder="t('logs.level')"
            />
            <n-select
              v-model:value="logLimit"
              :options="limitOptions"
              style="width: 150px;"
              @update:value="loadLogs"
            />
            <n-button @click="toggleAutoRefresh">
              <template #icon>
                <n-icon>
                  <PlayOutline v-if="isAutoRefreshPaused" />
                  <PauseOutline v-else />
                </n-icon>
              </template>
              {{ isAutoRefreshPaused ? t('logs.resumeRefresh') : t('logs.pauseRefresh') }}
            </n-button>
            <n-button @click="loadLogs" :loading="loading">
              {{ t('common.refresh') }}
            </n-button>
          </n-space>
        </template>

        <n-space vertical :size="12">
          <n-input
            v-model:value="searchText"
            :placeholder="t('logs.searchPlaceholder')"
            clearable
          >
            <template #prefix>
              <n-icon><SearchOutline /></n-icon>
            </template>
          </n-input>

          <div class="terminal-container">
            <pre v-if="filteredLogText" class="terminal-output">{{ filteredLogText }}</pre>
            <n-empty v-else :description="t('logs.empty')" :show-icon="false" />
          </div>
        </n-space>
      </n-card>
    </n-space>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useMessage, NSpace, NCard, NButton, NSelect, NInput, NIcon, NEmpty } from 'naive-ui';
import { SearchOutline, PlayOutline, PauseOutline } from '@vicons/ionicons5';
import { configApi, type LogEntry } from '@/api/config';
import { formatTimestamp } from '@/utils/common';
import PageHeader from '@/components/PageHeader.vue';

const message = useMessage();
const { t } = useI18n();
const loading = ref(false);
const allLogsText = ref('');
const searchText = ref('');
const selectedLevel = ref<string>('ALL');
const logLimit = ref(100);
const isAutoRefreshPaused = ref(false);
let autoRefreshTimer: number | null = null;

const levelOptions = [
  { label: 'ALL', value: 'ALL' },
  { label: 'INFO', value: 'INFO' },
  { label: 'WARN', value: 'WARN' },
  { label: 'ERROR', value: 'ERROR' },
  { label: 'DEBUG', value: 'DEBUG' },
];

const limitOptions = computed(() =>
  [50, 100, 200, 500, 1000].map(count => ({
    label: t('logs.recent', { count }),
    value: count,
  })),
);

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
    }
  } catch (error: any) {
    message.error(error.message);
  } finally {
    loading.value = false;
  }
}

function startAutoRefresh() {
  if (!isAutoRefreshPaused.value && autoRefreshTimer === null) {
    autoRefreshTimer = window.setInterval(() => {
      loadLogs();
    }, 10000);
  }
}

function stopAutoRefresh() {
  if (autoRefreshTimer !== null) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

function toggleAutoRefresh() {
  isAutoRefreshPaused.value = !isAutoRefreshPaused.value;
  
  if (isAutoRefreshPaused.value) {
    stopAutoRefresh();
    message.info(t('logs.paused'));
  } else {
    startAutoRefresh();
    message.success(t('logs.resumed'));
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

:deep(.n-card-header__main) {
  color: var(--color-title);
}
</style>

