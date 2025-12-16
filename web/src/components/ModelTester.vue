<template>
  <div class="model-tester">
    <n-space vertical :size="16">
      <n-space justify="space-between" align="center">
        <n-space :size="8" align="center">
          <span class="model-info">
            <strong>{{ model.name }}</strong>
            <n-text depth="3" style="margin-left: 8px">{{ model.modelIdentifier }}</n-text>
          </span>
        </n-space>
        <n-button
          type="primary"
          :loading="testing"
          @click="handleTest"
          size="small"
        >
          <template #icon>
            <n-icon><FlashOutline /></n-icon>
          </template>
          {{ testing ? t('common.testing') : t('common.startTest') }}
        </n-button>
      </n-space>

      <div v-if="testResult" class="test-result">
        <n-card size="small" class="result-card">
          <n-space vertical :size="16">
            <!-- Chat Completions 测试结果 -->
            <div class="endpoint-result">
              <n-divider style="margin: 8px 0;">
                <n-space :size="8" align="center">
                  <span style="font-weight: bold;">{{ getChatEndpointName() }}</span>
                  <n-tag
                    :type="testResult.chat.success ? 'success' : 'error'"
                    size="small"
                    round
                  >
                    {{ testResult.chat.success ? '成功' : '失败' }}
                  </n-tag>
                </n-space>
              </n-divider>

              <n-space vertical :size="12">
                <n-descriptions :column="2" size="small" bordered>
                  <n-descriptions-item label="响应时间">
                    <n-text :type="getResponseTimeType(testResult.chat.responseTime)">
                      {{ testResult.chat.responseTime }}ms
                    </n-text>
                  </n-descriptions-item>
                  <n-descriptions-item label="状态码" v-if="testResult.chat.status">
                    <n-tag :type="testResult.chat.status < 400 ? 'success' : 'error'" size="small">
                      {{ testResult.chat.status }}
                    </n-tag>
                  </n-descriptions-item>
                </n-descriptions>

                <div v-if="testResult.chat.success && testResult.chat.response" class="response-section">
                  <n-card size="small" class="response-content">
                    <n-text code>{{ testResult.chat.response.content }}</n-text>
                  </n-card>
                  
                  <div v-if="testResult.chat.response.usage" class="usage-info">
                    <n-descriptions :column="3" size="small" style="margin-top: 8px;">
                      <n-descriptions-item label="输入 Tokens">
                        {{ getInputTokens(testResult.chat.response.usage) }}
                      </n-descriptions-item>
                      <n-descriptions-item label="输出 Tokens">
                        {{ getOutputTokens(testResult.chat.response.usage) }}
                      </n-descriptions-item>
                      <n-descriptions-item label="总计 Tokens">
                        {{ getTotalTokens(testResult.chat.response.usage) }}
                      </n-descriptions-item>
                    </n-descriptions>
                  </div>
                </div>

                <div v-if="!testResult.chat.success && testResult.chat.error" class="error-section">
                  <n-card size="small" class="error-content">
                    <n-text code style="font-size: 12px; white-space: pre-wrap;">{{ testResult.chat.error }}</n-text>
                  </n-card>
                </div>
              </n-space>
            </div>

            <div class="endpoint-result" v-if="!isAnthropicProtocol() && !isGoogleProtocol()">
              <n-divider style="margin: 8px 0;">
                <n-space :size="8" align="center">
                  <span style="font-weight: bold;">Responses API</span>
                  <n-tag
                    :type="testResult.responses.success ? 'success' : 'error'"
                    size="small"
                    round
                  >
                    {{ testResult.responses.success ? '成功' : '失败' }}
                  </n-tag>
                </n-space>
              </n-divider>

              <n-space vertical :size="12">
                <n-descriptions :column="2" size="small" bordered>
                  <n-descriptions-item label="响应时间">
                    <n-text :type="getResponseTimeType(testResult.responses.responseTime)">
                      {{ testResult.responses.responseTime }}ms
                    </n-text>
                  </n-descriptions-item>
                  <n-descriptions-item label="状态码" v-if="testResult.responses.status">
                    <n-tag :type="testResult.responses.status < 400 ? 'success' : 'error'" size="small">
                      {{ testResult.responses.status }}
                    </n-tag>
                  </n-descriptions-item>
                </n-descriptions>

                <div v-if="testResult.responses.success && testResult.responses.response" class="response-section">
                  <n-card size="small" class="response-content">
                    <n-text code>{{ testResult.responses.response.content }}</n-text>
                  </n-card>
                  
                  <div v-if="testResult.responses.response.usage" class="usage-info">
                    <n-descriptions :column="3" size="small" style="margin-top: 8px;">
                      <n-descriptions-item label="输入 Tokens">
                        {{ getInputTokens(testResult.responses.response.usage) }}
                      </n-descriptions-item>
                      <n-descriptions-item label="输出 Tokens">
                        {{ getOutputTokens(testResult.responses.response.usage) }}
                      </n-descriptions-item>
                      <n-descriptions-item label="总计 Tokens">
                        {{ getTotalTokens(testResult.responses.response.usage) }}
                      </n-descriptions-item>
                    </n-descriptions>
                  </div>
                </div>

                <div v-if="!testResult.responses.success && testResult.responses.error" class="error-section">
                  <n-card size="small" class="error-content">
                    <n-text code style="font-size: 12px; white-space: pre-wrap;">{{ testResult.responses.error }}</n-text>
                  </n-card>
                </div>
              </n-space>
            </div>
          </n-space>
        </n-card>
      </div>
    </n-space>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NSpace,
  NButton,
  NCard,
  NIcon,
  NText,
  NTag,
  NDescriptions,
  NDescriptionsItem,
  NDivider,
  useMessage,
} from 'naive-ui';
import {
  FlashOutline,
} from '@vicons/ionicons5';
import { modelApi } from '@/api/model';
import { isAnthropicProtocol as checkIsAnthropicProtocol } from '@/utils/protocol-utils';
import type { Model } from '@/types';

const { t } = useI18n();

interface EndpointTestResult {
  success: boolean;
  status?: number;
  message: string;
  responseTime: number;
  response?: {
    content: string;
    usage?: any;
  };
  error?: string;
}

interface TestResult {
  chat: EndpointTestResult;
  responses: EndpointTestResult;
  timestamp: number;
}

interface Props {
  model: Model;
}

const props = defineProps<Props>();
const message = useMessage();

const testing = ref(false);
const testResult = ref<TestResult | null>(null);

async function handleTest() {
  if (props.model.isVirtual) {
    message.warning(t('models.testWarning'));
    return;
  }

  testing.value = true;
  try {
    const result = await modelApi.test(props.model.id);
    const testData: TestResult = {
      chat: result.chat,
      responses: result.responses,
      timestamp: Date.now(),
    };

    testResult.value = testData;

    const chatSuccess = result.chat.success;
    const responsesSuccess = result.responses.success;

    if (isAnthropicProtocol()) {
      if (chatSuccess) {
        message.success('测试成功');
      } else {
        message.error('测试失败');
      }
    } else {
      if (chatSuccess && responsesSuccess) {
        message.success('两个接口测试均成功');
      } else if (chatSuccess || responsesSuccess) {
        message.warning('部分接口测试成功');
      } else {
        message.error('两个接口测试均失败');
      }
    }
  } catch (error: any) {
    const testData: TestResult = {
      chat: {
        success: false,
        message: '请求失败',
        responseTime: 0,
        error: error.message,
      },
      responses: {
        success: false,
        message: '请求失败',
        responseTime: 0,
        error: error.message,
      },
      timestamp: Date.now(),
    };

    testResult.value = testData;
    message.error(t('models.testFailed'));
  } finally {
    testing.value = false;
  }
}

function getResponseTimeType(responseTime: number): 'default' | 'success' | 'warning' | 'error' {
  if (responseTime < 1000) return 'success';
  if (responseTime < 3000) return 'warning';
  return 'error';
}

function isAnthropicProtocol(): boolean {
  return checkIsAnthropicProtocol(props.model);
}

function isGoogleProtocol(): boolean {
  return props.model.protocol === 'google';
}

function getChatEndpointName(): string {
  const protocol = props.model.protocol;
  if (protocol === 'anthropic') {
    return 'Messages API (Anthropic)';
  } else if (protocol === 'google') {
    return 'Gemini 原生 API';
  }
  return 'Chat Completions API (OpenAI)';
}

function getInputTokens(usage: any): number {
  // Gemini: promptTokenCount, OpenAI: prompt_tokens, Anthropic: input_tokens
  const base = (usage?.promptTokenCount ?? usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
  const cached = (usage?.input_tokens_details?.cached_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0);
  return base === 0 ? base + cached : base;
}

function getOutputTokens(usage: any): number {
  // Gemini: candidatesTokenCount, OpenAI: completion_tokens, Anthropic: output_tokens
  return usage?.candidatesTokenCount || usage?.output_tokens || usage?.completion_tokens || 0;
}

function getTotalTokens(usage: any): number {
  // Gemini: totalTokenCount, OpenAI/Anthropic: total_tokens
  if (usage?.totalTokenCount) {
    return usage.totalTokenCount;
  }
  if (usage?.total_tokens) {
    return usage.total_tokens;
  }
  return getInputTokens(usage) + getOutputTokens(usage);
}
</script>

<style scoped>
.model-tester {
  padding: 16px;
}

.model-info {
  display: flex;
  align-items: center;
}

.test-result {
  margin-top: 16px;
}

.result-card.success {
  border-color: #18a058;
}

.result-card.error {
  border-color: #d03050;
}

.response-section,
.error-section {
  margin-top: 12px;
}

.response-content,
.error-content {
  background: #f8f9fa;
  border: 1px solid #e8e8e8;
  max-height: 200px;
  overflow-y: auto;
}

.usage-info {
  margin-top: 8px;
}
</style>
