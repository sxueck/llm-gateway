import { createRouter, createWebHistory } from 'vue-router';
import type { RouteLocation } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useLoadingStore } from '@/stores/loading';

/**
 * 旧地址重定向到新位置。query / hash 必须跟着走：
 * 虚拟密钥页用 ?virtualKeyId= 传递过滤条件，直接丢弃会让跳转后列表不过滤。
 */
function legacy(path: string) {
  return (to: RouteLocation) => ({ path, query: to.query, hash: to.hash });
}

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
          // 监控中心：三个监控页是同一件事的分支，由 SectionShell 的 tab 切换。
          path: 'monitoring',
          component: () => import('@/components/SectionShell.vue'),
          children: [
            {
              path: '',
              redirect: '/monitoring/worker-monitoring',
            },
            {
              path: 'worker-monitoring',
              name: 'WorkerMonitoring',
              component: () => import('@/views/WorkerMonitoringView.vue'),
            },
            {
              path: 'worker-monitoring/runs/:id',
              name: 'AgentRunDetail',
              component: () => import('@/views/AgentRunDetailView.vue'),
              meta: { hideSectionTabs: true },
            },
            {
              path: 'operations-monitoring',
              name: 'OperationsMonitoring',
              component: () => import('@/views/OperationsMonitoringView.vue'),
            },
            {
              path: 'traffic-analysis',
              name: 'TrafficAnalysis',
              component: () => import('@/views/TrafficAnalysisView.vue'),
            },
          ],
        },
        {
          path: 'experimental',
          component: () => import('@/components/SectionShell.vue'),
          children: [
            {
              path: '',
              redirect: '/experimental/expert-routing',
            },
            {
              path: 'expert-routing',
              name: 'ExpertRouting',
              component: () => import('@/views/ExpertRoutingView.vue'),
            },
            {
              path: 'expert-routing/:id',
              name: 'ExpertRoutingDetail',
              component: () => import('@/views/ExpertRoutingDetailView.vue'),
              meta: { hideSectionTabs: true },
            },
            {
              path: 'worker-plugins',
              name: 'WorkerPlugins',
              component: () => import('@/views/WorkerPluginsView.vue'),
            },
            {
              path: 'cost-analysis',
              name: 'CostAnalysis',
              component: () => import('@/views/CostAnalysisView.vue'),
            },
          ],
        },
        {
          path: 'tools',
          component: () => import('@/components/SectionShell.vue'),
          children: [
            {
              path: '',
              redirect: '/tools/playground',
            },
            {
              path: 'playground',
              name: 'Playground',
              component: () => import('@/views/PlaygroundView.vue'),
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
          ],
        },
        {
          path: 'settings',
          component: () => import('@/components/SectionShell.vue'),
          children: [
            {
              path: '',
              redirect: '/settings/general',
            },
            {
              path: 'general',
              name: 'Settings',
              component: () => import('@/views/SettingsView.vue'),
            },
            {
              path: 'security-settings',
              name: 'SecuritySettings',
              component: () => import('@/views/SecuritySettingsView.vue'),
            },
            {
              path: 'backup',
              name: 'Backup',
              component: () => import('@/views/BackupView.vue'),
            },
            {
              path: 'developer-settings',
              name: 'DeveloperSettings',
              component: () => import('@/views/DeveloperSettingsView.vue'),
            },
            {
              path: 'db-maintenance',
              name: 'DatabaseMaintenance',
              component: () => import('@/views/DatabaseMaintenanceView.vue'),
            },
          ],
        },

        // ---- 旧地址兼容（书签、外部链接、页面内硬编码跳转）----
        { path: 'worker-monitoring', redirect: legacy('/monitoring/worker-monitoring') },
        {
          path: 'worker-monitoring/runs/:id',
          redirect: (to) => ({
            path: `/monitoring/worker-monitoring/runs/${to.params.id}`,
            query: to.query,
          }),
        },
        { path: 'operations-monitoring', redirect: legacy('/monitoring/operations-monitoring') },
        {
          // 旧的性能页已并入运营监控，保留一层兼容跳转。
          path: 'performance-monitoring',
          redirect: '/monitoring/operations-monitoring',
        },
        { path: 'traffic-analysis', redirect: legacy('/monitoring/traffic-analysis') },
        { path: 'expert-routing', redirect: legacy('/experimental/expert-routing') },
        {
          path: 'expert-routing/:id',
          redirect: (to) => ({
            path: `/experimental/expert-routing/${to.params.id}`,
            query: to.query,
          }),
        },
        { path: 'worker-plugins', redirect: legacy('/experimental/worker-plugins') },
        { path: 'cost-analysis', redirect: legacy('/experimental/cost-analysis') },
        { path: 'playground', redirect: legacy('/tools/playground') },
        { path: 'logs', redirect: legacy('/tools/logs') },
        { path: 'api-requests', redirect: legacy('/tools/api-requests') },
        { path: 'security-settings', redirect: legacy('/settings/security-settings') },
        { path: 'backup', redirect: legacy('/settings/backup') },
        { path: 'developer-settings', redirect: legacy('/settings/developer-settings') },
        { path: 'db-maintenance', redirect: legacy('/settings/db-maintenance') },
      ],
    },
    {
      path: '/:pathMatch(.*)*',
      redirect: '/',
    },
  ],
});

router.beforeEach((to, _from, next) => {
  const loadingStore = useLoadingStore();
  loadingStore.startRouteLoading();

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

router.afterEach(() => {
  const loadingStore = useLoadingStore();
  loadingStore.stopRouteLoading();
});

router.onError(() => {
  const loadingStore = useLoadingStore();
  loadingStore.stopRouteLoading();
});

export default router;
