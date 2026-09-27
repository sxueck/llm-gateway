<template>
  <n-popover
    trigger="click"
    placement="bottom-end"
    :width="380"
    raw
    :show="visible"
    @update:show="visible = $event"
  >
    <template #trigger>
      <n-badge
        :value="alerts.length"
        :max="99"
        :show="alerts.length > 0"
        :type="hasError ? 'error' : 'warning'"
        :offset="[-2, 4]"
      >
        <n-button circle quaternary class="alert-btn" :aria-label="t('alerts.title')">
          <template #icon>
            <n-icon size="20"><MailOutline /></n-icon>
          </template>
        </n-button>
      </n-badge>
    </template>

    <div class="alert-panel">
      <div class="alert-panel__head">
        <span class="alert-panel__title">{{ t('alerts.title') }}</span>
        <span class="alert-panel__actions">
          <n-button
            text
            size="tiny"
            :disabled="alerts.length === 0"
            :loading="marking"
            @click="markAllRead"
          >
            {{ t('alerts.markAllRead') }}
          </n-button>
          <n-button text size="tiny" :loading="loading" @click="load">
            {{ t('alerts.refresh') }}
          </n-button>
        </span>
      </div>

      <div v-if="loadError" class="alert-panel__state">{{ t('alerts.loadFailed') }}</div>
      <div v-else-if="loading && alerts.length === 0" class="alert-panel__state">
        {{ t('alerts.loading') }}
      </div>
      <div v-else-if="alerts.length === 0" class="alert-panel__state">
        {{ t('alerts.empty') }}
      </div>

      <div v-else class="alert-panel__list">
        <div v-for="alert in alerts" :key="alert.code" class="alert-item" :data-level="alert.level">
          <span class="alert-item__dot" />
          <div class="alert-item__body">
            <div class="alert-item__text">{{ alertText(alert) }}</div>
            <div class="alert-item__meta">
              {{ t(`alerts.level.${alert.level}`) }} · {{ t(`alerts.category.${alert.category}`) }}
            </div>
          </div>
        </div>
      </div>

      <div class="alert-panel__foot">
        {{ t('alerts.checkedAt', { time: checkedAtText }) }}
      </div>
    </div>
  </n-popover>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { NBadge, NButton, NIcon, NPopover, useMessage } from 'naive-ui';
import { MailOutline } from '@vicons/ionicons5';
import { useI18n } from 'vue-i18n';
import { alertsApi, type SystemAlert } from '@/api/alerts';

const { t, te } = useI18n();
const message = useMessage();

/** 与后端采集周期解耦：铃铛只是快照，60s 足够察觉环境漂移又不会盯着 Docker 打转。 */
const POLL_INTERVAL_MS = 60_000;

const alerts = ref<SystemAlert[]>([]);
const visible = ref(false);
const loading = ref(false);
const marking = ref(false);
const loadError = ref(false);
const checkedAt = ref<number>(0);

const hasError = computed(() => alerts.value.some(alert => alert.level === 'error'));
const checkedAtText = computed(() =>
  checkedAt.value ? new Date(checkedAt.value).toLocaleTimeString() : '--:--:--',
);

async function load() {
  loading.value = true;
  try {
    const result = await alertsApi.getList();
    alerts.value = result.alerts;
    checkedAt.value = result.generatedAt;
    loadError.value = false;
  } catch (error) {
    // 采集失败保持上一次结果：空面板比“没有新告警”更容易被误读成一切正常
    loadError.value = true;
    console.warn('加载系统告警失败', error);
  } finally {
    loading.value = false;
  }
}

/** 已读后告警从铃铛消失；同一告警条件若再次出现（重新采集出同 code）仍会提醒。 */
async function markAllRead() {
  marking.value = true;
  try {
    await alertsApi.markAllRead();
    await load();
  } catch (error) {
    console.warn('标记告警已读失败', error);
    message.error(t('alerts.markReadFailed'));
  } finally {
    marking.value = false;
  }
}

/**
 * 文案优先走前端 i18n（后端只给 code + 参数）；未登记的 code 回落中文摘要，
 * 这样新增告警项不会因为漏翻译而显示空白。
 * 写成字面模板是为了让 scripts/check-i18n-keys.cjs 能推导出 alerts.codes.* 这组动态键。
 */
function alertText(alert: SystemAlert): string {
  if (!te(`alerts.codes.${alert.code}`)) return alert.message;
  return t(`alerts.codes.${alert.code}`, alert.params ?? {});
}

let timer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  load();
  timer = setInterval(load, POLL_INTERVAL_MS);
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<style scoped>
.alert-btn {
  width: 40px;
  height: 40px;
  color: #595959;
}

.alert-btn:hover {
  background-color: rgba(0, 0, 0, 0.04);
}

.alert-panel {
  width: 380px;
  max-width: calc(100vw - 32px);
  display: flex;
  flex-direction: column;
  background: #ffffff;
  border: 1px solid #e6e6e6;
  border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);
  overflow: hidden;
}

.alert-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid #f0f0f0;
}

.alert-panel__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--color-title);
}

.alert-panel__actions {
  display: inline-flex;
  align-items: center;
  gap: 10px;
}

.alert-panel__state {
  padding: 24px 14px;
  text-align: center;
  font-size: 13px;
  color: #8c8c8c;
}

.alert-panel__list {
  max-height: min(50vh, 360px);
  overflow-y: auto;
}

.alert-item {
  display: flex;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid #f7f7f7;
}

.alert-item:last-child {
  border-bottom: none;
}

.alert-item__dot {
  flex: none;
  width: 8px;
  height: 8px;
  margin-top: 6px;
  border-radius: 50%;
  background: #d9d9d9;
}

.alert-item[data-level='error'] .alert-item__dot {
  background: #d62f2f;
}

.alert-item[data-level='warning'] .alert-item__dot {
  background: #b89d6a;
}

.alert-item[data-level='info'] .alert-item__dot {
  background: #0f6b4a;
}

.alert-item__body {
  min-width: 0;
}

.alert-item__text {
  font-size: 13px;
  line-height: 1.6;
  color: #262626;
  word-break: break-word;
}

.alert-item__meta {
  margin-top: 2px;
  font-size: 11px;
  color: #a3a3a3;
}

.alert-panel__foot {
  padding: 8px 14px;
  border-top: 1px solid #f0f0f0;
  font-size: 11px;
  color: #a3a3a3;
}
</style>
