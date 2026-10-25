<template>
  <div class="auth-page">
    <div class="auth-container">
      <div class="auth-brand">
        <h1 class="brand-name">LLM Gateway</h1>
        <p class="brand-tagline">{{ t('auth.tagline') }}</p>
      </div>

      <n-card class="auth-card" :bordered="false">
        <div class="auth-header">
          <h2 class="auth-title">{{ t('auth.createAccount') }}</h2>
          <p class="auth-subtitle">{{ t('auth.registerSubtitle') }}</p>
        </div>

        <n-alert v-if="!allowRegistration" type="warning" class="registration-warning">
          {{ t('auth.registrationClosed') }}
        </n-alert>

        <n-form
          ref="formRef"
          :model="formValue"
          :rules="rules"
          size="large"
          class="auth-form"
        >
          <n-form-item path="username" :label="t('auth.username')">
            <n-input
              v-model:value="formValue.username"
              :placeholder="t('auth.usernamePlaceholder')"
              :disabled="!allowRegistration"
            >
              <template #prefix>
                <n-icon class="input-icon"><PersonOutline /></n-icon>
              </template>
            </n-input>
          </n-form-item>

          <n-form-item path="password" :label="t('auth.password')">
            <n-input
              v-model:value="formValue.password"
              type="password"
              show-password-on="click"
              :placeholder="t('auth.passwordPlaceholder')"
              :disabled="!allowRegistration"
              class="password-input"
            >
              <template #prefix>
                <n-icon class="input-icon"><LockClosedOutline /></n-icon>
              </template>
            </n-input>
          </n-form-item>

          <n-form-item path="confirmPassword" :label="t('auth.confirmPassword')">
            <n-input
              v-model:value="formValue.confirmPassword"
              type="password"
              show-password-on="click"
              :placeholder="t('auth.confirmPasswordPlaceholder')"
              @keydown.enter="handleRegister"
              :disabled="!allowRegistration"
              class="password-input"
            >
              <template #prefix>
                <n-icon class="input-icon"><ShieldCheckmarkOutline /></n-icon>
              </template>
            </n-input>
          </n-form-item>

          <n-space vertical :size="16" class="auth-actions">
            <n-button
              type="primary"
              block
              size="large"
              :loading="loading"
              :disabled="!allowRegistration"
              class="login-button"
              @click="handleRegister"
            >
              <template #icon>
                <n-icon><PersonAddOutline /></n-icon>
              </template>
              {{ t('auth.register') }}
            </n-button>

            <n-button
              text
              block
              class="register-link"
              @click="$router.push('/login')"
            >
              {{ t('auth.hasAccount') }}<span class="link-text">{{ t('auth.loginNow') }}</span>
            </n-button>
          </n-space>
        </n-form>
      </n-card>

      <p class="auth-footer">
        {{ t('auth.footer') }}
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  useMessage,
  NCard,
  NForm,
  NFormItem,
  NInput,
  NButton,
  NSpace,
  NAlert,
  NIcon
} from 'naive-ui'
import {
  PersonOutline,
  LockClosedOutline,
  ShieldCheckmarkOutline,
  PersonAddOutline
} from '@vicons/ionicons5'
import { useAuthStore } from '@/stores/auth'
import { useSystemConfig } from '@/composables/useSystemConfig'

const router = useRouter()
const message = useMessage()
const authStore = useAuthStore()
const { t } = useI18n()

const { allowRegistration } = useSystemConfig()

const formRef = ref()
const loading = ref(false)
const formValue = ref({
  username: '',
  password: '',
  confirmPassword: ''
})

const rules = computed(() => ({
  username: [
    { required: true, message: t('auth.usernamePlaceholder'), trigger: 'blur' },
    { min: 3, max: 32, message: t('auth.usernameLength'), trigger: 'blur' }
  ],
  password: [
    { required: true, message: t('auth.passwordPlaceholder'), trigger: 'blur' },
    { min: 6, message: t('auth.passwordLength'), trigger: 'blur' }
  ],
  confirmPassword: [
    { required: true, message: t('auth.confirmPasswordPlaceholder'), trigger: 'blur' },
    {
      validator: (_rule: any, value: string) => {
        return value === formValue.value.password
      },
      message: t('auth.passwordMismatch'),
      trigger: 'blur'
    }
  ]
}))

async function handleRegister() {
  try {
    await formRef.value?.validate()
    loading.value = true
    await authStore.register({
      username: formValue.value.username,
      password: formValue.value.password
    })
    message.success(t('auth.registerSuccess'))
    router.push('/dashboard')
  } catch (error: any) {
    if (error.message) {
      message.error(error.message)
    }
  } finally {
    loading.value = false
  }
}
</script>

<style scoped>
@import '@/styles/auth.css';
</style>
