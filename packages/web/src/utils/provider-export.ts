import i18n from '@/i18n';
import type { Provider } from '@/types';

export interface ProviderExportData {
  version: string;
  exportTime: string;
  providers: Array<{
    id: string;
    name: string;
    description?: string;
    baseUrl: string;
    enabled: boolean;
    category?: string;
  }>;
}

export function exportProviders(providers: Provider[]): ProviderExportData {
  const exportData: ProviderExportData = {
    version: '1.0.0',
    exportTime: new Date().toISOString(),
    providers: providers.map(provider => ({
      id: provider.id,
      name: provider.name,
      description: provider.description || undefined,
      baseUrl: provider.baseUrl,
      enabled: provider.enabled,
    })),
  };

  return exportData;
}

export function downloadProvidersConfig(providers: Provider[], filename?: string) {
  const exportData = exportProviders(providers)
  const jsonString = JSON.stringify(exportData, null, 2)
  const blob = new Blob([jsonString], { type: 'application/json' })

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename || `providers-config-${new Date().toISOString().split('T')[0]}.json`
  a.click()

  URL.revokeObjectURL(url)
}

export function validateImportData(data: any): {
  isValid: boolean;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];
  const t = i18n.global.t;

  if (!data || typeof data !== 'object') {
    errors.push(t('providers.importInvalidFormat'));
    return { isValid: false, errors, warnings };
  }

  if (!data.version) {
    warnings.push(t('providers.importMissingVersion'));
  }

  if (!Array.isArray(data.providers)) {
    errors.push(t('providers.importMissingProviders'));
    return { isValid: false, errors, warnings };
  }

  data.providers.forEach((provider: any, index: number) => {
    const prefix = t('providers.importProviderPrefix', { index: index + 1 });

    if (!provider.id || typeof provider.id !== 'string') {
      errors.push(t('providers.importMissingId', { prefix }));
    }

    if (!provider.name || typeof provider.name !== 'string') {
      errors.push(t('providers.importMissingName', { prefix }));
    }

    if (!provider.baseUrl || typeof provider.baseUrl !== 'string') {
      errors.push(t('providers.importMissingBaseUrl', { prefix }));
    } else {
      try {
        new URL(provider.baseUrl);
      } catch {
        errors.push(t('providers.importInvalidBaseUrl', { prefix }));
      }
    }

    if (typeof provider.enabled !== 'boolean') {
      warnings.push(t('providers.importEnabledFallback', { prefix }));
    }
  });

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

export function parseImportFile(file: File): Promise<{
  data: ProviderExportData | null;
  validation: ReturnType<typeof validateImportData>;
}> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const data = JSON.parse(content);
        const validation = validateImportData(data);
        
        resolve({
          data: validation.isValid ? data : null,
          validation,
        });
      } catch (error) {
        resolve({
          data: null,
          validation: {
            isValid: false,
            errors: [i18n.global.t('providers.importInvalidJson')],
            warnings: [],
          },
        });
      }
    };

    reader.onerror = () => {
      resolve({
        data: null,
        validation: {
          isValid: false,
          errors: [i18n.global.t('providers.importReadFailed')],
          warnings: [],
        },
      });
    };

    reader.readAsText(file);
  });
}

export function convertImportDataToProviders(data: ProviderExportData): Array<{
  id: string;
  name: string;
  description?: string;
  baseUrl: string;
  enabled: boolean;
  needsApiKey: boolean;
  category?: string;
}> {
  return data.providers.map(provider => ({
    id: provider.id,
    name: provider.name,
    description: provider.description,
    baseUrl: provider.baseUrl,
    enabled: provider.enabled ?? true,
    needsApiKey: true, // 导入的提供商都需要重新设置 API Key
    category: provider.category,
  }));
}

export function generateConfigSummary(data: ProviderExportData): {
  totalProviders: number;
  enabledProviders: number;
  categories: Record<string, number>;
} {
  const summary = {
    totalProviders: data.providers.length,
    enabledProviders: data.providers.filter(p => p.enabled).length,
    categories: {} as Record<string, number>,
  };

  data.providers.forEach(provider => {
    if (provider.category) {
      summary.categories[provider.category] = (summary.categories[provider.category] || 0) + 1;
    }
  });

  return summary;
}
