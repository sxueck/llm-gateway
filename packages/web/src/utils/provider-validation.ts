import i18n from '@/i18n';

const t = i18n.global.t;

export function validateProviderId(id: string): {
  isValid: boolean;
  message?: string;
} {
  if (!id || id.trim() === '') {
    return {
      isValid: false,
      message: t('providers.idEmpty'),
    };
  }

  const formatRegex = /^[a-z0-9-]+$/;
  if (!formatRegex.test(id)) {
    return {
      isValid: false,
      message: t('providers.idCharset'),
    };
  }

  if (id.startsWith('-') || id.endsWith('-')) {
    return {
      isValid: false,
      message: t('providers.idHyphenEdge'),
    };
  }

  if (id.includes('--')) {
    return {
      isValid: false,
      message: t('providers.idDoubleHyphen'),
    };
  }

  if (id.length < 2 || id.length > 50) {
    return {
      isValid: false,
      message: t('providers.idLength'),
    };
  }

  return {
    isValid: true,
  };
}

export function validateBaseUrl(url: string): {
  isValid: boolean;
  message?: string;
} {
  if (!url || url.trim() === '') {
    return {
      isValid: false,
      message: t('providers.baseUrlEmpty'),
    };
  }

  try {
    const urlObj = new URL(url);
    
    if (urlObj.protocol !== 'https:' && urlObj.protocol !== 'http:') {
      return {
        isValid: false,
        message: t('providers.baseUrlProtocol'),
      };
    }

    if (!urlObj.hostname) {
      return {
        isValid: false,
        message: t('providers.baseUrlHost'),
      };
    }

    return {
      isValid: true,
    };
  } catch (error) {
    return {
      isValid: false,
      message: t('providers.baseUrlInvalid'),
    };
  }
}

export function validateApiKey(apiKey: string, providerId?: string): {
  isValid: boolean;
  message?: string;
} {
  if (!apiKey || apiKey.trim() === '') {
    return {
      isValid: false,
      message: t('providers.apiKeyEmpty'),
    };
  }

  if (apiKey.length < 10) {
    return {
      isValid: false,
      message: t('providers.apiKeyShort'),
    };
  }

  if (providerId) {
    switch (providerId) {
      case 'openai':
      case 'azure-openai':
        if (!apiKey.startsWith('sk-')) {
          return {
            isValid: false,
            message: t('providers.apiKeyOpenAI'),
          };
        }
        break;
      case 'anthropic':
        if (!apiKey.startsWith('sk-ant-')) {
          return {
            isValid: false,
            message: t('providers.apiKeyAnthropic'),
          };
        }
        break;
      case 'deepseek':
        if (!apiKey.startsWith('sk-')) {
          return {
            isValid: false,
            message: t('providers.apiKeyDeepSeek'),
          };
        }
        break;
    }
  }

  return {
    isValid: true,
  };
}
