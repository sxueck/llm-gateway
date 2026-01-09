import { defineStore } from 'pinia';
import { ref } from 'vue';
import { virtualKeyApi } from '@/api/virtual-key';
import type { VirtualKey } from '@/types';

export const useVirtualKeyStore = defineStore('virtualKey', () => {
  const virtualKeys = ref<VirtualKey[]>([]);
  const loading = ref(false);

  async function fetchVirtualKeys() {
    loading.value = true;
    try {
      const response = await virtualKeyApi.getAll();
      virtualKeys.value = response.virtualKeys;
    } finally {
      loading.value = false;
    }
  }

  return {
    virtualKeys,
    loading,
    fetchVirtualKeys,
  };
});

