import { defineStore } from 'pinia';
import { ref } from 'vue';
import { authApi } from '@/api/auth';
import type { User, LoginRequest, RegisterRequest } from '@/types';

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(localStorage.getItem('token'));
  const user = ref<User | null>(null);

  async function login(data: LoginRequest) {
    const response = await authApi.login(data);
    token.value = response.token;
    user.value = response.user;
    localStorage.setItem('token', response.token);
  }

  async function register(data: RegisterRequest) {
    const response = await authApi.register(data);
    token.value = response.token;
    user.value = response.user;
    localStorage.setItem('token', response.token);
  }

  async function fetchProfile() {
    if (!token.value) return;
    try {
      user.value = await authApi.getProfile();
    } catch (error) {
      logout();
    }
  }

  function logout() {
    token.value = null;
    user.value = null;
    localStorage.removeItem('token');
  }

  return {
    token,
    user,
    login,
    register,
    fetchProfile,
    logout,
  };
});

