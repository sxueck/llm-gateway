<template>
  <div class="playground-page">
    <PageHeader
      class="playground-page-header"
      eyebrow="PLAYGROUND"
      :title="t('playground.title')"
      :subtitle="t('playground.subtitle')"
    >
      <template #actions>
        <div class="page-actions">
          <n-button size="small" secondary :disabled="streaming" @click="clearConversation">
            <template #icon>
              <n-icon><TrashOutline /></n-icon>
            </template>
            {{ t('playground.actions.clearConversation') }}
          </n-button>
          <n-button
            size="small"
            secondary
            :loading="modelsLoading"
            :disabled="!virtualKeyId"
            @click="refreshModels"
          >
            <template #icon>
              <n-icon><RefreshOutline /></n-icon>
            </template>
            {{ t('playground.actions.refreshModels') }}
          </n-button>
        </div>
      </template>
    </PageHeader>

    <n-grid cols="1 l:3" responsive="screen" :x-gap="16" :y-gap="16" class="playground-grid">
      <!-- 配置列 -->
      <n-gi>
        <n-card size="small" :title="t('playground.config.title')" class="full-height-card">
          <n-space vertical :size="14">
            <div class="config-field">
              <div class="config-label">{{ t('playground.config.virtualKey') }}</div>
              <n-select
                v-model:value="virtualKeyId"
                :options="virtualKeyOptions"
                :placeholder="t('playground.config.virtualKeyPlaceholder')"
                :render-label="renderVirtualKeyLabel"
                filterable
                @update:value="onVirtualKeyChange"
              />
            </div>

            <div class="config-field">
              <div class="config-label">{{ t('playground.config.model') }}</div>
              <n-select
                v-model:value="model"
                :options="modelOptions"
                :placeholder="t('playground.config.modelPlaceholder')"
                :loading="modelsLoading"
                filterable
              />
              <n-alert v-if="modelsError" type="warning" :show-icon="true" class="models-error">
                {{ t('playground.models.loadFailed') }}：{{ modelsError }}
              </n-alert>
            </div>

            <div class="config-field">
              <div class="config-label">{{ t('playground.config.protocol') }}</div>
              <n-radio-group v-model:value="protocol" class="protocol-group">
                <n-radio-button value="openai">
                  {{ t('playground.config.protocolOpenai') }}
                </n-radio-button>
                <n-radio-button value="anthropic">
                  {{ t('playground.config.protocolAnthropic') }}
                </n-radio-button>
              </n-radio-group>
            </div>

            <div class="config-field">
              <div class="config-label">
                {{ t('playground.config.temperature') }}
                <span class="config-value">{{ temperature.toFixed(2) }}</span>
              </div>
              <n-slider v-model:value="temperature" :min="0" :max="2" :step="0.05" :tooltip="false" />
            </div>

            <div class="config-field">
              <div class="config-label">
                {{ t('playground.config.topP') }}
                <span class="config-value">{{ topP.toFixed(2) }}</span>
              </div>
              <n-slider v-model:value="topP" :min="0" :max="1" :step="0.05" :tooltip="false" />
            </div>

            <div class="config-field">
              <div class="config-label">{{ t('playground.config.maxTokens') }}</div>
              <n-input-number
                v-model:value="maxTokens"
                :min="1"
                :step="128"
                clearable
                :placeholder="t('playground.config.maxTokensPlaceholder')"
                class="max-tokens-input"
              />
            </div>

            <div class="config-field">
              <div class="config-label">{{ t('playground.config.systemPrompt') }}</div>
              <n-input
                v-model:value="systemPrompt"
                type="textarea"
                :rows="3"
                :placeholder="t('playground.config.systemPromptPlaceholder')"
              />
            </div>

            <div class="config-field config-field-inline">
              <div class="config-label">{{ t('playground.config.stream') }}</div>
              <n-switch v-model:value="streamEnabled" size="small" />
            </div>
          </n-space>
        </n-card>
      </n-gi>

      <!-- 对话列 -->
      <n-gi>
        <n-card size="small" :title="t('playground.chat.title')" class="full-height-card chat-card">
          <div ref="messageListEl" class="message-list">
            <n-empty v-if="messages.length === 0" :description="t('playground.chat.empty')" class="chat-empty" />
            <div
              v-for="m in messages"
              :key="m.id"
              class="message"
              :class="`message-${m.role}`"
            >
              <div class="message-header">
                <n-tag size="small" :bordered="false" :type="roleTagType(m.role)">
                  {{ t(`playground.chat.role.${m.role}`) }}
                </n-tag>
                <n-tag v-if="m.streaming" size="small" :bordered="false" type="info">
                  {{ t('playground.chat.generating') }}
                </n-tag>
                <div class="message-actions">
                  <n-button
                    size="tiny"
                    quaternary
                    type="primary"
                    :disabled="streaming || !m.content"
                    @click="resendAsInput(m)"
                  >
                    <template #icon>
                      <n-icon><PaperPlaneOutline /></n-icon>
                    </template>
                    {{ t('playground.chat.resend') }}
                  </n-button>
                  <n-button
                    size="tiny"
                    quaternary
                    type="error"
                    :disabled="streaming"
                    @click="removeMessage(m.id)"
                  >
                    <template #icon>
                      <n-icon><TrashOutline /></n-icon>
                    </template>
                    {{ t('common.delete') }}
                  </n-button>
                </div>
              </div>
              <!-- 流式中的消息只读展示 + 光标，结束后才转为可编辑 textarea -->
              <pre v-if="m.streaming" class="message-stream-text">{{ m.content }}<span class="stream-cursor" /></pre>
              <n-input
                v-else
                v-model:value="m.content"
                type="textarea"
                :autosize="{ minRows: 1, maxRows: 10 }"
              />
            </div>
          </div>

          <div class="chat-input-area">
            <n-input
              v-model:value="inputText"
              type="textarea"
              :rows="2"
              :placeholder="t('playground.chat.inputPlaceholder')"
              @keydown="handleInputKeydown"
            />
            <div class="chat-input-actions">
              <n-button
                type="primary"
                size="small"
                :disabled="streaming || !virtualKeyId || !model"
                @click="sendMessage"
              >
                <template #icon>
                  <n-icon><PaperPlaneOutline /></n-icon>
                </template>
                {{ t('playground.chat.send') }}
              </n-button>
              <n-button v-if="streaming" type="warning" size="small" @click="stopStreaming">
                <template #icon>
                  <n-icon><StopOutline /></n-icon>
                </template>
                {{ t('playground.chat.stop') }}
              </n-button>
            </div>
          </div>
        </n-card>
      </n-gi>

      <!-- 指标列 -->
      <n-gi>
        <n-card size="small" :title="t('playground.metrics.title')" class="full-height-card metrics-card">
          <div v-if="!lastMetrics.hasData" class="metrics-empty">
            {{ t('playground.metrics.empty') }}
          </div>
          <div v-else class="metrics-list">
            <div class="metrics-row">
              <span class="metrics-label">{{ t('playground.metrics.status') }}</span>
              <n-tag
                size="small"
                :bordered="false"
                :type="lastMetrics.ok === null ? 'default' : lastMetrics.ok ? 'success' : 'error'"
              >
                {{ statusTagText }}
              </n-tag>
            </div>
            <div class="metrics-row">
              <span class="metrics-label">{{ t('playground.metrics.ttft') }}</span>
              <span class="metrics-value">{{ ttftText }}</span>
            </div>
            <div class="metrics-row">
              <span class="metrics-label">{{ t('playground.metrics.duration') }}</span>
              <span class="metrics-value">{{ formatMs(lastMetrics.durationMs) }}</span>
            </div>
            <div class="metrics-row">
              <span class="metrics-label">{{ t('playground.metrics.promptTokens') }}</span>
              <span class="metrics-value">{{ formatToken(lastMetrics.usage?.promptTokens) }}</span>
            </div>
            <div class="metrics-row">
              <span class="metrics-label">{{ t('playground.metrics.completionTokens') }}</span>
              <span class="metrics-value">{{ formatToken(lastMetrics.usage?.completionTokens) }}</span>
            </div>
            <div class="metrics-row">
              <span class="metrics-label">{{ t('playground.metrics.cachedTokens') }}</span>
              <span class="metrics-value">{{ formatToken(lastMetrics.usage?.cachedTokens) }}</span>
            </div>
            <div class="metrics-row">
              <span class="metrics-label">{{ t('playground.metrics.totalTokens') }}</span>
              <span class="metrics-value">{{ formatToken(lastMetrics.usage?.totalTokens) }}</span>
            </div>
            <div class="metrics-row">
              <span class="metrics-label">{{ t('playground.metrics.cost') }}</span>
              <span class="metrics-value">{{ formatCost(lastMetrics.cost) }}</span>
            </div>
            <div class="metrics-row">
              <span class="metrics-label">{{ t('playground.metrics.model') }}</span>
              <span class="metrics-value metrics-mono">{{ lastMetrics.model || model || '—' }}</span>
            </div>
            <div class="metrics-row metrics-row-request">
              <span class="metrics-label">{{ t('playground.metrics.requestId') }}</span>
              <div class="metrics-request">
                <span class="metrics-value metrics-mono">{{ lastMetrics.requestId || '—' }}</span>
                <n-button
                  v-if="lastMetrics.requestId"
                  size="tiny"
                  text
                  type="primary"
                  @click="gotoRequest"
                >
                  {{ t('playground.metrics.viewRequest') }}
                </n-button>
              </div>
            </div>
            <div v-if="lastMetrics.error" class="metrics-error">
              {{ t('playground.metrics.error') }}：{{ lastMetrics.error }}
            </div>
          </div>
        </n-card>
      </n-gi>
    </n-grid>

    <!-- 响应明细区 -->
    <n-card size="small" :title="t('playground.details.title')" class="details-card">
      <n-tabs type="line" size="small">
        <n-tab-pane name="raw" :tab="t('playground.details.raw')">
          <n-scrollbar v-if="rawResponseText" class="code-scrollbar">
            <n-code :code="rawResponseText" :language="rawIsJson ? 'json' : undefined" word-wrap />
          </n-scrollbar>
          <n-empty v-else :description="t('playground.details.empty')" class="chat-empty" />
        </n-tab-pane>
        <n-tab-pane name="payload" :tab="t('playground.details.payload')">
          <n-scrollbar class="code-scrollbar">
            <n-code :code="payloadPreview" language="json" word-wrap />
          </n-scrollbar>
        </n-tab-pane>
        <n-tab-pane name="curl" :tab="t('playground.details.curl')">
          <div class="curl-toolbar">
            <n-button size="small" secondary @click="copyCurl">
              <template #icon>
                <n-icon><CopyOutline /></n-icon>
              </template>
              {{ t('playground.details.copyCurl') }}
            </n-button>
          </div>
          <n-scrollbar class="code-scrollbar">
            <n-code :code="curlSnippet" language="bash" word-wrap />
          </n-scrollbar>
        </n-tab-pane>
      </n-tabs>
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { computed, h, nextTick, onMounted, ref, watch } from 'vue';
import type { VNode } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { useMessage } from 'naive-ui';
import type { SelectOption } from 'naive-ui';
import {
  NAlert,
  NButton,
  NCard,
  NCode,
  NEmpty,
  NGi,
  NGrid,
  NIcon,
  NInput,
  NInputNumber,
  NRadioButton,
  NRadioGroup,
  NScrollbar,
  NSelect,
  NSlider,
  NSpace,
  NSwitch,
  NTabPane,
  NTabs,
  NTag,
} from 'naive-ui';
import {
  CopyOutline,
  PaperPlaneOutline,
  RefreshOutline,
  StopOutline,
  TrashOutline,
} from '@vicons/ionicons5';
import PageHeader from '@/components/PageHeader.vue';
import { configApi } from '@/api/config';
import {
  playgroundApi,
  streamPlayground,
  type PlaygroundAnthropicRequest,
  type PlaygroundChatRequest,
  type PlaygroundProtocol,
  type PlaygroundResult,
  type PlaygroundStreamFrame,
  type PlaygroundUsage,
} from '@/api/playground';
import { useVirtualKeyStore } from '@/stores/virtual-key';

const { t } = useI18n();
const message = useMessage();
const router = useRouter();
const virtualKeyStore = useVirtualKeyStore();

/** localStorage 持久化前缀，恢复/保存所有调试配置。 */
const STORAGE_PREFIX = 'playground.';
/** 流式原始帧日志的字符上限，超出后截断，避免超长流拖垮渲染。 */
const RAW_LOG_CHAR_LIMIT = 200_000;

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  streaming?: boolean;
}

interface MetricsState {
  hasData: boolean;
  ok: boolean | null;
  status: number | null;
  ttftMs: number | null;
  localTtftMs: number | null;
  durationMs: number | null;
  usage: PlaygroundUsage | null;
  cost: number | null;
  model: string | null;
  requestId: string | null;
  error: string | null;
}

const EMPTY_METRICS: MetricsState = {
  hasData: false,
  ok: null,
  status: null,
  ttftMs: null,
  localTtftMs: null,
  durationMs: null,
  usage: null,
  cost: null,
  model: null,
  requestId: null,
  error: null,
};

// ---- 配置状态 ----
const protocol = ref<PlaygroundProtocol>('openai');
const virtualKeyId = ref<string | null>(null);
const model = ref<string | null>(null);
const temperature = ref(0.7);
const topP = ref(1);
const maxTokens = ref<number | null>(null);
const systemPrompt = ref('');
const streamEnabled = ref(true);

// ---- 模型列表 ----
const modelsLoading = ref(false);
const modelsError = ref<string | null>(null);
const modelOptions = ref<Array<{ label: string; value: string }>>([]);

// ---- 对话状态 ----
let messageIdSeq = 0;
const messages = ref<ChatMessage[]>([]);
const inputText = ref('');
const messageListEl = ref<HTMLElement | null>(null);

// ---- 请求状态 ----
const streaming = ref(false);
let abortController: AbortController | null = null;
let requestStartedAt = 0;
let firstChunkAt: number | null = null;

const lastMetrics = ref<MetricsState>({ ...EMPTY_METRICS });
const rawResponseText = ref('');
const rawIsJson = ref(false);
const publicUrl = ref('');

// ---- 虚拟密钥选项：label 显示名称，副文案显示掩码 key；禁用 enabled=false 的项 ----
// naive-ui 的 SelectMixedOption 是带 type 判别字段的联合，自定义字段须挂在 SelectOption 交叉类型上
type VirtualKeySelectOption = SelectOption & { maskedKey?: string };

function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 12) return `${key.slice(0, 4)}****`;
  return `${key.slice(0, 8)}****${key.slice(-4)}`;
}

const virtualKeyOptions = computed<VirtualKeySelectOption[]>(() =>
  virtualKeyStore.virtualKeys.map(vk => ({
    label: vk.name || vk.keyValue,
    value: vk.id,
    disabled: !vk.enabled,
    maskedKey: maskKey(vk.keyValue),
  })),
);

function renderVirtualKeyLabel(option: SelectOption): VNode {
  const opt = option as VirtualKeySelectOption;
  return h('div', { class: 'vk-option' }, [
    h('div', { class: 'vk-option-name' }, String(opt.label ?? '')),
    h('div', { class: 'vk-option-key' }, opt.maskedKey ?? ''),
  ]);
}

const selectedVirtualKey = computed(() =>
  virtualKeyStore.virtualKeys.find(vk => vk.id === virtualKeyId.value),
);

// ---- localStorage 持久化 ----
function persist(key: string, value: unknown) {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch {
    /* 隐私模式等场景写失败时静默降级为不持久化 */
  }
}

function restore<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

watch(protocol, v => persist('protocol', v));
watch(temperature, v => persist('temperature', v));
watch(topP, v => persist('topP', v));
watch(maxTokens, v => persist('maxTokens', v));
watch(systemPrompt, v => persist('systemPrompt', v));
watch(streamEnabled, v => persist('stream', v));
watch(model, v => persist('model', v));
watch(virtualKeyId, v => persist('virtualKeyId', v));

function restorePersistedConfig() {
  const savedProtocol = restore<string>('protocol', 'openai');
  if (savedProtocol === 'openai' || savedProtocol === 'anthropic') protocol.value = savedProtocol;

  const savedTemperature = restore<number>('temperature', 0.7);
  if (Number.isFinite(savedTemperature)) temperature.value = Math.min(2, Math.max(0, savedTemperature));

  const savedTopP = restore<number>('topP', 1);
  if (Number.isFinite(savedTopP)) topP.value = Math.min(1, Math.max(0, savedTopP));

  const savedMaxTokens = restore<number | null>('maxTokens', null);
  if (savedMaxTokens !== null && Number.isFinite(savedMaxTokens) && savedMaxTokens > 0) {
    maxTokens.value = Math.floor(savedMaxTokens);
  }

  // 下面三项不像数值那样能被 clamp 消掉脏值：陈旧的/被篡改的 localStorage 会把
  // 非字符串灌进 payload.system（后端 zod 会 400，但报错原因对不上），逐类校验。
  const savedSystemPrompt = restore<unknown>('systemPrompt', '');
  if (typeof savedSystemPrompt === 'string') systemPrompt.value = savedSystemPrompt;

  const savedStream = restore<unknown>('stream', true);
  if (typeof savedStream === 'boolean') streamEnabled.value = savedStream;

  const savedKey = restore<unknown>('virtualKeyId', null);
  if (typeof savedKey === 'string') virtualKeyId.value = savedKey;

  const savedModel = restore<unknown>('model', null);
  return typeof savedModel === 'string' ? savedModel : null;
}

// ---- 模型列表加载 ----
async function loadModels(preferred: string | null = null) {
  if (!virtualKeyId.value) {
    modelOptions.value = [];
    modelsError.value = null;
    return;
  }
  modelsLoading.value = true;
  try {
    const res = await playgroundApi.getModels(virtualKeyId.value);
    if (res.error) {
      modelsError.value = res.error;
      modelOptions.value = [];
      model.value = null;
      return;
    }
    modelsError.value = null;
    modelOptions.value = res.models
      .map(m => String(m?.id ?? ''))
      .filter(id => id !== '')
      .map(id => ({ label: id, value: id }));
    // 优先保留当前/持久化的模型，不在新密钥可用范围内才回退到第一个
    const candidate = [preferred, model.value].find(
      id => id && modelOptions.value.some(o => o.value === id),
    );
    model.value = candidate ?? modelOptions.value[0]?.value ?? null;
  } catch (e) {
    modelsError.value = e instanceof Error ? e.message : String(e);
    modelOptions.value = [];
  } finally {
    modelsLoading.value = false;
  }
}

function onVirtualKeyChange() {
  model.value = null;
  loadModels();
}

function refreshModels() {
  loadModels();
}

// ---- payload 组装 ----
type UpstreamMessage = { role: string; content: string };

/** 发送时排除流式占位与空消息。 */
function conversationForPayload(): UpstreamMessage[] {
  return messages.value
    .filter(m => !m.streaming && m.content.trim() !== '')
    .map(m => ({ role: m.role, content: m.content }));
}

/**
 * 组出网关将转发给上游的 body（与后端 playground 路由的折叠规则一致：
 * OpenAI 协议 system 折算为首条 system message；Anthropic 协议走顶层 system）。
 */
function buildUpstreamBody(msgs: UpstreamMessage[], stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = { model: model.value ?? '', stream };
  if (protocol.value === 'anthropic') {
    body.messages = msgs
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role, content: m.content }));
    const systemParts = [
      systemPrompt.value.trim(),
      ...msgs.filter(m => m.role === 'system').map(m => m.content.trim()),
    ].filter(Boolean);
    if (systemParts.length > 0) body.system = systemParts.join('\n\n');
    // Anthropic 后端默认 1024，显式写出让 curl/payload 预览与实际一致
    body.max_tokens = maxTokens.value ?? 1024;
  } else {
    const list = systemPrompt.value.trim()
      ? [{ role: 'system', content: systemPrompt.value.trim() }, ...msgs]
      : msgs;
    body.messages = list.map(m => ({ role: m.role, content: m.content }));
    if (maxTokens.value !== null) body.max_tokens = maxTokens.value;
  }
  body.temperature = temperature.value;
  body.top_p = topP.value;
  return body;
}

function buildGatewayPayload(
  msgs: UpstreamMessage[],
  stream: boolean,
): PlaygroundChatRequest | PlaygroundAnthropicRequest {
  const upstream = buildUpstreamBody(msgs, stream);
  const payloadMessages = upstream.messages as UpstreamMessage[];
  if (protocol.value === 'anthropic') {
    const payload: PlaygroundAnthropicRequest = {
      virtualKeyId: virtualKeyId.value ?? '',
      model: model.value ?? '',
      messages: payloadMessages,
      temperature: temperature.value,
      top_p: topP.value,
      max_tokens: maxTokens.value ?? 1024,
      stream,
    };
    if (typeof upstream.system === 'string') payload.system = upstream.system;
    return payload;
  }
  const payload: PlaygroundChatRequest = {
    virtualKeyId: virtualKeyId.value ?? '',
    model: model.value ?? '',
    messages: payloadMessages,
    temperature: temperature.value,
    top_p: topP.value,
    stream,
  };
  if (maxTokens.value !== null) payload.max_tokens = maxTokens.value;
  return payload;
}

// ---- 流式增量解析：解析不到的帧类型直接忽略 ----
function extractDelta(data: string, proto: PlaygroundProtocol): string {
  if (!data || data === '[DONE]') return '';
  let json: any;
  try {
    json = JSON.parse(data);
  } catch {
    return '';
  }
  if (proto === 'openai') {
    const content = json?.choices?.[0]?.delta?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(b => (typeof b?.text === 'string' ? b.text : '')).join('');
    }
    return '';
  }
  if (
    json?.type === 'content_block_delta' &&
    json?.delta?.type === 'text_delta' &&
    typeof json?.delta?.text === 'string'
  ) {
    return json.delta.text;
  }
  return '';
}

// ---- 非流式内容提取 ----
function extractContent(body: any, proto: PlaygroundProtocol): string {
  if (!body || typeof body !== 'object') return '';
  if (proto === 'openai') {
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(b => (typeof b?.text === 'string' ? b.text : '')).join('');
    }
    return '';
  }
  if (Array.isArray(body.content)) {
    return body.content.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('');
  }
  return typeof body.content === 'string' ? body.content : '';
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

// ---- 原始帧日志（节流同步到响应力，避免高频字符串拷贝卡 UI） ----
let rawStreamBuffer = '';
let rawSyncAt = 0;
let rawTruncated = false;

function appendRawChunk(data: string) {
  if (rawTruncated) return;
  if (rawStreamBuffer.length + data.length > RAW_LOG_CHAR_LIMIT) {
    rawStreamBuffer += '\n\n…(truncated)';
    rawTruncated = true;
  } else {
    rawStreamBuffer = rawStreamBuffer ? `${rawStreamBuffer}\n\n${data}` : data;
  }
  const now = performance.now();
  if (now - rawSyncAt > 250) {
    rawSyncAt = now;
    rawResponseText.value = rawStreamBuffer;
  }
}

// ---- 指标 ----
function beginMetrics() {
  lastMetrics.value = { ...EMPTY_METRICS, hasData: true, model: model.value };
}

function applyStreamMetrics(frame: PlaygroundStreamFrame) {
  lastMetrics.value = {
    hasData: true,
    ok: true,
    status: null,
    ttftMs: frame.ttftMs,
    localTtftMs: lastMetrics.value.localTtftMs,
    durationMs: frame.durationMs,
    usage: frame.metrics.usage,
    cost: frame.cost,
    model: frame.metrics.model,
    requestId: frame.metrics.requestId,
    error: null,
  };
}

function applyResultMetrics(result: PlaygroundResult) {
  lastMetrics.value = {
    hasData: true,
    ok: result.ok,
    status: result.status,
    ttftMs: result.ttftMs,
    localTtftMs: null,
    durationMs: result.durationMs,
    usage: result.metrics.usage,
    cost: result.cost,
    model: result.metrics.model,
    requestId: result.metrics.requestId,
    error: null,
  };
}

const statusTagText = computed(() => {
  const m = lastMetrics.value;
  const label =
    m.ok === null
      ? t('playground.metrics.pending')
      : m.ok
        ? t('playground.metrics.success')
        : t('playground.metrics.failed');
  return m.status !== null ? `${m.status} · ${label}` : label;
});

const ttftText = computed(() => {
  const m = lastMetrics.value;
  // 后端没回 ttftMs（非流式 / 指标帧缺失）时用客户端本地首帧计时兜底
  if (m.ttftMs === null && m.localTtftMs !== null) {
    return `${m.localTtftMs} ms（${t('playground.metrics.localTiming')}）`;
  }
  return formatMs(m.ttftMs);
});

function formatMs(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? '—' : `${Math.round(ms).toLocaleString()} ms`;
}

function formatToken(value: number | undefined): string {
  return value === undefined || value === null ? '—' : value.toLocaleString();
}

function formatCost(cost: number | null): string {
  // 成本口径：后端 costMappingService.estimateUsageCost 按 usage × 模型单价估算，
  // 价格映射缺失时返回 null（展示「价格未知」）
  return cost === null ? t('playground.metrics.unknownCost') : `$${cost.toFixed(6)}`;
}

function gotoRequest() {
  const query: Record<string, string> = {};
  if (lastMetrics.value.model) query.model = lastMetrics.value.model;
  if (virtualKeyId.value) query.virtualKeyId = virtualKeyId.value;
  router.push({ name: 'ApiRequests', query });
}

// ---- 发送 ----
function isAbortError(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'AbortError';
}

async function sendMessage() {
  if (streaming.value) return;
  if (!virtualKeyId.value) {
    message.warning(t('playground.chat.needKey'));
    return;
  }
  if (!model.value) {
    message.warning(t('playground.chat.needModel'));
    return;
  }
  const text = inputText.value.trim();
  if (!text) {
    message.warning(t('playground.chat.needInput'));
    return;
  }
  inputText.value = '';
  messages.value.push({ id: ++messageIdSeq, role: 'user', content: text });
  const history = conversationForPayload();
  const assistant: ChatMessage = { id: ++messageIdSeq, role: 'assistant', content: '', streaming: true };
  messages.value.push(assistant);
  await executeRequest(history, assistant);
}

async function executeRequest(history: UpstreamMessage[], assistant: ChatMessage) {
  beginMetrics();
  rawStreamBuffer = '';
  rawTruncated = false;
  rawSyncAt = 0;
  rawResponseText.value = '';
  rawIsJson.value = false;
  firstChunkAt = null;
  requestStartedAt = performance.now();
  streaming.value = true;
  abortController = new AbortController();
  const payload = buildGatewayPayload(history, streamEnabled.value);

  try {
    if (streamEnabled.value) {
      await streamPlayground(protocol.value === 'anthropic' ? 'messages' : 'chat', payload, {
        signal: abortController.signal,
        onChunk: data => {
          if (firstChunkAt === null) {
            firstChunkAt = performance.now();
            lastMetrics.value.localTtftMs = Math.round(firstChunkAt - requestStartedAt);
          }
          appendRawChunk(data);
          const delta = extractDelta(data, protocol.value);
          if (delta) assistant.content += delta;
        },
        onMetrics: frame => applyStreamMetrics(frame),
      });
    } else {
      const result =
        protocol.value === 'anthropic'
          ? await playgroundApi.messages(payload as PlaygroundAnthropicRequest)
          : await playgroundApi.chat(payload as PlaygroundChatRequest);
      const content = extractContent(result.body, protocol.value);
      if (content) assistant.content = content;
      rawIsJson.value = true;
      rawResponseText.value = safeJsonStringify(result.body);
      applyResultMetrics(result);
    }
  } catch (err) {
    if (isAbortError(err)) {
      // 用户主动停止不算错误
      message.info(t('playground.chat.stopped'));
    } else {
      const errMsg = err instanceof Error ? err.message : String(err);
      message.error(errMsg || t('playground.requestFailed'));
      lastMetrics.value.ok = false;
      lastMetrics.value.error = errMsg || t('playground.requestFailed');
    }
  } finally {
    assistant.streaming = false;
    streaming.value = false;
    abortController = null;
    rawResponseText.value = rawStreamBuffer || rawResponseText.value;
    // 本地计时兜底：指标帧未到达（中止/异常）时至少补齐耗时
    if (lastMetrics.value.durationMs === null) {
      lastMetrics.value.durationMs = Math.round(performance.now() - requestStartedAt);
    }
    if (!assistant.content) removeMessage(assistant.id);
  }
}

function stopStreaming() {
  abortController?.abort();
}

function handleInputKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendMessage();
  }
}

function removeMessage(id: number) {
  messages.value = messages.value.filter(m => m.id !== id);
}

function resendAsInput(m: ChatMessage) {
  if (streaming.value) return;
  inputText.value = m.content;
  sendMessage();
}

function clearConversation() {
  if (streaming.value) return;
  messages.value = [];
  inputText.value = '';
}

function roleTagType(role: ChatMessage['role']): 'success' | 'info' | 'warning' {
  if (role === 'user') return 'success';
  if (role === 'system') return 'warning';
  return 'info';
}

// 新内容到达时保持滚动到底部
watch(
  messages,
  async () => {
    await nextTick();
    const el = messageListEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  },
  { deep: true },
);

// ---- 响应明细 ----
const payloadPreview = computed(() =>
  safeJsonStringify(buildUpstreamBody(conversationForPayload(), streamEnabled.value)),
);

const curlSnippet = computed(() => {
  const base = (publicUrl.value || window.location.origin).replace(/\/+$/, '');
  const path = protocol.value === 'openai' ? '/v1/chat/completions' : '/v1/messages';
  const key = selectedVirtualKey.value?.keyValue || 'YOUR_VIRTUAL_KEY';
  const headerLines = [
    '-H "Content-Type: application/json"',
    `-H "Authorization: Bearer ${key}"`,
    ...(protocol.value === 'anthropic' ? ['-H "anthropic-version: 2023-06-01"'] : []),
  ];
  const body = safeJsonStringify(buildUpstreamBody(conversationForPayload(), streamEnabled.value));
  return [`curl -X POST ${base}${path}`, ...headerLines.map(l => `  ${l} \\`), `  -d '${body.replace(/'/g, `'\\''`)}'`].join(
    '\n',
  );
});

async function copyCurl() {
  try {
    await navigator.clipboard.writeText(curlSnippet.value);
    message.success(t('playground.copySuccess'));
  } catch {
    // clipboard API 仅安全上下文可用，退回 execCommand
    try {
      const textarea = document.createElement('textarea');
      textarea.value = curlSnippet.value;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand('copy');
      document.body.removeChild(textarea);
      if (!copied) throw new Error('execCommand copy failed');
      message.success(t('playground.copySuccess'));
    } catch {
      message.error(t('playground.copyFailed'));
    }
  }
}

// ---- 初始化 ----
onMounted(async () => {
  const persistedModel = restorePersistedConfig();
  await virtualKeyStore.fetchVirtualKeys();

  const keys = virtualKeyStore.virtualKeys;
  if (virtualKeyId.value && !keys.some(k => k.id === virtualKeyId.value)) {
    virtualKeyId.value = null;
  }
  if (!virtualKeyId.value) {
    virtualKeyId.value = keys.find(k => k.enabled)?.id ?? null;
  }
  if (virtualKeyId.value) {
    await loadModels(persistedModel);
  }

  try {
    const settings = await configApi.getSystemSettings();
    if (settings?.publicUrl) publicUrl.value = settings.publicUrl;
  } catch {
    /* 拿不到配置时 curl 用当前站点地址兜底 */
  }
});
</script>

<style scoped>
.playground-page {
  max-width: 1500px;
  margin: 0 auto;
  padding: 0 0 32px 0;
}

.playground-page-header {
  margin-bottom: 20px;
}

.page-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.playground-grid {
  margin-bottom: 16px;
}

.full-height-card {
  height: 100%;
}

.config-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.config-field-inline {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}

.config-label {
  font-size: 13px;
  color: #595959;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.config-value {
  font-variant-numeric: tabular-nums;
  color: #8c8c8c;
}

.protocol-group {
  width: 100%;
  display: flex;
}

.protocol-group :deep(.n-radio-button) {
  flex: 1;
}

.protocol-group :deep(.n-radio-button .n-radio__label) {
  width: 100%;
  text-align: center;
  font-size: 12px;
}

.max-tokens-input {
  width: 100%;
}

.models-error {
  margin-top: 8px;
}

.vk-option-name {
  font-size: 14px;
  line-height: 1.4;
}

.vk-option-key {
  font-size: 12px;
  color: #8c8c8c;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
}

.chat-card :deep(.n-card__content) {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: calc(100% - 46px);
  min-height: 420px;
}

.message-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-right: 4px;
}

.chat-empty {
  margin: auto;
}

.message {
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 8px;
  padding: 10px 12px;
  background: rgba(0, 0, 0, 0.015);
}

.message-assistant {
  background: rgba(15, 107, 74, 0.04);
}

.message-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.message-actions {
  margin-left: auto;
  display: flex;
  gap: 4px;
}

.message-stream-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
}

.stream-cursor {
  display: inline-block;
  width: 7px;
  height: 14px;
  margin-left: 2px;
  vertical-align: text-bottom;
  background: currentColor;
  animation: stream-blink 1s steps(2) infinite;
}

@keyframes stream-blink {
  50% {
    opacity: 0;
  }
}

.chat-input-area {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: none;
}

.chat-input-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.metrics-card :deep(.n-card__content) {
  height: calc(100% - 46px);
}

.metrics-empty {
  color: #8c8c8c;
  font-size: 13px;
  padding: 8px 0;
}

.metrics-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.metrics-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
}

.metrics-label {
  color: #8c8c8c;
  flex: none;
}

.metrics-value {
  text-align: right;
  word-break: break-all;
  font-variant-numeric: tabular-nums;
}

.metrics-mono {
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 12px;
}

.metrics-request {
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: flex-end;
  flex-wrap: wrap;
}

.metrics-error {
  font-size: 12px;
  color: #d03050;
  word-break: break-word;
  border-top: 1px dashed rgba(0, 0, 0, 0.08);
  padding-top: 10px;
}

.details-card {
  margin-top: 0;
}

.code-scrollbar {
  max-height: 360px;
  border-radius: 6px;
}

.curl-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
</style>
