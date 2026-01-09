import { defineStore } from 'pinia';
import { ref } from 'vue';
import { modelApi } from '@/api/model';
import type { Model } from '@/types';

export const useModelStore = defineStore('model', () => {
  const models = ref<Model[]>([]);
  const loading = ref(false);

  async function fetchModels() {
    loading.value = true;
    try {
      const response = await modelApi.getAll();
      models.value = response.models;
    } catch (error) {
      console.error('Failed to fetch models:', error);
      models.value = [];
    } finally {
      loading.value = false;
    }
  }

  function addModel(model: Model) {
    models.value.push(model);
  }

  function updateModel(updatedModel: Model) {
    const index = models.value.findIndex(m => m.id === updatedModel.id);
    if (index !== -1) {
      models.value[index] = updatedModel;
    }
  }

  function removeModel(modelId: string) {
    const index = models.value.findIndex(m => m.id === modelId);
    if (index !== -1) {
      models.value.splice(index, 1);
    }
  }

  return {
    models,
    loading,
    fetchModels,
    addModel,
    updateModel,
    removeModel,
  };
});

