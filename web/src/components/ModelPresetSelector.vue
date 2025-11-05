<template>
  <div class="model-preset-selector">
    <n-space vertical :size="12">
      <n-space :size="8" align="center">
        <n-input
          v-model:value="searchQuery"
          :placeholder="t('modelPresets.searchPlaceholder')"
          clearable
          size="small"
          style="flex: 1"
          @keyup.enter="handleSearch"
        >
          <template #prefix>
            <n-icon :component="SearchIcon" />
          </template>
        </n-input>
        <n-button type="primary" size="small" @click="handleSearch" :loading="searching">
          搜索
        </n-button>
        <n-button size="small" @click="handleUpdate" :loading="updating">
          更新预设库
        </n-button>
      </n-space>

      <n-alert v-if="stats" type="info" size="small" :bordered="false">
        <template #icon>
          <n-icon :component="InfoIcon" />
        </template>
        <div style="font-size: 13px;">{{ t('modelPresets.presetsInfo', [stats.totalModels, formatTime(stats.lastUpdate)]) }}</div>
      </n-alert>

      <div v-if="searchResults.length > 0" class="search-results">
        <n-scrollbar style="max-height: 400px">
          <n-list bordered size="small">
            <n-list-item
              v-for="result in searchResults"
              :key="result.modelName"
              class="result-item"
              @click="handleSelect(result)"
            >
              <template #prefix>
                <n-icon :component="ModelIcon" :size="18" />
              </template>
              <n-thing>
                <template #header>
                  <n-space :size="8" align="center">
                    <span class="model-name">{{ result.modelName }}</span>
                    <n-tag v-if="result.provider" size="small" type="info">
                      {{ result.provider }}
                    </n-tag>
                  </n-space>
                </template>
                <template #description>
                  <n-space :size="12" style="margin-top: 4px">
                    <span v-if="result.maxInputTokens" class="info-item">
                      输入: {{ formatNumber(result.maxInputTokens) }} tokens
                    </span>
                    <span v-if="result.maxOutputTokens" class="info-item">
                      输出: {{ formatNumber(result.maxOutputTokens) }} tokens
                    </span>
                    <span v-if="result.inputCost" class="info-item">
                      输入成本: ${{ result.inputCost.toExponential(2) }}/token
                    </span>
                    <span v-if="result.outputCost" class="info-item">
                      输出成本: ${{ result.outputCost.toExponential(2) }}/token
                    </span>
                  </n-space>
                  <n-space :size="8" style="margin-top: 4px">
                    <n-tag v-if="result.supportsFunctionCalling" size="tiny" type="success">
                      函数调用
                    </n-tag>
                    <n-tag v-if="result.supportsVision" size="tiny" type="success">
                      视觉
                    </n-tag>
                  </n-space>
                </template>
              </n-thing>
              <template #suffix>
                <n-button size="small" type="primary" @click.stop="handleSelect(result)">
                  选择
                </n-button>
              </template>
            </n-list-item>
          </n-list>
        </n-scrollbar>
      </div>

      <n-empty
        v-else-if="searched && searchResults.length === 0"
        description="未找到匹配的模型"
        size="small"
      />
    </n-space>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue';
import {
  NSpace,
  NInput,
  NButton,
  NAlert,
  NList,
  NListItem,
  NThing,
  NTag,
  NEmpty,
  NIcon,
  NScrollbar,
  useMessage,
} from 'naive-ui';
import { Search as SearchIcon, InformationCircle as InfoIcon, Cube as ModelIcon } from '@vicons/ionicons5';
import { modelPresetsApi, type ModelPresetSearchResult, type ModelPresetStats } from '@/api/model-presets';
import { useI18n } from 'vue-i18n';

const emit = defineEmits<{
  select: [result: ModelPresetSearchResult];
}>();

const { t } = useI18n();
const message = useMessage();
const searchQuery = ref('');
const searchResults = ref<ModelPresetSearchResult[]>([]);
const searching = ref(false);
const updating = ref(false);
const searched = ref(false);
const stats = ref<ModelPresetStats | null>(null);


async function loadStats() {
  try {
    stats.value = await modelPresetsApi.getStats();
  } catch (error: any) {
    console.error('加载统计信息失败:', error);
  }
}

async function handleSearch() {
  if (!searchQuery.value.trim()) {
    message.warning('请输入搜索关键词');
    return;
  }

  searching.value = true;
  searched.value = true;
  try {
    const response = await modelPresetsApi.searchModels(searchQuery.value, 20);
    searchResults.value = response.results;
    
    if (response.results.length === 0) {
      message.info('未找到匹配的模型');
    }
  } catch (error: any) {
    message.error(error.message || '搜索失败');
    searchResults.value = [];
  } finally {
    searching.value = false;
  }
}

async function handleUpdate() {
  updating.value = true;
  try {
    const result = await modelPresetsApi.updatePresets();
    if (result.success) {
      message.success(result.message);
      await loadStats();
    } else {
      message.error(result.message);
    }
  } catch (error: any) {
    message.error(error.message || '更新失败');
  } finally {
    updating.value = false;
  }
}

function handleSelect(result: ModelPresetSearchResult) {
  emit('select', result);
}

function formatTime(timestamp: number): string {
  if (!timestamp) return '未知';
  const date = new Date(timestamp);
  return date.toLocaleString('zh-CN');
}

function formatNumber(num: number): string {
  return num.toLocaleString();
}

onMounted(() => {
  loadStats();
});
</script>

<style scoped>
.model-preset-selector {
  padding: 4px;
}

.search-results {
  margin-top: 8px;
}

.result-item {
  cursor: pointer;
  transition: background-color 0.2s;
}

.result-item:hover {
  background-color: rgba(0, 0, 0, 0.02);
}

.model-name {
  font-weight: 500;
  font-size: 14px;
}

.info-item {
  font-size: 12px;
  color: #666;
}
</style>

