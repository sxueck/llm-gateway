<template>
  <div class="routing-pipeline">
    <!-- Layer 1: Request Preprocessing -->
    <n-card class="pipeline-stage" :bordered="false">
      <template #header>
        <div class="stage-header">
          <n-tag type="warning" round size="small">Layer 1</n-tag>
          <span class="stage-title">{{ tr('expertRouting.layer1PreprocessingTitle', '请求清洗 (Cleaning)') }}</span>
          <n-tooltip trigger="hover">
            <template #trigger>
              <n-icon size="16" class="info-icon"><InformationCircleOutline /></n-icon>
            </template>
            {{ tr('expertRouting.layer1PreprocessingTooltip', '清洗请求中的干扰信息，提高后续分类准确度') }}
          </n-tooltip>
        </div>
      </template>
      
      <div class="stage-content">
        <n-text depth="3" class="stage-desc">
          配置需要从请求中移除的内容，以获得更纯净的意图文本。
        </n-text>
        <n-divider style="margin: 12px 0" />
        <n-grid :cols="2" :y-gap="12" :x-gap="24">
          <n-gi>
             <n-checkbox v-model:checked="preprocessing.strip_tools">
               移除工具定义/调用 (Tools)
             </n-checkbox>
          </n-gi>
          <n-gi>
             <n-checkbox v-model:checked="preprocessing.strip_code_blocks">
               移除代码块 (Code Blocks)
             </n-checkbox>
          </n-gi>
          <n-gi>
             <n-checkbox v-model:checked="preprocessing.strip_files">
               移除文件/多媒体 (Files)
             </n-checkbox>
          </n-gi>
          <n-gi>
             <n-checkbox v-model:checked="preprocessing.strip_system_prompt">
               移除系统提示词 (System Prompt)
             </n-checkbox>
          </n-gi>
        </n-grid>
      </div>
    </n-card>

    <div class="pipeline-arrow">
      <n-icon size="24"><ArrowDownOutline /></n-icon>
    </div>

    <!-- Layer 2: Semantic Search -->
    <n-card class="pipeline-stage" :bordered="false">
      <template #header>
        <div class="stage-header">
          <n-tag type="success" round size="small">Layer 2</n-tag>
          <span class="stage-title">{{ t('expertRouting.layer1Title') }}</span>
          <n-tooltip trigger="hover">
            <template #trigger>
              <n-icon size="16" class="info-icon"><InformationCircleOutline /></n-icon>
            </template>
            {{ t('expertRouting.layer1Tooltip') }}
          </n-tooltip>
        </div>
      </template>
      
      <div class="stage-content">
        <n-text depth="3" class="stage-desc">
          {{ t('expertRouting.layer1Desc') }}
        </n-text>
        
        <n-divider style="margin: 12px 0" />
        
        <n-grid :cols="2" :x-gap="24">
          <n-gi>
            <n-form-item :label="t('expertRouting.threshold')" label-placement="left">
              <n-slider
                v-model:value="config.semantic.threshold"
                :min="0"
                :max="1"
                :step="0.05"
                style="width: 100%"
              />
              <span style="margin-left: 12px; width: 40px">{{ config.semantic.threshold }}</span>
            </n-form-item>
          </n-gi>
          <n-gi>
            <n-form-item :label="t('expertRouting.semanticModel')" label-placement="left">
              <n-select
                v-model:value="config.semantic.model"
                size="small"
                :options="[
                  { label: 'BGE Small ZH (推荐)', value: 'bge-small-zh-v1.5' },
                  { label: 'BGE M3 (中文更强)', value: 'bge-m3' },
                  { label: 'MiniLM L6 (英文)', value: 'all-MiniLM-L6-v2' }
                ]"
              />
            </n-form-item>
          </n-gi>
        </n-grid>
      </div>
    </n-card>

    <div class="pipeline-arrow">
      <n-icon size="24"><ArrowDownOutline /></n-icon>
      <span class="arrow-label">{{ t('expertRouting.ifNoMatch') }}</span>
    </div>

    <!-- Layer 3: LLM Judge -->
    <n-card class="pipeline-stage" :bordered="false">
      <template #header>
        <div class="stage-header">
          <n-tag type="info" round size="small">Layer 3</n-tag>
          <span class="stage-title">{{ t('expertRouting.layer2Title') }}</span>
        </div>
      </template>
      
      <div class="stage-content">
        <n-text depth="3" class="stage-desc">
          {{ t('expertRouting.layer2Desc') }}
        </n-text>
        
        <n-divider style="margin: 12px 0" />
        
        <ModelSelector
          v-model:type="classifier.type"
          v-model:model-id="classifier.model_id"
          v-model:provider-id="classifier.provider_id"
          v-model:model="classifier.model"
          :provider-options="providerOptions"
          :virtual-model-options="virtualModelOptions"
        />

        <n-collapse style="margin-top: 12px">
          <n-collapse-item :title="t('expertRouting.advancedLLMConfig')">
            <n-form-item :label="t('expertRouting.systemPrompt')">
              <n-input
                v-model:value="classifier.system_prompt"
                type="textarea"
                :rows="3"
                :placeholder="t('expertRouting.systemPromptPlaceholder')"
              />
            </n-form-item>
          </n-collapse-item>
        </n-collapse>
      </div>
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import {
  NCard, NTag, NIcon, NText, NDivider, NGrid, NGi, NFormItem, 
  NSlider, NSelect, NTooltip, NCollapse, NCollapseItem, NInput,
  NCheckbox
} from 'naive-ui';
import { InformationCircleOutline, ArrowDownOutline } from '@vicons/ionicons5';
import ModelSelector from './ModelSelector.vue';
import type { ExpertRoutingConfig, ExpertTarget } from '@/api/expert-routing';

const { t, te } = useI18n();

function tr(key: string, fallback: string) {
  return te(key) ? t(key) : fallback;
}

interface Props {
  // Editor guarantees these are present; keep types strict for template usage.
  config: NonNullable<ExpertRoutingConfig['routing']> & {
    semantic: NonNullable<NonNullable<ExpertRoutingConfig['routing']>['semantic']>;
  };
  classifier: ExpertRoutingConfig['classifier'];
  preprocessing: NonNullable<ExpertRoutingConfig['preprocessing']>;
  experts: ExpertTarget[];
  providerOptions: any[];
  virtualModelOptions: any[];
}

const props = defineProps<Props>();
defineEmits(['update:config', 'update:classifier', 'update:preprocessing']);

// Normalize nested objects for safety (and to satisfy template bindings).
if (!props.config.semantic) {
  props.config.semantic = {
    model: 'bge-small-zh-v1.5',
    threshold: 0.6,
    margin: 0.1,
    routes: [],
  };
}

</script>

<style scoped>
.routing-pipeline {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
  max-width: 800px;
  margin: 0 auto;
}

.pipeline-stage {
  width: 100%;
  border: 1px solid rgba(239, 239, 245, 1);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.04);
  transition: all 0.3s;
}

.pipeline-stage:hover {
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  border-color: var(--primary-color-hover);
}

.stage-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.stage-title {
  font-weight: 600;
  font-size: 15px;
}

.info-icon {
  color: var(--n-text-color-3);
  cursor: help;
}

.pipeline-arrow {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 12px 0;
  color: var(--n-text-color-3);
}

.arrow-label {
  font-size: 12px;
  margin-top: 4px;
}
</style>
