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
        <n-card size="small" :class="['result-card', testResult.success ? 'success' : 'error']">
          <template #header>
            <n-space :size="8" align="center">
              <n-icon :size="18" :color="testResult.success ? '#18a058' : '#d03050'">
                <CheckmarkCircleOutline v-if="testResult.success" />
                <CloseCircleOutline v-else />
              </n-icon>
              <span>{{ testResult.message }}</span>
              <n-tag
                :type="testResult.success ? 'success' : 'error'"
                size="small"
                round
              >
                {{ testResult.success ? t('common.success') : t('common.failed') }}
              </n-tag>
            </n-space>
          </template>

          <n-space vertical :size="12">
            <n-descriptions :column="2" size="small" bordered>
              <n-descriptions-item :label="t('common.responseTime')">
                <n-text :type="getResponseTimeType(testResult.responseTime)">
                  {{ testResult.responseTime }}ms
                </n-text>
              </n-descriptions-item>
              <n-descriptions-item :label="t('apiRequests.statusCode')" v-if="testResult.status">
                <n-tag :type="testResult.status < 400 ? 'success' : 'error'" size="small">
                  {{ testResult.status }}
                </n-tag>
              </n-descriptions-item>
            </n-descriptions>

            <div v-if="testResult.success && testResult.response" class="response-section">
              <n-divider style="margin: 8px 0;">响应内容</n-divider>
              <n-card size="small" class="response-content">
                <n-text code>{{ testResult.response.content }}</n-text>
              </n-card>
              
              <div v-if="testResult.response.usage" class="usage-info">
                <n-divider style="margin: 8px 0;">Token 使用情况</n-divider>
                <n-descriptions :column="3" size="small">
                  <n-descriptions-item label="输入 Tokens">
                    {{ testResult.response.usage.prompt_tokens || 0 }}
                  </n-descriptions-item>
                  <n-descriptions-item label="输出 Tokens">
                    {{ testResult.response.usage.completion_tokens || 0 }}
                  </n-descriptions-item>
                  <n-descriptions-item label="总计 Tokens">
                    {{ testResult.response.usage.total_tokens || 0 }}
                  </n-descriptions-item>
                </n-descriptions>
              </div>
            </div>

            <div v-if="!testResult.success && testResult.error" class="error-section">
              <n-divider style="margin: 8px 0;">错误详情</n-divider>
              <n-card size="small" class="error-content">
                <n-text code style="font-size: 12px; white-space: pre-wrap;">{{ testResult.error }}</n-text>
              </n-card>
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
  CheckmarkCircleOutline,
  CloseCircleOutline,
} from '@vicons/ionicons5';
import { modelApi } from '@/api/model';
import type { Model } from '@/types';

const { t } = useI18n();

interface TestResult {
  success: boolean;
  status?: number;
  message: string;
  responseTime: number;
  response?: {
    content: string;
    usage?: any;
  };
  error?: string;
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
      ...result,
      timestamp: Date.now(),
    };

    testResult.value = testData;

    if (result.success) {
      message.success(t('models.testSuccess'));
    } else {
      message.error(t('models.testFailed'));
    }
  } catch (error: any) {
    const testData: TestResult = {
      success: false,
      message: error.message || t('models.testRequestFailed'),
      responseTime: 0,
      error: error.message,
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
