<template>
  <div class="template-selector">
    <div class="section-header">
      <h3>{{ t('expertRouting.selectTemplateTitle') }}</h3>
      <p class="section-desc">{{ t('expertRouting.selectTemplateDesc') }}</p>
    </div>

    <n-spin :show="loading">
      <div class="templates-grid">
      <div 
        class="template-card custom-card"
        @click="handleSelect('custom')"
      >
        <div class="card-icon custom-icon">
          <n-icon size="28"><AddOutline /></n-icon>
        </div>
        <div class="card-content">
          <div class="card-title">{{ t('expertRouting.customTemplate') }}</div>
          <div class="card-desc">{{ t('expertRouting.customTemplateDesc') }}</div>
        </div>
      </div>

      <div
        v-for="tpl in templates"
        :key="tpl.value"
        class="template-card preset-card"
        :style="{ '--accent-color': getTemplateColor(tpl.value) }"
        @click="handleSelect(tpl.value)"
      >
        <div class="card-accent-bar" />
        <div class="card-body">
          <div class="card-content">
            <div class="card-header-row">
              <div class="card-title">{{ tpl.label }}</div>
              <n-tag v-if="tpl.utterances.length" size="small" :bordered="false" round class="template-tag">
                {{ tpl.utterances.length }} {{ t('expertRouting.examples') }}
              </n-tag>
            </div>

            <div class="card-desc" :title="tpl.description">{{ tpl.description }}</div>

            <div v-if="tpl.utterances.length" class="examples-preview">
              <div class="examples-list">
                <div v-for="(ex, idx) in tpl.utterances.slice(0, 2)" :key="idx" class="example-item">
                  {{ ex }}
                </div>
                <div v-if="tpl.utterances.length > 2" class="example-more">
                  +{{ tpl.utterances.length - 2 }} more
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      </div>

      <n-empty v-if="!loading && templates.length === 0" :show-icon="false" style="padding: 20px 0" />
    </n-spin>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { NIcon, NTag, NSpin, NEmpty, useMessage } from 'naive-ui';
import { AddOutline } from '@vicons/ionicons5';
import { expertRoutingApi, type ExpertTemplate } from '@/api/expert-routing';

const { t } = useI18n();
const message = useMessage();

const emit = defineEmits<{
  select: [template: ExpertTemplate | null];
}>();

const templates = ref<ExpertTemplate[]>([]);
const loading = ref(false);

onMounted(async () => {
  loading.value = true;
  try {
    const result = await expertRoutingApi.getTemplates();
    templates.value = result.templates || [];
  } catch (err: any) {
    templates.value = [];
    message.error(err?.message || t('messages.operationFailed'));
  } finally {
    loading.value = false;
  }
});

function getTemplateColor(type: string) {
  switch (type) {
    case 'code_authoring': return '#18a058';
    case 'code_modification': return '#8a2be2';
    case 'code_repair': return '#d03050';
    case 'code_review': return '#f5222d';
    case 'code_explanation': return '#2080f0';
    case 'test_generation': return '#10b981';
    case 'code_search': return '#0ea5e9';
    case 'architecture_consultation': return '#f0a020';
    case 'dependency_management': return '#707070';
    case 'context_specification': return '#7c3aed';
    case 'workflow_control': return '#0891b2';
    case 'general_inquiry': return '#64748b';
    default: return '#888888';
  }
}

function handleSelect(type: string) {
  if (type === 'custom') {
    emit('select', null);
  } else {
    const tpl = templates.value.find(t => t.value === type);
    emit('select', tpl || null);
  }
}
</script>

<style scoped>
.template-selector {
  padding: 16px 20px;
  padding-bottom: 32px;
}

.section-header {
  margin-bottom: 20px;
  text-align: center;
}

.section-header h3 {
  margin: 0 0 6px 0;
  font-size: 1.2rem;
  font-weight: 600;
  color: var(--n-text-color);
}

.section-desc {
  margin: 0;
  color: var(--n-text-color-3);
  font-size: 0.85rem;
}

.templates-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 16px;
}

.template-card {
  position: relative;
  border-radius: 10px;
  background-color: var(--n-card-color, #fff);
  border: 1px solid var(--n-border-color, #efeff5);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
  min-height: 160px;
  display: flex;
  flex-direction: column;
}

.template-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.06);
  border-color: var(--accent-color, var(--n-primary-color));
}

/* Accent bar at top of preset cards */
.card-accent-bar {
  height: 3px;
  background: var(--accent-color, var(--n-primary-color));
  flex-shrink: 0;
  opacity: 0.7;
  transition: opacity 0.2s;
}

.preset-card:hover .card-accent-bar {
  opacity: 1;
}

.custom-card {
  border: 2px dashed var(--n-border-color, #e0e0e0);
  background-color: transparent;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 20px;
}

.custom-card:hover {
  border-color: var(--n-primary-color);
  background-color: rgba(var(--n-primary-color-rgb, 15, 107, 74), 0.02);
}

.custom-icon {
  color: var(--n-text-color-3);
  margin-bottom: 10px;
  transition: color 0.2s;
}

.custom-card:hover .custom-icon {
  color: var(--n-primary-color);
}

.card-body {
  padding: 14px 16px;
  flex: 1;
  display: flex;
  flex-direction: column;
}

.card-content {
  width: 100%;
  display: flex;
  flex-direction: column;
  height: 100%;
}

.card-header-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 6px;
  gap: 8px;
}

.card-title {
  font-weight: 600;
  font-size: 0.92rem;
  color: var(--n-text-color);
  line-height: 1.4;
}

.preset-card .card-title {
  color: var(--n-text-color);
}

.template-tag {
  background-color: var(--accent-color, var(--n-action-color));
  color: #fff;
  flex-shrink: 0;
  font-size: 0.7rem;
  opacity: 0.8;
}

.card-desc {
  font-size: 0.8rem;
  color: var(--n-text-color-3);
  line-height: 1.45;
  margin-bottom: 10px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.examples-preview {
  margin-top: auto;
  padding: 8px 10px;
  border-radius: 6px;
  background-color: var(--n-action-color, rgba(0, 0, 0, 0.02));
  border-left: 2px solid var(--accent-color, var(--n-divider-color, #e8e8e8));
}

.examples-list {
  font-size: 0.76rem;
  color: var(--n-text-color-2);
  line-height: 1.5;
}

.example-item {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 1px;
}

.example-more {
  color: var(--n-text-color-3);
  font-size: 0.74rem;
  margin-top: 2px;
}
</style>
