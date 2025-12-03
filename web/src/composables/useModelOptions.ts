import { computed } from 'vue';
import { useModelStore } from '@/stores/model';

interface UseModelOptionsConfig {
  uniqueByIdentifier?: boolean;
  labelStyle?: 'nameWithProvider' | 'providerDashName';
  valueField?: 'id' | 'modelIdentifier';
}

export function useModelOptions(config: UseModelOptionsConfig = {}) {
  const {
    uniqueByIdentifier = false,
    labelStyle = 'providerDashName',
    valueField = 'modelIdentifier',
  } = config;

  const modelStore = useModelStore();

  const modelOptions = computed(() => {
    let models = modelStore.models.filter(m => m.enabled);

    if (uniqueByIdentifier) {
      const map = new Map<string, typeof models[number]>();
      for (const m of models) {
        if (!map.has(m.modelIdentifier)) {
          map.set(m.modelIdentifier, m);
        }
      }
      models = Array.from(map.values());
    }

    const options = models.map(m => {
      const label = labelStyle === 'nameWithProvider'
        ? `${m.name} (${m.providerName})`
        : `${m.providerName} - ${m.name}`;

      const value = valueField === 'id' ? m.id : m.modelIdentifier;

      return { label, value };
    });

    return options.sort((a, b) => a.label.localeCompare(b.label));
  });

  return { modelOptions };
}
