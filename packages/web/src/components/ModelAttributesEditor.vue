<template>
  <div class="model-attributes-editor">
    <n-collapse>
      <n-collapse-item
        v-for="cat in categories"
        :key="cat"
        :name="categoryMeta[cat].name"
        :title="t(categoryMeta[cat].titleKey)"
      >
        <n-space vertical :size="4">
          <div v-for="attr in attrsByCategory(cat)" :key="attr.key" class="attr-item">
            <n-form-item :label="attr.labelKey ? t(attr.labelKey) : attr.label" :label-width="160" size="small">
              <template #label>
                <n-space :size="4" align="center">
                  <span>{{ attr.labelKey ? t(attr.labelKey) : attr.label }}</span>
                  <n-tooltip>
                    <template #trigger>
                      <n-icon :size="14" style="cursor: help; color: #999;">
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
                          <path fill="currentColor" d="M11 17h2v-6h-2v6zm1-8q.425 0 .713-.288T13 8q0-.425-.288-.713T12 7q-.425 0-.713.288T11 8q0 .425.288.713T12 9zm0 13q-2.075 0-3.9-.788t-3.175-2.137q-1.35-1.35-2.137-3.175T2 12q0-2.075.788-3.9t2.137-3.175q1.35-1.35 3.175-2.137T12 2q2.075 0 3.9.788t3.175 2.137q1.35 1.35 2.138 3.175T22 12q0 2.075-.788 3.9t-2.137 3.175q-1.35 1.35-3.175 2.138T12 22z"/>
                        </svg>
                      </n-icon>
                    </template>
                    {{ attr.descriptionKey ? t(attr.descriptionKey) : attr.description }}
                  </n-tooltip>
                </n-space>
              </template>

              <n-switch
                v-if="attr.type === 'boolean'"
                v-model:value="localAttributes[attr.key] as boolean"
                size="small"
              />
              <n-input-number
                v-else
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
    </n-collapse>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NCollapse, NCollapseItem, NSpace, NFormItem, NInputNumber,
  NTooltip, NIcon, NInput, NText, NSwitch
} from 'naive-ui';
import { getAttributesByCategory, ATTRIBUTE_CATEGORIES } from '@/constants/modelAttributes';
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

type AttributeCategory = typeof ATTRIBUTE_CATEGORIES[number];

const categoryMeta: Record<AttributeCategory, { name: string; titleKey: string }> = {
  '服务限制': { name: 'limits', titleKey: 'models.servingParams' },
  '协议优化': { name: 'protocol', titleKey: 'models.protocolParams' },
  '成本参数': { name: 'cost', titleKey: 'models.costParams' },
};

const categories = computed(() => [...ATTRIBUTE_CATEGORIES]);
const attrsByCategory = (category: AttributeCategory) => getAttributesByCategory(category);

const isUpdatingFromProps = ref(false);

// 成本相关的属性键
const COST_KEYS: Array<keyof ModelAttributes> = [
  'input_cost_per_token',
  'output_cost_per_token',
  'input_cost_per_token_cache_hit'
];

function isValidNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value) && value >= 0;
}

function convertToMtoken(value: unknown): number | null {
  if (!isValidNumber(value)) return null;
  return Number((value * MILLION).toFixed(COST_PRECISION));
}

function convertToToken(value: unknown): number | null {
  if (!isValidNumber(value)) return null;
  return value / MILLION;
}

function headersToText(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
}

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

function cleanAttributeValue(key: keyof ModelAttributes, value: any): number | boolean | string | null {
  if (COST_KEYS.includes(key)) {
    return convertToToken(value);
  }
  return value as any;
}

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

function buildHeaders(parsedHeaders: Record<string, string>): Record<string, string> | undefined {
  if (headersText.value.trim() === '') {
    return undefined;
  }

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

watch(headersText, () => {
  emitValue();
});

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
