<template>
  <div class="routing-pipeline">
    <n-card class="pipeline-stage" :bordered="false">
      <template #header>
        <div class="stage-header">
          <n-tag type="warning" round size="small">Step 1</n-tag>
          <span class="stage-title">{{
            tr("expertRouting.preprocessingTitle", "请求清洗 (Cleaning)")
          }}</span>
          <n-tooltip trigger="hover">
            <template #trigger>
              <n-icon size="16" class="info-icon"
                ><InformationCircleOutline
              /></n-icon>
            </template>
            {{
              tr(
                "expertRouting.preprocessingTooltip",
                "清洗请求中的干扰信息，提高分类准确度",
              )
            }}
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

    <n-card class="pipeline-stage" :bordered="false">
      <template #header>
        <div class="stage-header">
          <n-tag type="info" round size="small">Step 2</n-tag>
          <span class="stage-title">{{
            tr(
              "expertRouting.localClassifierTitle",
              "外置 Intent Router API (主分类)",
            )
          }}</span>
          <n-tooltip trigger="hover">
            <template #trigger>
              <n-icon size="16" class="info-icon"
                ><InformationCircleOutline
              /></n-icon>
            </template>
            {{
              tr(
                "expertRouting.localClassifierTooltip",
                "由部署环境配置的 Intent Router API 执行主分类。",
              )
            }}
          </n-tooltip>
        </div>
      </template>

      <div class="stage-content">
        <n-text depth="3" class="stage-desc">
          {{
            tr(
              "expertRouting.localClassifierDesc",
              "主分类由外置 Intent Router API 完成。被拒判、ops、out_of_scope 或服务不可用时，将进入下方 LLM 二次分类。",
            )
          }}
        </n-text>
      </div>
    </n-card>

    <div class="pipeline-arrow">
      <n-icon size="24"><ArrowDownOutline /></n-icon>
    </div>

    <n-card class="pipeline-stage" :bordered="false">
      <template #header>
        <div class="stage-header">
          <n-tag type="success" round size="small">Step 3</n-tag>
          <span class="stage-title">{{
            tr("expertRouting.llmSecondPassTitle", "LLM 二次分类 (Second Pass)")
          }}</span>
          <n-tooltip trigger="hover">
            <template #trigger>
              <n-icon size="16" class="info-icon"
                ><InformationCircleOutline
              /></n-icon>
            </template>
            {{
              tr(
                "expertRouting.classificationTooltip",
                "当本地分类被拒判、返回不支持的 ops/out_of_scope 标签或缺少专家映射时调用",
              )
            }}
          </n-tooltip>
        </div>
      </template>

      <div class="stage-content">
        <n-text depth="3" class="stage-desc">
          {{
            tr(
              "expertRouting.classificationDesc",
              "配置二次分类器模型和提示词，以处理本地分类无法决策的请求。",
            )
          }}
        </n-text>

        <n-divider style="margin: 12px 0" />

        <ModelSelector
          v-model:type="llmSecondPass.type"
          v-model:model-id="llmSecondPass.model_id"
          v-model:provider-id="llmSecondPass.provider_id"
          v-model:model="llmSecondPass.model"
          :provider-options="providerOptions"
          :virtual-model-options="virtualModelOptions"
        />

        <n-form-item style="margin-top: 12px; margin-bottom: 0">
          <n-checkbox v-model:checked="llmSecondPass.enable_adaptive_thinking">
            {{ t("expertRouting.enableAdaptiveThinking") }}
          </n-checkbox>
          <n-tooltip trigger="hover">
            <template #trigger>
              <n-icon
                size="16"
                class="info-icon"
                style="margin-left: 6px; vertical-align: middle"
              >
                <InformationCircleOutline />
              </n-icon>
            </template>
            {{ t("expertRouting.enableAdaptiveThinkingHint") }}
          </n-tooltip>
        </n-form-item>

        <n-alert type="info" :show-icon="false" style="margin-top: 12px">
          {{ t("expertRouting.stableLabelPromptHint") }}
        </n-alert>
      </div>
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import {
  NCard,
  NTag,
  NIcon,
  NText,
  NDivider,
  NGrid,
  NGi,
  NFormItem,
  NTooltip,
  NAlert,
  NCheckbox,
} from "naive-ui";
import { InformationCircleOutline, ArrowDownOutline } from "@vicons/ionicons5";
import ModelSelector from "./ModelSelector.vue";
import type {
  ExpertTarget,
  LlmSecondPassConfig,
  PreprocessingConfig,
} from "@/api/expert-routing";

const { t, te } = useI18n();

function tr(key: string, fallback: string) {
  return te(key) ? t(key) : fallback;
}

interface Props {
  llmSecondPass: LlmSecondPassConfig;
  preprocessing: PreprocessingConfig;
  experts: ExpertTarget[];
  providerOptions: any[];
  virtualModelOptions: any[];
}

defineProps<Props>();
defineEmits(["update:llmSecondPass", "update:preprocessing"]);
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
