<template>
  <div class="cost-analysis-container">
    <div class="page-header">
      <div class="page-title">
        <h1>{{ t('costAnalysis.title') }}</h1>
        <div class="subtitle">{{ t('costAnalysis.subtitle') }}</div>
      </div>
      <div class="page-actions">
        <n-button v-if="activeTab === 'mappings'" type="primary" @click="showAddModal">
          <template #icon>
            <n-icon><AddOutline /></n-icon>
          </template>
          {{ t('costAnalysis.addMapping') }}
        </n-button>
      </div>
    </div>

    <div class="main-content">
      <n-tabs type="line" v-model:value="activeTab">
        <n-tab-pane name="mappings" :tab="t('costAnalysis.tabs.mappings')">
          <!-- Search Bar -->
          <div class="search-bar">
            <n-input
              v-model:value="searchQuery"
              :placeholder="t('costAnalysis.searchPlaceholder')"
              clearable
            >
              <template #prefix>
                <n-icon><SearchOutline /></n-icon>
              </template>
            </n-input>
          </div>

          <!-- Mapping List -->
          <n-data-table
            :columns="columns"
            :data="filteredMappings"
            :loading="loading"
            :pagination="pagination"
            :max-height="400"
          />

          <!-- Test Section -->
          <n-card :title="t('costAnalysis.testMapping')" class="test-section">
            <n-space vertical>
              <n-input-group>
                <n-input
                  v-model:value="testModelName"
                  :placeholder="t('costAnalysis.testModelPlaceholder')"
                />
                <n-button type="primary" @click="testMapping" :loading="testing">
                  {{ t('common.test') }}
                </n-button>
              </n-input-group>

              <div v-if="testResult" class="test-result">
                <n-alert :type="testResult.source === 'direct' || testResult.source === 'mapping' ? 'success' : 'warning'">
                  <template #header>
                    {{ t('costAnalysis.matchSuccess') }}
                  </template>
                  <div class="result-details">
                    <div v-if="testResult.source === 'direct'">
                      {{ t('costAnalysis.directMatch') }}
                    </div>
                    <div v-else-if="testResult.source === 'mapping'">
                      {{ t('costAnalysis.mappingMatch', { pattern: testResult.mapping_pattern }) }}
                    </div>
                    
                    <div class="cost-info">
                      <strong>{{ t('costAnalysis.targetInfo', { model: testResult.model || testResult.target_model }) }}</strong>
                      <br />
                      {{ t('costAnalysis.costInfo', {
                        input: testResult.info.input_cost_per_token * 1000000,
                        output: testResult.info.output_cost_per_token * 1000000
                      }) }}
                    </div>
                  </div>
                </n-alert>
              </div>
              <div v-else-if="testResultError">
                 <n-alert type="error">
                  {{ t('costAnalysis.matchFail') }}
                </n-alert>
              </div>
            </n-space>
          </n-card>
        </n-tab-pane>

        <n-tab-pane name="prices" :tab="t('costAnalysis.tabs.prices')">
          <!-- Search Bar for Prices -->
          <div class="search-bar">
            <n-input
              v-model:value="pricesSearchQuery"
              :placeholder="t('modelPresets.searchPlaceholder')"
              clearable
            >
              <template #prefix>
                <n-icon><SearchOutline /></n-icon>
              </template>
            </n-input>
          </div>

          <n-data-table
            :columns="priceColumns"
            :data="filteredPrices"
            :loading="pricesLoading"
            :pagination="pagination"
            :max-height="800"
          />
        </n-tab-pane>
      </n-tabs>
    </div>

    <!-- Create/Edit Modal -->
    <n-modal v-model:show="showModal" preset="card" :title="editingId ? t('costAnalysis.editMapping') : t('costAnalysis.addMapping')" style="width: 600px">
      <n-form ref="formRef" :model="formModel" :rules="rules">
        <n-form-item :label="t('costAnalysis.pattern')" path="pattern">
          <n-input v-model:value="formModel.pattern" :placeholder="t('costAnalysis.patternPlaceholder')" />
          <template #feedback>
            {{ t('costAnalysis.patternHint') }}
          </template>
        </n-form-item>
        
        <n-form-item :label="t('costAnalysis.targetModel')" path="target_model">
          <model-preset-selector
            @select="handleModelSelect"
          />
          <template #feedback v-if="formModel.target_model">
            已选择: {{ formModel.target_model }}
          </template>
        </n-form-item>
        
        <n-form-item :label="t('costAnalysis.priority')" path="priority">
          <n-input-number v-model:value="formModel.priority" />
          <template #feedback>
            {{ t('costAnalysis.priorityHint') }}
          </template>
        </n-form-item>
        
        <n-form-item :label="t('costAnalysis.enabled')" path="enabled">
          <n-switch v-model:value="formModel.enabled" />
        </n-form-item>
      </n-form>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showModal = false">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" @click="handleSave" :loading="saving">{{ t('common.save') }}</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, h, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useMessage } from 'naive-ui';
import {
  AddOutline,
  SearchOutline, 
  CreateOutline, 
  TrashOutline 
} from '@vicons/ionicons5';
import { 
  NButton, 
  NIcon,
  NTag,
  NSpace,
  NPopconfirm,
  NForm,
  NFormItem,
  NInput,
  NInputGroup,
  NInputNumber,
  NSwitch,
  NModal,
  NDataTable,
  NCard,
  NAlert,
  NTabs,
  NTabPane
} from 'naive-ui';
import { costMappingApi, CostMapping, CostResolution, ModelPrice } from '@/api/cost-mapping';
import ModelPresetSelector from '@/components/ModelPresetSelector.vue';

const { t } = useI18n();
const message = useMessage();

// State
const activeTab = ref('mappings');
const mappings = ref<CostMapping[]>([]);
const loading = ref(false);
const searchQuery = ref('');
const showModal = ref(false);
const saving = ref(false);
const editingId = ref<string | null>(null);
const formRef = ref<any>(null);

const prices = ref<ModelPrice[]>([]);
const pricesLoading = ref(false);
const pricesSearchQuery = ref('');

const formModel = ref({
  pattern: '',
  target_model: '',
  priority: 0,
  enabled: true
});

const testModelName = ref('');
const testing = ref(false);
const testResult = ref<CostResolution | null>(null);
const testResultError = ref(false);

// Rules
const rules = {
  pattern: { required: true, message: t('validation.required'), trigger: 'blur' },
  target_model: { required: true, message: t('validation.required'), trigger: 'blur' }
};

// Pagination
const pagination = {
  pageSize: 10
};

// Computed
const filteredMappings = computed(() => {
  if (!searchQuery.value) return mappings.value;
  const query = searchQuery.value.toLowerCase();
  return mappings.value.filter(m =>
    m.pattern.toLowerCase().includes(query) ||
    m.target_model.toLowerCase().includes(query)
  );
});

const filteredPrices = computed(() => {
  if (!pricesSearchQuery.value) return prices.value;
  const query = pricesSearchQuery.value.toLowerCase();
  return prices.value.filter(p =>
    p.model.toLowerCase().includes(query) ||
    (p.provider && p.provider.toLowerCase().includes(query))
  );
});

const columns = [
  {
    title: t('costAnalysis.pattern'),
    key: 'pattern',
    render(row: CostMapping) {
      return h('code', null, row.pattern);
    }
  },
  {
    title: t('costAnalysis.targetModel'),
    key: 'target_model'
  },
  {
    title: t('costAnalysis.priority'),
    key: 'priority',
    sorter: (a: CostMapping, b: CostMapping) => a.priority - b.priority
  },
  {
    title: t('costAnalysis.enabled'),
    key: 'enabled',
    render(row: CostMapping) {
      return h(
        NTag,
        {
          type: row.enabled ? 'success' : 'error',
          bordered: false
        },
        {
          default: () => row.enabled ? t('common.enabled') : t('common.disabled')
        }
      );
    }
  },
  {
    title: t('common.actions'),
    key: 'actions',
    render(row: CostMapping) {
      return h(NSpace, null, {
        default: () => [
          h(
            NButton,
            {
              size: 'small',
              onClick: () => handleEdit(row)
            },
            {
              icon: () => h(NIcon, null, { default: () => h(CreateOutline) })
            }
          ),
          h(
            NPopconfirm,
            {
              onPositiveClick: () => handleDelete(row)
            },
            {
              trigger: () => h(
                NButton,
                {
                  size: 'small',
                  type: 'error',
                  quaternary: true
                },
                {
                  icon: () => h(NIcon, null, { default: () => h(TrashOutline) })
                }
              ),
              default: () => t('costAnalysis.deleteConfirm')
            }
          )
        ]
      });
    }
  }
];

const priceColumns = [
  {
    title: t('costAnalysis.prices.model'),
    key: 'model',
    sorter: (a: ModelPrice, b: ModelPrice) => a.model.localeCompare(b.model)
  },
  {
    title: t('costAnalysis.prices.provider'),
    key: 'provider',
    sorter: (a: ModelPrice, b: ModelPrice) => (a.provider || '').localeCompare(b.provider || '')
  },
  {
    title: t('costAnalysis.prices.inputCost'),
    key: 'input_cost_per_token',
    render(row: ModelPrice) {
      const val = row.input_cost_per_token;
      return val ? `$${(val * 1000000).toFixed(4)}` : '-';
    },
    sorter: (a: ModelPrice, b: ModelPrice) => (a.input_cost_per_token || 0) - (b.input_cost_per_token || 0)
  },
  {
    title: t('costAnalysis.prices.outputCost'),
    key: 'output_cost_per_token',
    render(row: ModelPrice) {
      const val = row.output_cost_per_token;
      return val ? `$${(val * 1000000).toFixed(4)}` : '-';
    },
    sorter: (a: ModelPrice, b: ModelPrice) => (a.output_cost_per_token || 0) - (b.output_cost_per_token || 0)
  },
  {
    title: t('costAnalysis.prices.contextWindow'),
    key: 'max_tokens',
    render(row: ModelPrice) {
      return row.max_tokens?.toLocaleString() || '-';
    },
    sorter: (a: ModelPrice, b: ModelPrice) => (a.max_tokens || 0) - (b.max_tokens || 0)
  },
];

// Methods
async function fetchPrices() {
  if (prices.value.length > 0) return;
  pricesLoading.value = true;
  try {
    prices.value = await costMappingApi.getPrices();
  } catch (error) {
    message.error(t('messages.loadFailed'));
  } finally {
    pricesLoading.value = false;
  }
}

watch(activeTab, (val) => {
  if (val === 'prices') {
    fetchPrices();
  }
});

async function fetchMappings() {
  loading.value = true;
  try {
    mappings.value = await costMappingApi.getAll();
  } catch (error) {
    message.error(t('messages.loadFailed'));
  } finally {
    loading.value = false;
  }
}

function showAddModal() {
  editingId.value = null;
  formModel.value = {
    pattern: '',
    target_model: '',
    priority: 0,
    enabled: true
  };
  showModal.value = true;
}

function handleEdit(row: CostMapping) {
  editingId.value = row.id;
  formModel.value = {
    pattern: row.pattern,
    target_model: row.target_model,
    priority: row.priority,
    enabled: !!row.enabled
  };
  showModal.value = true;
}

function handleModelSelect(result: any) {
  formModel.value.target_model = result.modelName;
}

function notifyCostMappingUpdated() {
  try {
    // Broadcast an event so the dashboard can refresh its cost statistics in real time
    window.dispatchEvent(new CustomEvent('cost-mapping-updated'));
  } catch (e) {
    // Ignore errors in non-browser environments
  }
}
 
async function handleSave() {
  try {
    await formRef.value?.validate();
    saving.value = true;
    try {
      if (editingId.value) {
        await costMappingApi.update(editingId.value, formModel.value);
        message.success(t('costAnalysis.updateSuccess'));
      } else {
        await costMappingApi.create(formModel.value);
        message.success(t('costAnalysis.createSuccess'));
      }
      showModal.value = false;
      fetchMappings();
      notifyCostMappingUpdated();
    } catch (error) {
      message.error(t('common.operationFailed'));
    } finally {
      saving.value = false;
    }
  } catch (validationError) {
    // 验证失败，不执行保存操作
  }
}
 
async function handleDelete(row: CostMapping) {
  try {
    await costMappingApi.delete(row.id);
    message.success(t('costAnalysis.deleteSuccess'));
    fetchMappings();
    notifyCostMappingUpdated();
  } catch (error) {
    message.error(t('common.operationFailed'));
  }
}
 
async function testMapping() {
  if (!testModelName.value) return;
  testing.value = true;
  testResult.value = null;
  testResultError.value = false;
  try {
    testResult.value = await costMappingApi.resolve(testModelName.value);
  } catch (error) {
    testResultError.value = true;
  } finally {
    testing.value = false;
  }
}

onMounted(() => {
  fetchMappings();
});
</script>

<style scoped>
.cost-analysis-container {
  max-width: 1200px;
  margin: 0 auto;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.page-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
  flex-shrink: 0;
}

.page-title h1 {
  margin: 0;
  font-size: 24px;
  font-weight: 600;
  color: #1a1a1a;
}

.subtitle {
  color: #666;
  margin-top: 4px;
}

.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.main-content :deep(.n-tabs) {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.main-content :deep(.n-tabs-pane-wrapper) {
  flex: 1;
  overflow: hidden;
}

.main-content :deep(.n-tab-pane) {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.search-bar {
  margin-bottom: 16px;
  max-width: 400px;
  flex-shrink: 0;
}

.main-content :deep(.n-data-table) {
  flex: 1;
}

.test-section {
  margin-top: 24px;
  flex-shrink: 0;
}

.test-result {
  margin-top: 16px;
}

.cost-info {
  margin-top: 8px;
  color: #666;
}
</style>