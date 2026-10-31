<template>
  <div class="login-page" :class="{ 'is-login-success': loginSucceeded }">
    <aside class="login-brand">
      <div class="login-brand-content">
        <h1>LLM Gateway</h1>
        <p>{{ t('auth.tagline') }}</p>
      </div>
      <div class="login-brand-lines" aria-hidden="true"></div>
    </aside>

    <main class="login-panel">
      <div class="login-form-container">
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
              :disabled="loginSucceeded"
              class="login-button"
              :class="{ 'login-success': loginSucceeded }"
              @click="handleLogin"
            >
              <template #icon>
                <n-icon><CheckmarkOutline v-if="loginSucceeded" /><LogInOutline v-else /></n-icon>
              </template>
              {{ loginSucceeded ? t('auth.loginSuccess') : t('auth.login') }}
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

      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  useMessage,
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
  LogInOutline,
  CheckmarkOutline
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
const loginSucceeded = ref(false)
const formValue = ref({
  username: '',
  password: ''
})

const rules = computed(() => ({
  username: [{ required: true, message: t('auth.usernamePlaceholder'), trigger: 'input' }],
  password: [{ required: true, message: t('auth.passwordPlaceholder'), trigger: 'input' }]
}))

async function handleLogin() {
  if (loading.value || loginSucceeded.value) return
  loading.value = true
  try {
    await formRef.value?.validate()
    await authStore.login(formValue.value)
    loading.value = false
    loginSucceeded.value = true
    message.success(t('auth.loginSuccess'))
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!reducedMotion) await new Promise(resolve => window.setTimeout(resolve, 360))
    await router.push('/dashboard')
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
@import '@/styles/login.css';
</style>
