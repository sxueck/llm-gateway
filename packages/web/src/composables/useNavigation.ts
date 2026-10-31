import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { NavIconName } from '@/components/nav-icons';

export interface NavLeaf {
  key: string;
  path: string;
  label: string;
  iconName: NavIconName;
}

export interface NavEntry extends NavLeaf {
  children?: NavLeaf[];
}

export interface NavGroup {
  key: string;
  label: string | null;
  entries: NavEntry[];
}

export function useNavigation() {
  const { t } = useI18n();

  const groups = computed<NavGroup[]>(() => [
    {
      key: 'overview',
      label: null,
      entries: [
        {
          key: 'dashboard',
          path: '/dashboard',
          label: t('menu.dashboard'),
          iconName: 'dashboard',
        },
      ],
    },
    {
      key: 'resources',
      label: t('layout.sectionResources'),
      entries: [
        { key: 'providers', path: '/providers', label: t('menu.providers'), iconName: 'providers' },
        { key: 'models', path: '/models', label: t('menu.models'), iconName: 'models' },
        {
          key: 'virtual-models',
          path: '/virtual-models',
          label: t('menu.virtualModels'),
          iconName: 'routing',
        },
        {
          key: 'virtual-keys',
          path: '/virtual-keys',
          label: t('menu.virtualKeys'),
          iconName: 'keys',
        },
      ],
    },
    {
      key: 'observability',
      label: t('layout.sectionObservability'),
      entries: [
        {
          key: 'monitoring',
          path: '/monitoring',
          label: t('menu.monitoring'),
          iconName: 'monitoring',
          // 同一枢纽的兄弟页共用一个族图标：命令面板右侧已经标了归属，不需要再靠图标区分。
          children: [
            {
              key: 'worker-monitoring',
              path: '/monitoring/worker-monitoring',
              label: t('menu.workerMonitoring'),
              iconName: 'monitoring',
            },
            {
              key: 'operations-monitoring',
              path: '/monitoring/operations-monitoring',
              label: t('menu.operationsMonitoring'),
              iconName: 'monitoring',
            },
            {
              key: 'traffic-analysis',
              path: '/monitoring/traffic-analysis',
              label: t('menu.trafficAnalysis'),
              iconName: 'monitoring',
            },
          ],
        },
      ],
    },
    {
      key: 'system',
      label: t('layout.sectionSystem'),
      entries: [
        {
          key: 'experimental',
          path: '/experimental',
          label: t('menu.experimentalFeatures'),
          iconName: 'experimental',
          children: [
            {
              key: 'expert-routing',
              path: '/experimental/expert-routing',
              label: t('menu.expertRouting'),
              iconName: 'experimental',
            },
            {
              key: 'worker-plugins',
              path: '/experimental/worker-plugins',
              label: t('menu.workerPlugins'),
              iconName: 'experimental',
            },
            {
              key: 'cost-analysis',
              path: '/experimental/cost-analysis',
              label: t('menu.costAnalysis'),
              iconName: 'experimental',
            },
          ],
        },
        {
          key: 'tools',
          path: '/tools',
          label: t('menu.tools'),
          iconName: 'tools',
          children: [
            {
              key: 'playground',
              path: '/tools/playground',
              label: t('menu.playground'),
              iconName: 'tools',
            },
            { key: 'logs', path: '/tools/logs', label: t('menu.logs'), iconName: 'tools' },
            {
              key: 'api-requests',
              path: '/tools/api-requests',
              label: t('menu.apiRequests'),
              iconName: 'tools',
            },
          ],
        },
        {
          key: 'settings',
          path: '/settings',
          label: t('menu.settings'),
          iconName: 'settings',
          children: [
            {
              key: 'general',
              path: '/settings/general',
              label: t('settings.general'),
              iconName: 'settings',
            },
            {
              key: 'security-settings',
              path: '/settings/security-settings',
              label: t('settings.security'),
              iconName: 'settings',
            },
            {
              key: 'backup',
              path: '/settings/backup',
              label: t('settings.backup'),
              iconName: 'settings',
            },
            {
              key: 'developer-settings',
              path: '/settings/developer-settings',
              label: t('settings.developerDebug'),
              iconName: 'settings',
            },
            {
              key: 'db-maintenance',
              path: '/settings/db-maintenance',
              label: t('settings.dbMaintenance'),
              iconName: 'settings',
            },
          ],
        },
      ],
    },
  ]);

  /** 侧栏行：枢纽入口只占一行，普通页面各占一行。 */
  const rows = computed<NavEntry[]>(() => groups.value.flatMap((group) => group.entries));

  /** 命令面板索引：真实页面（枢纽的子页），带上所属分组名便于二次筛选。 */
  const pages = computed(() =>
    groups.value.flatMap((group) =>
      group.entries.flatMap((entry) =>
        (entry.children ?? [entry]).map((leaf) => ({
          ...leaf,
          groupLabel: group.label,
          hubLabel: entry.children ? entry.label : null,
        }))
      )
    )
  );

  function hubByPath(path: string): NavEntry | null {
    const segment = path.split('/').find(Boolean) ?? '';
    const entry = rows.value.find((candidate) => candidate.path === `/${segment}`);
    return entry?.children ? entry : null;
  }

  return { groups, rows, pages, hubByPath };
}
