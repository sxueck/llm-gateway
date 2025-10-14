<template>
  <div class="auth-container">
    <n-card class="auth-card" title="登录">
      <demo-mode-alert />
      <n-form ref="formRef" :model="formValue" :rules="rules" size="large">
        <n-form-item path="username" label="用户名">
          <n-input
            v-model:value="formValue.username"
            placeholder="请输入用户名"
            @keydown.enter="handleLogin"
          />
        </n-form-item>
        <n-form-item path="password" label="密码">
          <n-input
            v-model:value="formValue.password"
            type="password"
            show-password-on="click"
            placeholder="请输入密码"
            @keydown.enter="handleLogin"
          />
        </n-form-item>
        <n-space vertical :size="16">
          <n-button
            type="primary"
            block
            size="large"
            :loading="loading"
            @click="handleLogin"
          >
            登录
          </n-button>
          <n-button v-if="allowRegistration" text block @click="$router.push('/register')">
            还没有账号？立即注册
          </n-button>
        </n-space>
      </n-form>
    </n-card>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useMessage, NCard, NForm, NFormItem, NInput, NButton, NSpace } from 'naive-ui';
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
});

const rules = {
  username: [
    { required: true, message: '请输入用户名', trigger: 'blur' },
  ],
  password: [
    { required: true, message: '请输入密码', trigger: 'blur' },
  ],
};

async function handleLogin() {
  try {
    await formRef.value?.validate();
    loading.value = true;
    await authStore.login(formValue.value);
    message.success('登录成功');
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

