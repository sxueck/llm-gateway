<template>
  <div>
    <n-space vertical :size="24">
      <n-card :title="t('settings.developerDebugTitle')">
        <n-space vertical :size="16">
          <n-space align="center" justify="space-between">
            <div>
              <div>{{ t('settings.developerDebug') }}</div>
              <n-text depth="3" style="font-size: 12px;">
                {{ t('settings.developerDebugDesc') }}
              </n-text>
              <n-text depth="3" style="font-size: 12px; display: block; margin-top: 4px;">
                {{ t('settings.developerDebugHint') }}
              </n-text>
            </div>
            <n-switch :value="developerDebugEnabled" @update:value="onToggleDeveloperDebug" />
          </n-space>

          <n-alert :type="developerDebugEnabled ? 'success' : 'default'">
            <template #header>
              <span v-if="developerDebugEnabled">{{ t('settings.developerDebugStatusActive') }}</span>
              <span v-else>{{ t('settings.developerDebugStatusInactive') }}</span>
            </template>
            <n-text v-if="developerDebugEnabled && countdownText" style="font-size: 13px;">
              {{ countdownText }}
            </n-text>
            <n-text v-else style="font-size: 13px;">
              {{ t('settings.developerDebugInactiveTip') }}
            </n-text>
          </n-alert>
        </n-space>
      </n-card>

      <n-card :title="t('settings.developerDebugViewerTitle')">
        <template #header-extra>
          <n-space align="center" :size="8">
            <n-badge :type="connectionBadgeType" dot>
              <span class="connection-status-text">{{ connectionStatusText }}</span>
            </n-badge>
            <n-button size="small" @click="reconnect" :disabled="!canConnect">
              {{ t('settings.developerDebugReconnect') }}
            </n-button>
            <n-button size="small" @click="disconnect" :disabled="!isConnected">
              {{ t('settings.developerDebugDisconnect') }}
            </n-button>
            <n-button size="small" @click="clearEvents" :disabled="events.length === 0">
              {{ t('common.clear') }}
            </n-button>
          </n-space>
        </template>

        <n-alert type="info" v-if="!developerDebugEnabled" style="margin-bottom: 12px;">
          {{ t('settings.developerDebugViewerHint') }}
        </n-alert>

        <div class="events-container">
          <n-scrollbar style="max-height: 540px;">
            <div v-if="events.length === 0" class="empty-state">
              <n-empty :description="t('settings.developerDebugEmpty')" :show-icon="false" />
            </div>
            <div v-else>
              <div
                v-for="event in events"
                :key="event.id + '-' + event.timestamp"
                class="event-card"
              >
                <div
                  class="event-header"
                  role="button"
                  tabindex="0"
                  @click="toggleEventDetails(event)"
                  @keydown.enter.prevent="toggleEventDetails(event)"
                  @keydown.space.prevent="toggleEventDetails(event)"
                >
                  <div class="event-main-line">
                    <span class="event-timestamp">{{ formatTimestamp(event.timestamp) }}</span>
                    <n-tag size="small" type="info" class="event-method">
                      {{ event.method }}
                    </n-tag>
                    <span class="event-path">{{ event.path }}</span>
                    <n-tag
                      size="small"
                      :type="event.success ? 'success' : 'error'"
                      class="event-status"
                    >
                      {{ event.statusCode || '-' }}
                    </n-tag>
                    <span class="event-duration">{{ event.durationMs }} ms</span>
                    <span v-if="event.stream" class="event-flag">stream</span>
                    <span v-if="event.fromCache" class="event-flag">cache</span>
                  </div>
                  <div class="event-meta-line">
                    <span v-if="event.virtualKeyName" class="event-meta">
                      VK: {{ event.virtualKeyName }}
                    </span>
                    <span v-else-if="event.virtualKeyId" class="event-meta">
                      VK: {{ event.virtualKeyId }}
                    </span>
                    <span v-if="event.model" class="event-meta">
                      Model: {{ event.model }}
                    </span>
                    <span v-if="event.providerId" class="event-meta">
                      Provider: {{ event.providerId }}
                    </span>
                  </div>
                  <div class="event-toggle">
                    <span class="event-toggle-icon">
                      {{ isEventExpanded(event) ? '▼' : '▶' }}
                    </span>
                    <span class="event-toggle-text">
                      {{ isEventExpanded(event) ? t('common.collapse') : t('common.expand') }}
                    </span>
                  </div>
                </div>

                <transition name="event-expand">
                  <div v-if="isEventExpanded(event)" class="event-body">
                    <div class="event-actions">
                      <n-button size="tiny" tertiary @click.stop="downloadEvent(event)">
                        {{ t('settings.developerDebugDownload') }}
                      </n-button>
                    </div>
                    <div class="event-column">
                      <div class="event-column-title">{{ t('apiGuide.requestBody') }}</div>
                      <n-code
                        :code="formatJson(event.requestBody)"
                        language="json"
                        word-wrap
                        class="event-code-block"
                      />
                    </div>
                    <div class="event-column">
                      <div class="event-column-title">{{ t('common.responseBody') }}</div>
                      <n-code
                        :code="event.responseBody !== undefined ? formatJson(event.responseBody) : ''"
                        language="json"
                        word-wrap
                        class="event-code-block"
                      />
                    </div>
                  </div>
                </transition>

                <transition name="event-expand">
                  <n-alert
                    v-if="isEventExpanded(event) && event.error"
                    type="error"
                    size="small"
                    style="margin-top: 8px;"
                  >
                    {{ event.error }}
                  </n-alert>
                </transition>
              </div>
            </div>
          </n-scrollbar>
        </div>
      </n-card>
    </n-space>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  NSpace,
  NCard,
  NSwitch,
  NAlert,
  NText,
  NButton,
  NTag,
  NCode,
  NBadge,
  NScrollbar,
  NEmpty,
  useMessage,
} from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { configApi } from '@/api/config';
import { formatJson, formatTimestamp } from '@/utils/common';

const { t } = useI18n();
const message = useMessage();

interface DebugApiEvent {
  type: 'api_request';
  id: string;
  timestamp: number;
  protocol: string;
  method: string;
  path: string;
  stream: boolean;
  success: boolean;
  statusCode?: number;
  fromCache?: boolean;
  virtualKeyId?: string;
  virtualKeyName?: string;
  providerId?: string;
  model?: string;
  durationMs: number;
  requestBody: any;
  responseBody?: any;
  error?: string;
}

interface DebugStateMessage {
  type: 'debug_state';
  active: boolean;
  expiresAt: number | null;
}

type DebugMessage = DebugApiEvent | DebugStateMessage;

const developerDebugEnabled = ref(false);
const developerDebugExpiresAt = ref<number | null>(null);
const remainingSeconds = ref<number | null>(null);

const events = ref<DebugApiEvent[]>([]);
const expandedEvents = ref<Record<string, boolean>>({});
const eventSource = ref<EventSource | null>(null);
const connectionStatus = ref<'disconnected' | 'connecting' | 'connected' | 'error'>(
  'disconnected'
);
let countdownTimer: number | null = null;

const isConnected = computed(() => connectionStatus.value === 'connected');
const canConnect = computed(() => true);

const connectionBadgeType = computed(() => {
  switch (connectionStatus.value) {
    case 'connected':
      return 'success';
    case 'connecting':
      return 'warning';
    case 'error':
      return 'error';
    default:
      return 'default';
  }
});

const connectionStatusText = computed(() => {
  switch (connectionStatus.value) {
    case 'connected':
      return t('settings.developerDebugWsConnected');
    case 'connecting':
      return t('settings.developerDebugWsConnecting');
    case 'error':
      return t('settings.developerDebugWsError');
    default:
      return t('settings.developerDebugWsDisconnected');
  }
});

const countdownText = computed(() => {
  if (!developerDebugEnabled.value || remainingSeconds.value == null) return '';
  const total = remainingSeconds.value;
  if (total <= 0) return '';
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return t('settings.developerDebugRemaining', {
    minutes,
    seconds: String(seconds).padStart(2, '0'),
  });
});

function updateRemainingSeconds() {
  if (!developerDebugEnabled.value || !developerDebugExpiresAt.value) {
    remainingSeconds.value = null;
    return;
  }
  const diff = Math.floor((developerDebugExpiresAt.value - Date.now()) / 1000);
  remainingSeconds.value = diff > 0 ? diff : 0;
  if (diff <= 0) {
    developerDebugEnabled.value = false;
    developerDebugExpiresAt.value = null;
  }
}

async function loadSystemSettings() {
  try {
    const settings = await configApi.getSystemSettings();
    developerDebugEnabled.value = settings.developerDebugEnabled;
    developerDebugExpiresAt.value = settings.developerDebugExpiresAt;
    updateRemainingSeconds();
  } catch (error: any) {
    message.error(error.message || t('messages.loadFailed'));
  }
}

async function onToggleDeveloperDebug(val: boolean) {
  try {
    await configApi.updateSystemSettings({ developerDebugEnabled: val });
    await loadSystemSettings();
    if (val) {
      message.success(t('messages.operationSuccess'));
      connect();
    } else {
      message.success(t('messages.operationSuccess'));
      clearEvents();
    }
  } catch (error: any) {
    message.error(error.message || t('messages.operationFailed'));
  }
}

function handleDebugState(state: DebugStateMessage) {
  developerDebugEnabled.value = !!state.active;
  developerDebugExpiresAt.value = state.expiresAt;
  updateRemainingSeconds();
}

function handleDebugEvent(event: DebugApiEvent) {
  events.value.unshift(event);
  if (events.value.length > 200) {
    const removed = events.value.splice(200);
    if (removed.length) {
      const map = { ...expandedEvents.value };
      for (const removedEvent of removed) {
        delete map[getEventKey(removedEvent)];
      }
      expandedEvents.value = map;
    }
  }
}

function clearEvents() {
  events.value = [];
  expandedEvents.value = {};
}

function setupCountdownTimer() {
  if (countdownTimer !== null) return;
  countdownTimer = window.setInterval(() => {
    updateRemainingSeconds();
  }, 1000);
}

function clearCountdownTimer() {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function connect() {
  if (eventSource.value) {
    eventSource.value.close();
    eventSource.value = null;
  }

  connectionStatus.value = 'connecting';

  const stream = new EventSource('/api/admin/config/debug-stream');
  eventSource.value = stream;

  stream.onopen = () => {
    connectionStatus.value = 'connected';
  };

  stream.onerror = () => {
    connectionStatus.value = 'error';
  };

  stream.onmessage = (event) => {
    try {
      const data: DebugMessage = JSON.parse(event.data);
      if (data.type === 'debug_state') {
        handleDebugState(data);
      } else if (data.type === 'api_request') {
        handleDebugEvent(data as DebugApiEvent);
      }
    } catch (err) {
      console.error('Failed to parse debug message', err);
    }
  };
}

function disconnect() {
  if (eventSource.value) {
    eventSource.value.close();
    eventSource.value = null;
  }
  connectionStatus.value = 'disconnected';
}

function reconnect() {
  connect();
}

function getEventKey(event: DebugApiEvent) {
  return `${event.id}-${event.timestamp}`;
}

function isEventExpanded(event: DebugApiEvent) {
  return !!expandedEvents.value[getEventKey(event)];
}

function toggleEventDetails(event: DebugApiEvent) {
  const key = getEventKey(event);
  expandedEvents.value = {
    ...expandedEvents.value,
    [key]: !expandedEvents.value[key],
  };
}

function downloadEvent(event: DebugApiEvent) {
  try {
    const payload = {
      id: event.id,
      timestamp: event.timestamp,
      protocol: event.protocol,
      method: event.method,
      path: event.path,
      stream: event.stream,
      success: event.success,
      statusCode: event.statusCode,
      fromCache: event.fromCache,
      virtualKeyId: event.virtualKeyId,
      virtualKeyName: event.virtualKeyName,
      providerId: event.providerId,
      model: event.model,
      durationMs: event.durationMs,
      requestBody: event.requestBody,
      responseBody: event.responseBody,
      error: event.error,
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const timestamp = new Date(event.timestamp).toISOString().replace(/[:.]/g, '-');
    const method = event.method.toLowerCase();
    const cleanPath = event.path
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+/, '')
      .replace(/-+$/, '') || 'request';
    const link = document.createElement('a');
    link.href = url;
    link.download = `debug-${method}-${cleanPath}-${timestamp}.json`;
    link.click();
    URL.revokeObjectURL(url);
    message.success(t('settings.developerDebugDownloadSuccess'));
  } catch (error) {
    console.error('Failed to export developer debug request', error);
    message.error(t('settings.developerDebugDownloadFailed'));
  }
}

onMounted(async () => {
  await loadSystemSettings();
  setupCountdownTimer();
  if (developerDebugEnabled.value) {
    connect();
  }
});

onUnmounted(() => {
  disconnect();
  clearCountdownTimer();
});
</script>

<style scoped>
.events-container {
  border-radius: 8px;
  border: 1px solid #e5e5e5;
  background: #ffffff;
}

.empty-state {
  padding: 32px 16px;
}

.event-card {
  padding: 12px 16px;
  border-bottom: 1px solid #f0f0f0;
}

.event-card:last-child {
  border-bottom: none;
}

.event-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
  cursor: pointer;
}

.event-header:focus-visible {
  outline: 2px solid #1677ff;
  outline-offset: 2px;
}

.event-main-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.event-meta-line {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  color: #8c8c8c;
}

.event-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #8c8c8c;
}

.event-toggle-icon {
  font-weight: bold;
}

.event-timestamp {
  font-size: 12px;
  color: #8c8c8c;
}

.event-method {
  font-size: 12px;
}

.event-path {
  font-size: 13px;
  font-weight: 500;
  color: #333333;
}

.event-status {
  font-size: 12px;
}

.event-duration {
  font-size: 12px;
  color: #595959;
}

.event-flag {
  font-size: 11px;
  color: #8c8c8c;
  padding: 0 4px;
  border-radius: 4px;
  border: 1px solid #e5e5e5;
}

.event-expand-enter-active,
.event-expand-leave-active {
  transition: all 0.2s ease;
}

.event-expand-enter-from,
.event-expand-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.event-body {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.event-actions {
  grid-column: 1 / -1;
  display: flex;
  justify-content: flex-end;
}

@media (max-width: 768px) {
  .event-body {
    grid-template-columns: 1fr;
  }
}

.event-column-title {
  font-size: 12px;
  font-weight: 500;
  color: #8c8c8c;
  margin-bottom: 4px;
}

.event-code-block {
  font-size: 12px;
  max-height: 220px;
}

.connection-status-text {
  font-size: 12px;
}
</style>
