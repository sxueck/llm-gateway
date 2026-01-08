<template>
  <n-space align="center">
    <n-tag :type="getStatusType()" size="small">
      {{ getStatusText() }}
    </n-tag>
    <n-tooltip v-if="preset" trigger="hover">
      <template #trigger>
        <n-icon size="16" :color="getIconColor()">
          <InfoIcon />
        </n-icon>
      </template>
      <div style="max-width: 300px">
        <n-space vertical :size="8">
          <n-text strong>{{ preset.name }}</n-text>
          <n-text depth="3">{{ preset.description }}</n-text>
          <n-space>
            <n-text depth="3">{{ t('common.category') }}:</n-text>
            <n-tag size="tiny" type="info">{{ preset.category }}</n-tag>
          </n-space>
          <n-space>
            <n-text depth="3">{{ t('providers.supportedFeatures') }}:</n-text>
            <n-space>
              <n-tag v-if="preset.features.chat" size="tiny" type="success">{{ t('providers.features.chat') }}</n-tag>
              <n-tag v-if="preset.features.vision" size="tiny" type="success">{{ t('providers.features.vision') }}</n-tag>
              <n-tag v-if="preset.features.tools" size="tiny" type="success">{{ t('providers.features.tools') }}</n-tag>
              <n-tag v-if="preset.features.embeddings" size="tiny" type="success">{{ t('providers.features.embeddings') }}</n-tag>
              <n-tag v-if="preset.features.images" size="tiny" type="success">{{ t('providers.features.images') }}</n-tag>
              <n-tag v-if="preset.features.audio" size="tiny" type="success">{{ t('providers.features.audio') }}</n-tag>
            </n-space>
          </n-space>

        </n-space>
      </div>
    </n-tooltip>
  </n-space>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { NSpace, NTag, NTooltip, NIcon, NText } from 'naive-ui';
import { Information as InfoIcon } from '@vicons/ionicons5';
import { getProviderById } from '@/constants/providers';

const { t } = useI18n();

interface Props {
  providerId: string;
}

const props = defineProps<Props>();

const preset = computed(() => {
  return getProviderById(props.providerId);
});

const isSupported = computed(() => {
  return !!preset.value;
});

function getStatusType(): 'success' | 'warning' | 'default' {
  if (isSupported.value) return 'success';
  return 'warning';
}

function getStatusText(): string {
  if (isSupported.value) return t('providers.officialSupport');
  return t('providers.custom');
}

function getIconColor(): string {
  if (isSupported.value) return '#18a058';
  return '#f0a020';
}
</script>
