import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'Login',
      component: () => import('@/views/auth/LoginView.vue'),
      meta: { requiresAuth: false },
    },
    {
      path: '/register',
      name: 'Register',
      component: () => import('@/views/auth/RegisterView.vue'),
      meta: { requiresAuth: false },
    },
    {
      path: '/',
      component: () => import('@/layouts/MainLayout.vue'),
      meta: { requiresAuth: true },
      children: [
        {
          path: '',
          redirect: '/dashboard',
        },
        {
          path: 'dashboard',
          name: 'Dashboard',
          component: () => import('@/views/DashboardView.vue'),
        },
        {
          path: 'providers',
          name: 'Providers',
          component: () => import('@/views/ProvidersView.vue'),
        },
        {
          path: 'models',
          name: 'Models',
          component: () => import('@/views/ModelsView.vue'),
        },
        {
          path: 'virtual-keys',
          name: 'VirtualKeys',
          component: () => import('@/views/VirtualKeysView.vue'),
        },
        {
          path: 'virtual-models',
          name: 'VirtualModels',
          component: () => import('@/views/VirtualModelsView.vue'),
        },
        {
          path: 'prompt-management',
          name: 'PromptManagement',
          component: () => import('@/views/PromptManagementView.vue'),
        },
        {
          path: 'expert-routing',
          name: 'ExpertRouting',
          component: () => import('@/views/ExpertRoutingView.vue'),
        },
        {
          path: 'api-guide',
          name: 'ApiGuide',
          component: () => import('@/views/ApiGuideView.vue'),
        },
        {
          path: 'logs',
          name: 'Logs',
          component: () => import('@/views/LogsView.vue'),
        },
        {
          path: 'api-requests',
          name: 'ApiRequests',
          component: () => import('@/views/ApiRequestsView.vue'),
        },
        {
          path: 'settings',
          name: 'Settings',
          component: () => import('@/views/SettingsView.vue'),
        },
        {
          path: 'security-settings',
          name: 'SecuritySettings',
          component: () => import('@/views/SecuritySettingsView.vue'),
        },
      ],
    },
  ],
});

router.beforeEach((to, _from, next) => {
  const authStore = useAuthStore();
  const requiresAuth = to.matched.some(record => record.meta.requiresAuth !== false);

  if (requiresAuth && !authStore.token) {
    next('/login');
  } else if (!requiresAuth && authStore.token && (to.path === '/login' || to.path === '/register')) {
    next('/dashboard');
  } else {
    next();
  }
});

export default router;

