<template>
  <div class="auth-page">
    <div class="auth-container">
      <div class="auth-brand">
        <h1 class="brand-name">LLM Gateway</h1>
        <p class="brand-tagline">统一的大语言模型接入网关</p>
      </div>

      <n-card class="auth-card" :bordered="false">
        <div class="auth-header">
          <h2 class="auth-title">创建账号</h2>
          <p class="auth-subtitle">注册以开始使用系统</p>
        </div>

        <n-alert v-if="!allowRegistration" type="warning" class="registration-warning">
          当前已关闭注册，仅允许已有用户登录
        </n-alert>

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
              :disabled="!allowRegistration"
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
              :disabled="!allowRegistration"
              class="password-input"
            >
              <template #prefix>
                <n-icon class="input-icon"><LockClosedOutline /></n-icon>
              </template>
            </n-input>
          </n-form-item>

          <n-form-item path="confirmPassword" label="确认密码">
            <n-input
              v-model:value="formValue.confirmPassword"
              type="password"
              show-password-on="click"
              placeholder="请再次输入密码"
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
              注册
            </n-button>

            <n-button
              text
              block
              class="register-link"
              @click="$router.push('/login')"
            >
              已有账号？<span class="link-text">立即登录</span>
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

const { allowRegistration } = useSystemConfig()

const formRef = ref()
const loading = ref(false)
const formValue = ref({
  username: '',
  password: '',
  confirmPassword: ''
})

const rules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 3, max: 32, message: '用户名长度必须在 3-32 个字符之间', trigger: 'blur' }
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, message: '密码长度至少为 6 个字符', trigger: 'blur' }
  ],
  confirmPassword: [
    { required: true, message: '请再次输入密码', trigger: 'blur' },
    {
      validator: (_rule: any, value: string) => {
        return value === formValue.value.password
      },
      message: '两次输入的密码不一致',
      trigger: 'blur'
    }
  ]
}

async function handleRegister() {
  try {
    await formRef.value?.validate()
    loading.value = true
    await authStore.register({
      username: formValue.value.username,
      password: formValue.value.password
    })
    message.success('注册成功')
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
