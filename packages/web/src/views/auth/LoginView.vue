<template>
  <div class="auth-page">
    <div class="auth-container">
      <div class="auth-brand">
        <h1 class="brand-name">LLM Gateway</h1>
        <p class="brand-tagline">统一的大语言模型接入网关</p>
      </div>

      <n-card class="auth-card" :bordered="false">
        <div class="auth-header">
          <h2 class="auth-title">欢迎回来</h2>
          <p class="auth-subtitle">请登录您的账号</p>
        </div>

        <n-form
          ref="formRef"
          :model="formValue"
          :rules="rules"
          size="large"
          class="auth-form"
        >
          <n-form-item path="username" label="用户名">
            <n-input
              v-model:value="formValue.username"
              placeholder="请输入用户名"
              @keydown.enter="handleLogin"
            >
              <template #prefix>
                <n-icon class="input-icon"><PersonOutline /></n-icon>
              </template>
            </n-input>
          </n-form-item>

          <n-form-item path="password" label="密码">
            <n-input
              v-model:value="formValue.password"
              type="password"
              show-password-on="click"
              placeholder="请输入密码"
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
              登录
            </n-button>

            <n-button
              v-if="allowRegistration"
              text
              block
              class="register-link"
              @click="$router.push('/register')"
            >
              还没有账号？<span class="link-text">立即注册</span>
            </n-button>
          </n-space>
        </n-form>
      </n-card>

      <p class="auth-footer">
        LLM Gateway - 智能模型路由与管理平台
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
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

const { allowRegistration } = useSystemConfig()

const formRef = ref()
const loading = ref(false)
const formValue = ref({
  username: '',
  password: ''
})

const rules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }]
}

async function handleLogin() {
  try {
    await formRef.value?.validate()
    loading.value = true
    await authStore.login(formValue.value)
    message.success('登录成功')
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
