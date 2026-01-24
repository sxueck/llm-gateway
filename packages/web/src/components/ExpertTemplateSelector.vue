<template>
  <div class="template-selector">
    <div class="section-header">
      <h3>{{ t('expertRouting.selectTemplateTitle') }}</h3>
      <p class="section-desc">{{ t('expertRouting.selectTemplateDesc') }}</p>
    </div>

    <n-spin :show="loading">
      <div class="templates-grid">
      <!-- Custom / Empty Option -->
      <div 
        class="template-card custom-card"
        @click="handleSelect('custom')"
      >
        <div class="card-icon custom-icon">
          <n-icon size="32"><AddOutline /></n-icon>
        </div>
        <div class="card-content">
          <div class="card-title">{{ t('expertRouting.customTemplate') }}</div>
          <div class="card-desc">{{ t('expertRouting.customTemplateDesc') }}</div>
        </div>
      </div>

      <!-- Presets -->
      <div
        v-for="tpl in templates"
        :key="tpl.value"
        class="template-card preset-card"
        :style="{ '--accent-color': getTemplateColor(tpl.value) }"
        @click="handleSelect(tpl.value)"
      >
        <div class="card-body">
          <div class="card-content">
            <div class="card-header-row">
              <div class="card-title">{{ tpl.label }}</div>
              <n-tag size="small" :bordered="false" round class="template-tag">
                {{ tpl.utterances.length }} {{ t('expertRouting.examples') }}
              </n-tag>
            </div>

            <div class="card-desc" :title="tpl.description">{{ tpl.description }}</div>

            <div class="examples-preview">
              <div class="examples-title">{{ t('expertRouting.examples') }}</div>
              <div class="examples-list">
                <div v-for="(ex, idx) in tpl.utterances.slice(0, 3)" :key="idx" class="example-item">
                  - {{ ex }}
                </div>
                <div v-if="tpl.utterances.length > 3" class="example-more">...</div>
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
    case 'debug': return '#d03050'; // Red
    case 'explain': return '#2080f0'; // Blue
    case 'feature': return '#18a058'; // Green
    case 'plan': return '#f0a020'; // Orange
    case 'refactor': return '#8a2be2'; // Purple
    case 'review': return '#f5222d'; // Red
    case 'setup': return '#707070'; // Grey
    case 'test': return '#10b981'; // Emerald
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
  padding: 14px 16px;
}

.section-header {
  margin-bottom: 16px;
  text-align: center;
}

.section-header h3 {
  margin: 0 0 8px 0;
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--n-text-color);
}

.section-desc {
  margin: 0;
  color: var(--n-text-color-3);
  font-size: 0.9rem;
}

.templates-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 14px;
}

.template-card {
  position: relative;
  border-radius: 12px;
  background-color: var(--n-card-color, #fff);
  border: 1px solid var(--n-border-color, #efeff5);
  cursor: pointer;
  transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
  min-height: 176px;
  display: flex;
  flex-direction: column;
}

.template-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 12px 24px rgba(0, 0, 0, 0.08);
  border-color: var(--accent-color, var(--n-primary-color));
}

/* Custom Card Style */
.custom-card {
  border: 2px dashed var(--n-border-color, #e0e0e0);
  background-color: transparent;
  align-items: center;
  justify-content: center;
  text-align: center;
}

.custom-card:hover {
  border-color: var(--n-primary-color);
  background-color: rgba(var(--n-primary-color-rgb), 0.02);
}

.custom-icon {
  color: var(--n-text-color-3);
  margin-bottom: 12px;
  transition: color 0.3s;
}

.custom-card:hover .custom-icon {
  color: var(--n-primary-color);
}

/* Preset Card Style */
.card-header-accent {
  display: none;
}

.card-body {
  padding: 14px;
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
}

.card-title {
  font-weight: 600;
  font-size: 1rem;
  color: var(--n-text-color);
  margin-right: 8px;
}

/* Preset titles are intentionally de-emphasized */
.preset-card .card-title {
  color: var(--n-text-color-3);
}

.template-tag {
  background-color: var(--n-action-color);
  color: var(--n-text-color-2);
  flex-shrink: 0;
}

.card-desc {
  font-size: 0.82rem;
  color: var(--n-text-color-3);
  line-height: 1.4;
  margin-bottom: 10px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.examples-preview {
  margin-top: auto;
  background-color: var(--n-action-color); /* Light grey usually */
  padding: 10px;
  border-radius: 8px;
  border-left: 3px solid var(--n-divider-color, var(--n-border-color, #e8e8e8));
}

.examples-title {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--n-text-color-2);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.examples-list {
  font-size: 0.8rem;
  color: var(--n-text-color-2);
  line-height: 1.5;
}

.example-item {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 2px;
}

.example-more {
  color: var(--n-text-color-3);
}
</style>
