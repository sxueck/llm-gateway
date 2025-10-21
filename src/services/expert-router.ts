import { nanoid } from 'nanoid';
import { providerDb, modelDb, expertRoutingConfigDb, expertRoutingLogDb } from '../db/index.js';
import { memoryLogger } from './logger.js';
import { decryptApiKey } from '../utils/crypto.js';
import { ExpertRoutingConfig, ExpertTarget } from '../types/index.js';
import crypto from 'crypto';

interface ChatMessage {
  role: string;
  content: string | any;
}

interface ProxyRequest {
  body?: {
    messages?: ChatMessage[];
    model?: string;
    [key: string]: any;
  };
  [key: string]: any;
}

interface RoutingContext {
  modelId?: string;
  virtualKeyId?: string;
}

interface ExpertRoutingResult {
  provider: any;
  providerId: string;
  modelOverride?: string;
  category: string;
  expert: ExpertTarget;
  classificationTime: number;
  expertType: 'virtual' | 'real';
  expertName: string;
  expertModelId?: string;
}

export class ExpertRouter {
  async route(
    request: ProxyRequest,
    expertRoutingId: string,
    context: RoutingContext
  ): Promise<ExpertRoutingResult> {
    const startTime = Date.now();

    const expertRoutingConfig = expertRoutingConfigDb.getById(expertRoutingId);
    if (!expertRoutingConfig || expertRoutingConfig.enabled !== 1) {
      throw new Error('Expert routing config not found or disabled');
    }

    const config: ExpertRoutingConfig = JSON.parse(expertRoutingConfig.config);

    const messages = request.body?.messages || [];
    if (messages.length === 0) {
      throw new Error('No messages in request');
    }

    const category = await this.classify(messages, config.classifier);

    const expert = this.selectExpert(category, config.experts);
    if (!expert) {
      memoryLogger.warn(
        `未找到匹配的专家: 分类结果="${category}"`,
        'ExpertRouter'
      );

      if (config.fallback) {
        return await this.resolveFallback(config.fallback, category, startTime, expertRoutingId, context);
      }

      throw new Error(`No expert found for category: ${category}`);
    }

    const classificationTime = Date.now() - startTime;

    const result = await this.resolveExpert(expert, category, classificationTime, expertRoutingId, context, request);

    return result;
  }

  private async classify(
    messages: ChatMessage[],
    classifierConfig: ExpertRoutingConfig['classifier']
  ): Promise<string> {
    const lastUserMessage = messages
      .filter(m => m.role === 'user')
      .pop();

    if (!lastUserMessage) {
      throw new Error('No user message found for classification');
    }

    const userPrompt = typeof lastUserMessage.content === 'string'
      ? lastUserMessage.content
      : JSON.stringify(lastUserMessage.content);

    const classificationPrompt = classifierConfig.prompt_template
      .replace('{{user_prompt}}', userPrompt);

    const classificationRequest = {
      messages: [
        { role: 'user', content: classificationPrompt }
      ],
      max_tokens: classifierConfig.max_tokens || 50,
      temperature: classifierConfig.temperature ?? 0.0
    };

    let provider;
    let model;

    if (classifierConfig.type === 'virtual') {
      const virtualModel = modelDb.getById(classifierConfig.model_id!);
      if (!virtualModel || !virtualModel.provider_id) {
        throw new Error(`Classifier virtual model not found or has no provider: ${classifierConfig.model_id}`);
      }
      provider = providerDb.getById(virtualModel.provider_id);
      model = virtualModel.model_identifier;
    } else {
      provider = providerDb.getById(classifierConfig.provider_id!);
      model = classifierConfig.model;
    }

    if (!provider) {
      throw new Error(`Classifier provider not found`);
    }

    const apiKey = decryptApiKey(provider.api_key);
    const baseUrl = provider.base_url || '';
    const endpoint = `${baseUrl}/v1/chat/completions`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ...classificationRequest,
        model: model
      }),
      signal: AbortSignal.timeout(classifierConfig.timeout || 10000)
    });

    if (!response.ok) {
      throw new Error(`Classification failed: HTTP ${response.status}`);
    }

    const result = await response.json();

    const category = result.choices?.[0]?.message?.content?.trim();
    if (!category) {
      throw new Error('Empty classification result');
    }

    memoryLogger.debug(
      `分类完成: ${category} | 模型: ${model}`,
      'ExpertRouter'
    );

    return category;
  }

  private selectExpert(
    category: string,
    experts: ExpertTarget[]
  ): ExpertTarget | null {
    const exactMatch = experts.find(
      e => e.category === category
    );

    if (exactMatch) {
      memoryLogger.debug(
        `专家匹配成功: 分类="${category}" → 专家="${exactMatch.category}"`,
        'ExpertRouter'
      );
      return exactMatch;
    }

    return null;
  }

  private async resolveExpert(
    expert: ExpertTarget,
    category: string,
    classificationTime: number,
    expertRoutingId: string,
    context: RoutingContext,
    request: ProxyRequest
  ): Promise<ExpertRoutingResult> {
    let provider;
    let modelOverride;
    let expertType: 'virtual' | 'real' = expert.type;
    let expertName: string;
    let expertModelId: string | undefined;

    if (expert.type === 'virtual') {
      const virtualModel = modelDb.getById(expert.model_id!);
      if (!virtualModel) {
        throw new Error(`Expert virtual model not found: ${expert.model_id}`);
      }
      expertModelId = expert.model_id;
      expertName = virtualModel.name;
    } else {
      provider = providerDb.getById(expert.provider_id!);
      if (!provider) {
        throw new Error(`Expert provider not found: ${expert.provider_id}`);
      }
      modelOverride = expert.model;
      expertName = `${provider.name}/${expert.model}`;
    }

    const requestHash = this.generateRequestHash(request);

    await expertRoutingLogDb.create({
      id: nanoid(),
      virtual_key_id: context.virtualKeyId || null,
      expert_routing_id: expertRoutingId,
      request_hash: requestHash,
      classifier_model: expert.type === 'virtual' ? expert.model_id! : `${expert.provider_id}/${expert.model}`,
      classification_result: category,
      selected_expert_id: expert.id,
      selected_expert_type: expert.type,
      selected_expert_name: expertName,
      classification_time: classificationTime,
    });

    return {
      provider: provider!,
      providerId: expert.provider_id!,
      modelOverride,
      category,
      expert,
      classificationTime,
      expertType,
      expertName,
      expertModelId,
    };
  }

  private async resolveFallback(
    fallback: ExpertRoutingConfig['fallback'],
    category: string,
    startTime: number,
    expertRoutingId: string,
    context: RoutingContext
  ): Promise<ExpertRoutingResult> {
    if (!fallback) {
      throw new Error('No fallback configured');
    }

    let provider;
    let modelOverride;
    let expertType: 'virtual' | 'real' = fallback.type;
    let expertName: string;
    let expertModelId: string | undefined;

    if (fallback.type === 'virtual') {
      const virtualModel = modelDb.getById(fallback.model_id!);
      if (!virtualModel) {
        throw new Error(`Fallback virtual model not found: ${fallback.model_id}`);
      }
      expertModelId = fallback.model_id;
      expertName = virtualModel.name;
    } else {
      provider = providerDb.getById(fallback.provider_id!);
      if (!provider) {
        throw new Error(`Fallback provider not found: ${fallback.provider_id}`);
      }
      modelOverride = fallback.model;
      expertName = `${provider.name}/${fallback.model}`;
    }

    const classificationTime = Date.now() - startTime;

    return {
      provider: provider!,
      providerId: fallback.provider_id!,
      modelOverride,
      category,
      expert: {
        id: 'fallback',
        category: 'fallback',
        type: fallback.type,
        model_id: fallback.model_id,
        provider_id: fallback.provider_id,
        model: fallback.model,
        description: 'Fallback expert',
      },
      classificationTime,
      expertType,
      expertName,
      expertModelId,
    };
  }

  private generateRequestHash(request: ProxyRequest): string {
    const messages = request.body?.messages || [];
    const content = JSON.stringify(messages);
    return crypto.createHash('md5').update(content).digest('hex');
  }
}

export const expertRouter = new ExpertRouter();

