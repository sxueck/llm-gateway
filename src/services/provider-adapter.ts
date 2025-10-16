interface ProviderConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
}

interface ProviderAdapter {
  normalizeBaseUrl(baseUrl: string): string;
  getProviderType(baseUrl: string): string;
}

abstract class BaseAdapter implements ProviderAdapter {
  normalizeBaseUrl(baseUrl: string): string {
    let normalized = baseUrl.trim().replace(/\/+$/, '');
    normalized = normalized.replace(/\/v1$/, '');
    return normalized;
  }

  abstract getProviderType(baseUrl: string): string;
}

class GoogleGeminiAdapter implements ProviderAdapter {
  normalizeBaseUrl(baseUrl: string): string {
    let normalized = baseUrl.trim();

    if (normalized.includes('generativelanguage.googleapis.com')) {
      normalized = normalized.replace(/\/+$/, '');

      if (normalized.endsWith('/v1beta/openai')) {
        return normalized + '/';
      }

      if (normalized.endsWith('/v1beta')) {
        return normalized + '/openai/';
      }

      if (!normalized.includes('/openai')) {
        return normalized + '/v1beta/openai/';
      }
    }

    return normalized;
  }

  getProviderType(baseUrl: string): string {
    return 'google';
  }
}

class OpenAICompatibleAdapter extends BaseAdapter {
  getProviderType(baseUrl: string): string {
    const url = baseUrl.toLowerCase();

    if (url.includes('api.deepseek.com')) {
      return 'openai';
    }
    if (url.includes('api.openai.com')) {
      return 'openai';
    }

    return 'openai';
  }
}

class AnthropicAdapter extends BaseAdapter {
  getProviderType(baseUrl: string): string {
    return 'anthropic';
  }
}

export class ProviderAdapterFactory {
  private static readonly googleAdapter = new GoogleGeminiAdapter();
  private static readonly anthropicAdapter = new AnthropicAdapter();
  private static readonly openaiAdapter = new OpenAICompatibleAdapter();

  static getAdapter(baseUrl: string): ProviderAdapter {
    if (!baseUrl) {
      return this.openaiAdapter;
    }

    const url = baseUrl.toLowerCase();

    if (
      url.includes('generativelanguage.googleapis.com') ||
      url.includes('gemini')
    ) {
      return this.googleAdapter;
    }

    if (
      url.includes('api.anthropic.com') ||
      url.includes('anthropic')
    ) {
      return this.anthropicAdapter;
    }

    return this.openaiAdapter;
  }

  static normalizeProviderConfig(config: ProviderConfig): ProviderConfig {
    const adapter = this.getAdapter(config.baseUrl);
    return {
      ...config,
      baseUrl: adapter.normalizeBaseUrl(config.baseUrl),
      provider: adapter.getProviderType(config.baseUrl),
    };
  }
}

