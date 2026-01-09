<template>
  <div class="preset-selector">
    <n-space vertical :size="12">
      <n-space justify="space-between" align="center">
        <h4 class="section-title">选择提供商预设</h4>
        <n-select
          v-model:value="selectedCategory"
          :options="categoryOptions"
          placeholder="筛选分类"
          style="width: 160px"
          size="small"
          clearable
        />
      </n-space>

      <div class="providers-table">
        <div class="table-header">
          <div class="col-name">提供商名称</div>
          <div class="col-category">分类</div>
          <div class="col-url">API 地址</div>
          <div class="col-features">支持功能</div>
          <div class="col-select">选择</div>
        </div>

        <div class="providers-list">
          <div
            v-for="provider in paginatedProviders"
            :key="provider.id"
            :class="['provider-row', { selected: selectedProvider?.id === provider.id }]"
            @click="selectProvider(provider)"
          >
            <div class="col-name">
              <span class="provider-name">{{ provider.name }}</span>
              <n-tooltip v-if="provider.description" placement="top">
                <template #trigger>
                  <n-icon size="14" class="info-icon">
                    <InformationCircleOutline />
                  </n-icon>
                </template>
                {{ provider.description }}
              </n-tooltip>
            </div>

            <div class="col-category">
              <n-tag size="tiny" type="info" :bordered="false" class="category-tag">
                {{ provider.category }}
              </n-tag>
            </div>

            <div class="col-url">
              <n-ellipsis style="max-width: 100%">
                <n-text code style="font-size: 11px">{{ provider.baseUrl }}</n-text>
              </n-ellipsis>
            </div>

            <div class="col-features">
              <n-space :size="4">
                <n-tooltip v-if="provider.features.chat" placement="top">
                  <template #trigger>
                    <n-icon size="16" color="#18a058" class="feature-icon">
                      <ChatbubbleEllipsesOutline />
                    </n-icon>
                  </template>
                  对话
                </n-tooltip>
                <n-tooltip v-if="provider.features.vision" placement="top">
                  <template #trigger>
                    <n-icon size="16" color="#18a058" class="feature-icon">
                      <EyeOutline />
                    </n-icon>
                  </template>
                  视觉
                </n-tooltip>
                <n-tooltip v-if="provider.features.tools" placement="top">
                  <template #trigger>
                    <n-icon size="16" color="#18a058" class="feature-icon">
                      <ConstructOutline />
                    </n-icon>
                  </template>
                  工具
                </n-tooltip>
                <n-tooltip v-if="provider.features.embeddings" placement="top">
                  <template #trigger>
                    <n-icon size="16" color="#18a058" class="feature-icon">
                      <GridOutline />
                    </n-icon>
                  </template>
                  嵌入
                </n-tooltip>
                <n-tooltip v-if="provider.features.images" placement="top">
                  <template #trigger>
                    <n-icon size="16" color="#18a058" class="feature-icon">
                      <ImageOutline />
                    </n-icon>
                  </template>
                  图像
                </n-tooltip>
                <n-tooltip v-if="provider.features.audio" placement="top">
                  <template #trigger>
                    <n-icon size="16" color="#18a058" class="feature-icon">
                      <VolumeHighOutline />
                    </n-icon>
                  </template>
                  音频
                </n-tooltip>
              </n-space>
            </div>

            <div class="col-select">
              <n-radio
                :checked="selectedProvider?.id === provider.id"
                @click.stop="selectProvider(provider)"
              />
            </div>
          </div>
        </div>
      </div>

      <n-space v-if="filteredProviders.length === 0" justify="center">
        <n-empty description="没有找到匹配的提供商" size="small" />
      </n-space>

      <n-space v-if="filteredProviders.length > pageSize" justify="center" style="margin-top: 8px">
        <n-pagination
          v-model:page="currentPage"
          :page-count="pageCount"
          :page-size="pageSize"
          size="small"
          show-size-picker
          :page-sizes="[10, 15, 20, 30]"
          @update:page-size="handlePageSizeChange"
        />
      </n-space>
    </n-space>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import {
  NSpace,
  NSelect,
  NText,
  NTag,
  NRadio,
  NEmpty,
  NPagination,
  NTooltip,
  NIcon,
  NEllipsis,
} from 'naive-ui';
import {
  InformationCircleOutline,
  ChatbubbleEllipsesOutline,
  EyeOutline,
  ConstructOutline,
  GridOutline,
  ImageOutline,
  VolumeHighOutline,
} from '@vicons/ionicons5';
import { PROVIDER_PRESETS, PROVIDER_CATEGORIES, type ProviderPreset } from '@/constants/providers';

interface Props {
  modelValue?: ProviderPreset | null;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  'update:modelValue': [value: ProviderPreset | null];
}>();

const selectedCategory = ref<string | null>(null);
const currentPage = ref(1);
const pageSize = ref(15);

const selectedProvider = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value || null),
});

const categoryOptions = computed(() => {
  return PROVIDER_CATEGORIES.map(category => ({
    label: category,
    value: category,
  }));
});

const filteredProviders = computed(() => {
  if (!selectedCategory.value) {
    return PROVIDER_PRESETS;
  }
  return PROVIDER_PRESETS.filter(provider => provider.category === selectedCategory.value);
});

const pageCount = computed(() => {
  return Math.ceil(filteredProviders.value.length / pageSize.value);
});

const paginatedProviders = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value;
  const end = start + pageSize.value;
  return filteredProviders.value.slice(start, end);
});

function selectProvider(provider: ProviderPreset) {
  selectedProvider.value = provider;
}

function handlePageSizeChange(newPageSize: number) {
  pageSize.value = newPageSize;
  currentPage.value = 1;
}
</script>

<style scoped>
.preset-selector {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: #262626;
  margin: 0;
}

.providers-table {
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(0, 0, 0, 0.06);
  border-radius: 8px;
  overflow: hidden;
  background: #ffffff;
}

.table-header {
  display: grid;
  grid-template-columns: 2fr 1.2fr 3fr 1.8fr 60px;
  gap: 16px;
  padding: 10px 16px;
  background: #f8f9fa;
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
  font-size: 12px;
  font-weight: 600;
  color: #595959;
}

.providers-list {
  max-height: calc(50vh - 250px);
  overflow-y: auto;
}

.providers-list::-webkit-scrollbar {
  width: 6px;
}

.providers-list::-webkit-scrollbar-track {
  background: #f0f0f0;
  border-radius: 3px;
}

.providers-list::-webkit-scrollbar-thumb {
  background: #d0d0d0;
  border-radius: 3px;
}

.providers-list::-webkit-scrollbar-thumb:hover {
  background: #b0b0b0;
}

.provider-row {
  display: grid;
  grid-template-columns: 2fr 1.2fr 3fr 1.8fr 60px;
  gap: 16px;
  padding: 12px 16px;
  border-bottom: 1px solid #e8e8e8;
  cursor: pointer;
  transition: background-color 0.2s ease;
  align-items: center;
}

.provider-row:last-child {
  border-bottom: none;
}

.provider-row:hover {
  background: #f8f9fa;
}

.provider-row.selected {
  background: rgba(24, 160, 88, 0.08);
  border-left: 3px solid #18a058;
  padding-left: 13px;
  font-weight: 500;
}

.provider-row.selected .provider-name {
  color: #18a058;
}

.col-name {
  display: flex;
  align-items: center;
  gap: 6px;
}

.provider-name {
  font-size: 13px;
  font-weight: 600;
  color: #262626;
}

.info-icon {
  color: #8c8c8c;
  cursor: help;
  flex-shrink: 0;
}

.col-category {
  display: flex;
  align-items: center;
}

.category-tag {
  font-size: 11px;
  padding: 2px 8px;
}

.col-url {
  display: flex;
  align-items: center;
  min-width: 0;
}

.col-features {
  display: flex;
  align-items: center;
}

.feature-icon {
  cursor: help;
  flex-shrink: 0;
}

.col-select {
  display: flex;
  align-items: center;
  justify-content: center;
}

.table-header .col-select {
  font-size: 11px;
  text-align: center;
}

@media (max-width: 1200px) {
  .table-header,
  .provider-row {
    grid-template-columns: 1.5fr 1fr 2.5fr 1.5fr 60px;
    gap: 12px;
  }
}

@media (max-width: 900px) {
  .table-header,
  .provider-row {
    grid-template-columns: 2fr 1fr 2fr 1fr 60px;
    gap: 10px;
  }

  .col-url {
    font-size: 11px;
  }
}
</style>
