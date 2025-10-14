<template>
  <div class="auth-container">
    <n-card class="auth-card" title="注册">
      <n-alert v-if="!allowRegistration" type="warning" style="margin-bottom: 12px;">
        当前已关闭注册，仅允许已有用户登录
      </n-alert>

      <demo-mode-alert />

      <n-form ref="formRef" :model="formValue" :rules="rules" size="large">
        <n-form-item path="username" label="用户名">
          <n-input
            v-model:value="formValue.username"
            placeholder="请输入用户名"
            :disabled="!allowRegistration"
          />
        </n-form-item>
        <n-form-item path="password" label="密码">
          <n-input
            v-model:value="formValue.password"
            type="password"
            show-password-on="click"
            placeholder="请输入密码"
            :disabled="!allowRegistration"
          />
        </n-form-item>
        <n-form-item path="confirmPassword" label="确认密码">
          <n-input
            v-model:value="formValue.confirmPassword"
            type="password"
            show-password-on="click"
            placeholder="请再次输入密码"
            @keydown.enter="handleRegister"
            :disabled="!allowRegistration"
          />
        </n-form-item>
        <n-space vertical :size="16">
          <n-button
            type="primary"
            block
            size="large"
            :loading="loading"
            :disabled="!allowRegistration"
            @click="handleRegister"
          >
            注册
          </n-button>
          <n-button text block @click="$router.push('/login')">
            已有账号？立即登录
          </n-button>
        </n-space>
      </n-form>
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useMessage, NCard, NForm, NFormItem, NInput, NButton, NSpace, NAlert } from 'naive-ui';
import { useAuthStore } from '@/stores/auth';
import { useSystemConfig } from '@/composables/useSystemConfig';
import DemoModeAlert from '@/components/DemoModeAlert.vue';

const router = useRouter();
const message = useMessage();
const authStore = useAuthStore();

const { allowRegistration } = useSystemConfig();


const formRef = ref();
const loading = ref(false);
const formValue = ref({
  username: '',
  password: '',
  confirmPassword: '',
});

const rules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
    { min: 3, max: 32, message: '用户名长度必须在 3-32 个字符之间', trigger: 'blur' },
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
    { min: 6, message: '密码长度至少为 6 个字符', trigger: 'blur' },
  ],
  confirmPassword: [
    { required: true, message: '请再次输入密码', trigger: 'blur' },
    {
      validator: (_rule: any, value: string) => {
        return value === formValue.value.password;
      },
      message: '两次输入的密码不一致',
      trigger: 'blur',
    },
  ],
};

async function handleRegister() {
  try {
    await formRef.value?.validate();
    loading.value = true;
    await authStore.register({
      username: formValue.value.username,
      password: formValue.value.password,
    });
    message.success('注册成功');
    router.push('/dashboard');
  } catch (error: any) {
    if (error.message) {
      message.error(error.message);
    }
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.auth-container {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  background: #ffffff;
}

.auth-card {
  width: 100%;
  max-width: 400px;
  margin: 20px;
}
</style>

