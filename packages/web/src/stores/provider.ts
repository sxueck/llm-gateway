import { defineStore } from 'pinia';
import { ref } from 'vue';
import { providerApi } from '@/api/provider';
import type { Provider } from '@/types';

export const useProviderStore = defineStore('provider', () => {
  const providers = ref<Provider[]>([]);
  const loading = ref(false);

  async function fetchProviders() {
    loading.value = true;
    try {
      const response = await providerApi.getAll();
      providers.value = response.providers;
    } finally {
      loading.value = false;
    }
  }

  return {
    providers,
    loading,
    fetchProviders,
  };
});

