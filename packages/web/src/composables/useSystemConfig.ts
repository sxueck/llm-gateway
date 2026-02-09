import { ref, onMounted } from 'vue';
import { configApi } from '@/api/config';

const allowRegistration = ref(true);
const dashboardHideRequestSourceCard = ref(false);
const isLoaded = ref(false);

export function useSystemConfig() {
  onMounted(async () => {
    if (!isLoaded.value) {
      await loadSystemConfig();
    }
  });

  async function loadSystemConfig() {
    try {
      const settings = await configApi.getPublicSystemSettings();
      allowRegistration.value = settings.allowRegistration;
      dashboardHideRequestSourceCard.value = settings.dashboardHideRequestSourceCard;
      isLoaded.value = true;
    } catch (error) {
      console.error('加载系统配置失败:', error);
    }
  }

  return {
    allowRegistration,
    dashboardHideRequestSourceCard,
    isLoaded,
    loadSystemConfig,
  };
}
