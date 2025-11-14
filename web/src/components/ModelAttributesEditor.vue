<template>
  <div class="model-attributes-editor">
    <n-collapse :default-expanded-names="['features']">
      <n-collapse-item name="advanced" title="高级属性">
        <n-space vertical :size="8">
          <n-text depth="3" style="font-size: 12px;">自定义请求头 (Headers)</n-text>
          <n-input
            v-model:value="headersText"
            type="textarea"
            placeholder="User-Agent: MyApp/1.0&#10;X-API-Key: your-key&#10;Authorization: Bearer token"
            :rows="4"
            size="small"
          />
          <n-text depth="3" style="font-size: 11px; color: #999;">
            每行一个请求头，格式: Key: Value
          </n-text>
        </n-space>
      </n-collapse-item>

      <n-collapse-item name="features" :title="t('models.featureSupport')">
        <n-table :bordered="false" :single-line="false" size="small">
          <tbody>
            <tr v-for="attr in featureAttrs" :key="attr.key">
              <td style="width: 180px;">{{ attr.labelKey ? t(attr.labelKey) : attr.label }}</td>
              <td style="width: 80px; text-align: center;">
                <n-switch v-model:value="localAttributes[attr.key] as boolean" size="small" />
              </td>
              <td style="color: #999; font-size: 12px;">{{ attr.descriptionKey ? t(attr.descriptionKey) : attr.description }}</td>
            </tr>
          </tbody>
        </n-table>
      </n-collapse-item>

      <n-collapse-item name="performance" :title="t('models.performanceParams')">
        <n-space vertical :size="4">
          <div v-for="attr in performanceAttrs" :key="attr.key" class="attr-item">
            <n-form-item :label="attr.label" :label-width="140" size="small">
              <template #label>
                <n-space :size="4" align="center">
                  <span>{{ attr.label }}</span>
                  <n-tooltip>
                    <template #trigger>
                      <n-icon :size="14" style="cursor: help; color: #999;">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                          <path fill="currentColor" d="M11 17h2v-6h-2v6zm1-8q.425 0 .713-.288T13 8q0-.425-.288-.713T12 7q-.425 0-.713.288T11 8q0 .425.288.713T12 9zm0 13q-2.075 0-3.9-.788t-3.175-2.137q-1.35-1.35-2.137-3.175T2 12q0-2.075.788-3.9t2.137-3.175q1.35-1.35 3.175-2.137T12 2q2.075 0 3.9.788t3.175 2.137q1.35 1.35 2.138 3.175T22 12q0 2.075-.788 3.9t-2.137 3.175q-1.35 1.35-3.175 2.138T12 22z"/>
                        </svg>
                      </n-icon>
                    </template>
                    {{ attr.description }}
                  </n-tooltip>
                </n-space>
              </template>
              <n-input-number
                v-model:value="localAttributes[attr.key] as number | null"
                :min="attr.min"
                :max="attr.max"
                :step="attr.step"
                :placeholder="`请输入${attr.label}`"
                size="small"
                clearable
                style="width: 100%"
              >
                <template #suffix v-if="attr.unit">
                  <span style="color: #999; font-size: 12px;">{{ attr.unit }}</span>
                </template>
              </n-input-number>
            </n-form-item>
          </div>
        </n-space>
      </n-collapse-item>

      <n-collapse-item name="cost" :title="t('models.costParams')">
        <n-space vertical :size="4">
          <div v-for="attr in costAttrs" :key="attr.key" class="attr-item">
            <n-form-item :label="attr.label" :label-width="140" size="small">
              <template #label>
                <n-space :size="4" align="center">
                  <span>{{ attr.label }}</span>
                  <n-tooltip>
                    <template #trigger>
                      <n-icon :size="14" style="cursor: help; color: #999;">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                          <path fill="currentColor" d="M11 17h2v-6h-2v6zm1-8q.425 0 .713-.288T13 8q0-.425-.288-.713T12 7q-.425 0-.713.288T11 8q0 .425.288.713T12 9zm0 13q-2.075 0-3.9-.788t-3.175-2.137q-1.35-1.35-2.137-3.175T2 12q0-2.075.788-3.9t2.137-3.175q1.35-1.35 3.175-2.137T12 2q2.075 0 3.9.788t3.175 2.137q1.35 1.35 2.138 3.175T22 12q0 2.075-.788 3.9t-2.137 3.175q-1.35 1.35-3.175 2.138T12 22z"/>
                        </svg>
                      </n-icon>
                    </template>
                    {{ attr.description }}
                  </n-tooltip>
                </n-space>
              </template>
              <n-input-number
                v-model:value="localAttributes[attr.key] as number | null"
                :min="attr.min"
                :step="attr.step"
                :placeholder="`请输入${attr.label}`"
                size="small"
                clearable
                style="width: 100%"
              >
                <template #suffix v-if="attr.unit">
                  <span style="color: #999; font-size: 12px;">{{ attr.unit }}</span>
                </template>
              </n-input-number>
            </n-form-item>
          </div>
        </n-space>
      </n-collapse-item>
    </n-collapse>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import { NCollapse, NCollapseItem, NSpace, NFormItem, NInputNumber, NSwitch, NTooltip, NIcon, NTable, NInput, NText } from 'naive-ui';
import { getAttributesByCategory } from '@/constants/modelAttributes';
import { MILLION, COST_PRECISION } from '@/constants/numbers';
import type { ModelAttributes } from '@/types';

const { t } = useI18n();

const props = defineProps<{
  modelValue?: ModelAttributes | null;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: ModelAttributes];
}>();

const localAttributes = ref<ModelAttributes>({});
const headersText = ref<string>('');

const performanceAttrs = computed(() => getAttributesByCategory('性能参数'));
const costAttrs = computed(() => getAttributesByCategory('成本参数'));
const featureAttrs = computed(() => getAttributesByCategory('功能支持'));

const isUpdatingFromProps = ref(false);

// 成本相关的属性键
const COST_KEYS: Array<keyof ModelAttributes> = [
  'input_cost_per_token',
  'output_cost_per_token',
  'input_cost_per_token_cache_hit'
];

/**
 * 验证数值是否为有效的非负数
 */
function isValidNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value) && value >= 0;
}

/**
 * 将 token 成本转换为每百万 token 成本 (Mtoken)
 */
function convertToMtoken(value: unknown): number | null {
  if (!isValidNumber(value)) return null;
  return Number((value * MILLION).toFixed(COST_PRECISION));
}

/**
 * 将每百万 token 成本转换回 token 成本
 */
function convertToToken(value: unknown): number | null {
  if (!isValidNumber(value)) return null;
  return value / MILLION;
}

/**
 * 将 headers 对象转换为文本格式
 */
function headersToText(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

/**
 * 将文本格式转换为 headers 对象
 */
function textToHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const lines = text.split('\n').filter(line => line.trim());

  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.substring(0, colonIndex).trim();
      const value = line.substring(colonIndex + 1).trim();
      if (key && value) {
        headers[key] = value;
      }
    }
  }

  return headers;
}

watch(() => props.modelValue, async (newValue) => {
  isUpdatingFromProps.value = true;
  if (newValue) {
    const converted = { ...newValue };
    COST_KEYS.forEach(key => {
      const value = converted[key];
      if (value !== undefined && value !== null) {
        const mtokenValue = convertToMtoken(value);
        if (mtokenValue !== null) {
          converted[key] = mtokenValue as any;
        }
      }
    });
    localAttributes.value = converted;
    headersText.value = newValue.headers ? headersToText(newValue.headers) : '';
  } else {
    localAttributes.value = {};
    headersText.value = '';
  }
  await nextTick();
  isUpdatingFromProps.value = false;
}, { immediate: true, deep: true });

/**
 * 清理单个属性值，处理成本相关的单位转换
 */
function cleanAttributeValue(key: keyof ModelAttributes, value: any): number | boolean | string | null {
  if (COST_KEYS.includes(key)) {
    return convertToToken(value);
  }
  return value as any;
}

/**
 * 构建清理后的属性对象
 */
function buildCleanedAttributes(): ModelAttributes {
  const cleanedValue: ModelAttributes = {};

  Object.entries(localAttributes.value).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== '') {
      const typedKey = key as keyof ModelAttributes;
      const finalValue = cleanAttributeValue(typedKey, value);

      if (finalValue !== null) {
        cleanedValue[typedKey] = finalValue as any;
      }
    }
  });

  return cleanedValue;
}

/**
 * 构建 headers 对象
 */
function buildHeaders(parsedHeaders: Record<string, string>): Record<string, string> | undefined {
  // 文本框为空，显式设置为 undefined 以清空数据库中的值
  if (headersText.value.trim() === '') {
    return undefined;
  }

  // 文本框有内容，解析后设置
  if (Object.keys(parsedHeaders).length > 0) {
    const cleanedHeaders: Record<string, string> = {};
    Object.entries(parsedHeaders).forEach(([key, value]) => {
      if (key && value) {
        cleanedHeaders[key] = value;
      }
    });

    if (Object.keys(cleanedHeaders).length > 0) {
      return cleanedHeaders;
    }
  }

  return undefined;
}

function emitValue() {
  if (isUpdatingFromProps.value) return;

  const parsedHeaders = textToHeaders(headersText.value);
  const cleanedValue = buildCleanedAttributes();
  cleanedValue.headers = buildHeaders(parsedHeaders);

  emit('update:modelValue', cleanedValue);
}

watch(localAttributes, () => {
  emitValue();
}, { deep: true });

// 暴露方法给父组件，用于在保存前强制更新一次
defineExpose({
  syncHeaders: () => {
    emitValue();
  }
});
</script>

<style scoped>
.model-attributes-editor {
  max-height: 400px;
  overflow-y: auto;
}

.attr-item {
  padding: 0;
  margin: 0;
}

.attr-item :deep(.n-form-item) {
  margin-bottom: 0;
}

.attr-item :deep(.n-form-item-blank) {
  min-height: 28px;
}

.model-attributes-editor :deep(.n-table td) {
  border-bottom: none;
}
</style>

