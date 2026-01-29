<template>
  <div class="routing-pipeline">
    <!-- Layer 1: Request Preprocessing -->
    <n-card class="pipeline-stage" :bordered="false">
      <template #header>
        <div class="stage-header">
          <n-tag type="warning" round size="small">Step 1</n-tag>
          <span class="stage-title">{{ tr('expertRouting.preprocessingTitle', '请求清洗 (Cleaning)') }}</span>
          <n-tooltip trigger="hover">
            <template #trigger>
              <n-icon size="16" class="info-icon"><InformationCircleOutline /></n-icon>
            </template>
            {{ tr('expertRouting.preprocessingTooltip', '清洗请求中的干扰信息，提高分类准确度') }}
          </n-tooltip>
        </div>
      </template>
      
      <div class="stage-content">
        <n-text depth="3" class="stage-desc">
          配置需要清理/缩减的内容，以获得更纯净的意图文本。
        </n-text>
        <n-divider style="margin: 12px 0" />
        <n-grid :cols="2" :y-gap="12" :x-gap="24">
           <n-gi>
              <n-checkbox v-model:checked="preprocessing.strip_tools">
                缩减工具上下文 (Tools)
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

    <!-- Step 2: LLM Judge -->
    <n-card class="pipeline-stage" :bordered="false">
      <template #header>
        <div class="stage-header">
          <n-tag type="info" round size="small">Step 2</n-tag>
          <span class="stage-title">{{ tr('expertRouting.classificationTitle', '智能分类 (LLM)') }}</span>
          <n-tooltip trigger="hover">
            <template #trigger>
              <n-icon size="16" class="info-icon"><InformationCircleOutline /></n-icon>
            </template>
            {{ tr('expertRouting.classificationTooltip', '使用大模型智能识别用户意图并分类') }}
          </n-tooltip>
        </div>
      </template>
      
      <div class="stage-content">
        <n-text depth="3" class="stage-desc">
          {{ tr('expertRouting.classificationDesc', '配置分类器模型和提示词，以实现精准分类。') }}
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
  NTooltip, NCollapse, NCollapseItem, NInput,
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
  classifier: ExpertRoutingConfig['classifier'];
  preprocessing: NonNullable<ExpertRoutingConfig['preprocessing']>;
  experts: ExpertTarget[];
  providerOptions: any[];
  virtualModelOptions: any[];
}

const props = defineProps<Props>();
defineEmits(['update:classifier', 'update:preprocessing']);

// Ensure preprocessing config exists
if (!props.preprocessing) {
  props.preprocessing = {
    strip_tools: false,
    strip_code_blocks: false,
    strip_files: false,
    strip_system_prompt: false,
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
