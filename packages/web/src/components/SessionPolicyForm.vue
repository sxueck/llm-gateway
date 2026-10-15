<template>
  <n-form label-placement="top" size="small">
    <n-form-item :label="t('expertRouting.ui.sessionMode')">
      <n-radio-group :value="policy.mode" @update:value="handleModeChange">
        <n-space>
          <n-radio value="per_turn">
            {{ t('expertRouting.modePerTurn') }}
          </n-radio>
          <n-radio value="sticky">{{ t('expertRouting.modeSticky') }}</n-radio>
          <n-radio value="escalate_only">
            {{ t('expertRouting.modeEscalateOnly') }}
          </n-radio>
        </n-space>
      </n-radio-group>
      <template #feedback>
        {{ modeDescription }}
      </template>
    </n-form-item>
    <n-form-item :label="t('expertRouting.idleTtlHours')">
      <n-input-number
        :value="idleHours"
        :min="0"
        style="width: 100%"
        @update:value="handleIdleChange"
      />
    </n-form-item>
    <n-form-item :label="t('expertRouting.absoluteTtlDays')">
      <n-input-number
        :value="absoluteDays"
        :min="0"
        style="width: 100%"
        @update:value="handleAbsoluteChange"
      />
    </n-form-item>
  </n-form>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  NForm,
  NFormItem,
  NInputNumber,
  NRadio,
  NRadioGroup,
  NSpace,
} from 'naive-ui';
import type { SessionPolicy, SessionPolicyMode } from '@/api/expert-routing';

interface Props {
  policy: SessionPolicy;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  'update:policy': [value: SessionPolicy];
}>();

const { t } = useI18n();

// 输入用小时/天，存储仍是秒（与后端 v2 契约一致）。
const idleHours = computed(() => (props.policy.idle_ttl_seconds ?? 0) / 3600);
const absoluteDays = computed(
  () => (props.policy.absolute_ttl_seconds ?? 0) / 86400,
);

const modeDescription = computed(() => {
  const map: Record<SessionPolicyMode, string> = {
    per_turn: t('expertRouting.modePerTurnDesc'),
    sticky: t('expertRouting.modeStickyDesc'),
    escalate_only: t('expertRouting.modeEscalateOnlyDesc'),
  };
  return map[props.policy.mode] ?? '';
});

function handleModeChange(mode: SessionPolicyMode) {
  emit('update:policy', { ...props.policy, mode });
}

function handleIdleChange(value: number | null) {
  emit('update:policy', {
    ...props.policy,
    idle_ttl_seconds: Math.max(0, Math.round((value ?? 0) * 3600)),
  });
}

function handleAbsoluteChange(value: number | null) {
  emit('update:policy', {
    ...props.policy,
    absolute_ttl_seconds: Math.max(0, Math.round((value ?? 0) * 86400)),
  });
}
</script>
