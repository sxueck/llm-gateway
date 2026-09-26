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
            tr("expertRouting.jevChoiceTitle", "Jev 候选专家选择")
          }}</span>
          <n-tooltip trigger="hover">
            <template #trigger>
              <n-icon size="16" class="info-icon"
                ><InformationCircleOutline
              /></n-icon>
            </template>
            {{
              tr(
                "expertRouting.jevChoiceTooltip",
                "Jev 直接在各候选专家之间做出选择，按选择概率降序取最优候选。",
              )
            }}
          </n-tooltip>
        </div>
      </template>

      <div class="stage-content">
        <n-text depth="3" class="stage-desc">
          {{
            tr(
              "expertRouting.jevChoiceDesc",
              "各候选专家的 category 作为稳定选择键，description 作为选择依据。Jev 按选择概率降序直接选出专家；低于置信度阈值时进入 fallback。",
            )
          }}
        </n-text>

        <n-divider style="margin: 12px 0" />

        <n-form-item :label="tr('expertRouting.choiceThreshold', '置信度阈值')" :show-feedback="false">
          <n-input-number
            :value="choiceThreshold ?? 0.6"
            :min="0"
            :max="1"
            :step="0.05"
            @update:value="(v: number | null) => emit('update:choiceThreshold', v ?? 0.6)"
          />
          <n-tooltip trigger="hover">
            <template #trigger>
              <n-icon
                size="16"
                class="info-icon"
                style="margin-left: 6px"
              >
                <InformationCircleOutline />
              </n-icon>
            </template>
            {{
              tr(
                "expertRouting.choiceThresholdHint",
                "最优候选的选择概率低于该阈值时，请求路由到 fallback。默认 0.6。",
              )
            }}
          </n-tooltip>
        </n-form-item>
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
  NInputNumber,
  NTooltip,
  NCheckbox,
} from "naive-ui";
import { InformationCircleOutline, ArrowDownOutline } from "@vicons/ionicons5";
import type {
  ExpertTarget,
  PreprocessingConfig,
} from "@/api/expert-routing";

const { t, te } = useI18n();

function tr(key: string, fallback: string) {
  return te(key) ? t(key) : fallback;
}

interface Props {
  choiceThreshold?: number;
  preprocessing: PreprocessingConfig;
  experts: ExpertTarget[];
}

const props = defineProps<Props>();
const emit = defineEmits([
  "update:choiceThreshold",
  "update:preprocessing",
]);
void props;
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
