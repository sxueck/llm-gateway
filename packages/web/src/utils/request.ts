import axios from 'axios';
import type { AxiosInstance, AxiosError, AxiosRequestConfig } from 'axios';
import { useAuthStore } from '@/stores/auth';
import router from '@/router';
import i18n from '@/i18n';

interface CustomAxiosInstance extends Omit<AxiosInstance, 'get' | 'post' | 'put' | 'delete' | 'patch'> {
  get<T = any>(url: string, config?: AxiosRequestConfig): Promise<T>;
  post<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T>;
  put<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T>;
  delete<T = any>(url: string, config?: AxiosRequestConfig): Promise<T>;
  patch<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<T>;
}

const axiosInstance: AxiosInstance = axios.create({
  baseURL: '/api',
  timeout: 120000,
});

axiosInstance.interceptors.request.use(
  (config) => {
    const authStore = useAuthStore();
    if (authStore.token) {
      config.headers.Authorization = `Bearer ${authStore.token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

axiosInstance.interceptors.response.use(
  (response) => {
    return response.data;
  },
  (error: AxiosError<{ error: unknown }>) => {
    if (error.response?.status === 401) {
      const authStore = useAuthStore();
      const path = router.currentRoute.value.path;
      authStore.logout();
      if (path !== '/login' && path !== '/register') {
        void router.push('/login');
      }
    }

    const t = i18n.global.t;
    if (error.code === 'ECONNABORTED') {
      error.message = t('messages.timeout');
      return Promise.reject(error);
    }

    const errorData = error.response?.data?.error;
    let message = t('messages.requestFailed');

    if (typeof errorData === 'string') {
      message = errorData;
    } else if (errorData && typeof errorData === 'object') {
      const maybeMessage = (errorData as { message?: unknown }).message;
      message = typeof maybeMessage === 'string' ? maybeMessage : JSON.stringify(errorData);
    } else if (!error.response && error.message) {
      message = error.message;
    }

    error.message = message;
    return Promise.reject(error);
  }
);

const request = axiosInstance as CustomAxiosInstance;

export default request;

