<template>
  <div class="auth-page">
    <div class="auth-container">
      <div class="auth-brand">
        <h1 class="brand-name">LLM Gateway</h1>
        <p class="brand-tagline">{{ t('auth.tagline') }}</p>
      </div>

      <n-card class="auth-card" :bordered="false">
        <div class="auth-header">
          <h2 class="auth-title">{{ t('auth.welcome') }}</h2>
          <p class="auth-subtitle">{{ t('auth.loginSubtitle') }}</p>
        </div>

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
              @keydown.enter="handleLogin"
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
              @keydown.enter="handleLogin"
              class="password-input"
            >
              <template #prefix>
                <n-icon class="input-icon"><LockClosedOutline /></n-icon>
              </template>
            </n-input>
          </n-form-item>

          <n-space vertical :size="16" class="auth-actions">
            <n-button
              type="primary"
              block
              size="large"
              :loading="loading"
              class="login-button"
              @click="handleLogin"
            >
              <template #icon>
                <n-icon><LogInOutline /></n-icon>
              </template>
              {{ t('auth.login') }}
            </n-button>

            <n-button
              v-if="allowRegistration"
              text
              block
              class="register-link"
              @click="$router.push('/register')"
            >
              {{ t('auth.noAccount') }}<span class="link-text">{{ t('auth.registerNow') }}</span>
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
  NIcon
} from 'naive-ui'
import {
  PersonOutline,
  LockClosedOutline,
  LogInOutline
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
  password: ''
})

const rules = computed(() => ({
  username: [{ required: true, message: t('auth.usernamePlaceholder'), trigger: 'blur' }],
  password: [{ required: true, message: t('auth.passwordPlaceholder'), trigger: 'blur' }]
}))

async function handleLogin() {
  try {
    await formRef.value?.validate()
    loading.value = true
    await authStore.login(formValue.value)
    message.success(t('auth.loginSuccess'))
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
