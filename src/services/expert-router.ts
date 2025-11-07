import { nanoid } from 'nanoid';
import { providerDb, modelDb, expertRoutingConfigDb, expertRoutingLogDb } from '../db/index.js';
import { memoryLogger } from './logger.js';
import { decryptApiKey } from '../utils/crypto.js';
import { ExpertRoutingConfig } from '../types/index.js';
import { ExpertTarget } from '../types/expert-routing.js';
import { buildChatCompletionsEndpoint } from '../utils/api-endpoint-builder.js';
import crypto from 'crypto';

// 常量定义
const MAX_CONTEXT_MESSAGES = 3;
const DEFAULT_CLASSIFICATION_TIMEOUT = 10000;
const DEFAULT_MAX_TOKENS = 100;

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

interface ResolvedModel {
  provider?: any;
  providerId?: string;
  modelOverride?: string;
  expertType: 'virtual' | 'real';
  expertName: string;
  expertModelId?: string;
}

interface ClassifierModelResult {
  provider: any;
  model: string;
}

/**
 * 解析分类器模型配置，获取 provider 和 model
 */
async function resolveClassifierModel(
  classifierConfig: ExpertRoutingConfig['classifier']
): Promise<ClassifierModelResult> {
  let provider;
  let model: string;

  if (classifierConfig.type === 'virtual') {
    const virtualModel = await modelDb.getById(classifierConfig.model_id!);
    if (!virtualModel || !virtualModel.provider_id) {
      throw new Error(`Classifier virtual model not found or has no provider: ${classifierConfig.model_id}`);
    }
    provider = await providerDb.getById(virtualModel.provider_id);
    if (!provider) {
      throw new Error('Classifier provider not found');
    }
    model = virtualModel.model_identifier;
  } else {
    provider = await providerDb.getById(classifierConfig.provider_id!);
    if (!provider) {
      throw new Error('Classifier provider not found');
    }
    if (!classifierConfig.model) {
      throw new Error('Classifier model not specified');
    }
    model = classifierConfig.model;
  }

  return { provider, model };
}

/**
 * 解析专家/降级模型配置
 */
async function resolveModelConfig(
  config: { type: 'virtual' | 'real'; model_id?: string; provider_id?: string; model?: string },
  configType: string
): Promise<ResolvedModel> {
  let provider;
  let modelOverride;
  let expertType: 'virtual' | 'real' = config.type;
  let expertName: string;
  let expertModelId: string | undefined;

  if (config.type === 'virtual') {
    const virtualModel = await modelDb.getById(config.model_id!);
    if (!virtualModel) {
      throw new Error(`${configType} virtual model not found: ${config.model_id}`);
    }
    expertModelId = config.model_id;
    expertName = virtualModel.name;
  } else {
    provider = await providerDb.getById(config.provider_id!);
    if (!provider) {
      throw new Error(`${configType} provider not found: ${config.provider_id}`);
    }
    modelOverride = config.model;
    expertName = `${provider.name}/${config.model}`;
  }

  return {
    provider,
    providerId: config.provider_id,
    modelOverride,
    expertType,
    expertName,
    expertModelId,
  };
}

export class ExpertRouter {
  async route(
    request: ProxyRequest,
    expertRoutingId: string,
    context: RoutingContext
  ): Promise<ExpertRoutingResult> {
    const startTime = Date.now();

    const expertRoutingConfig = await expertRoutingConfigDb.getById(expertRoutingId);
    if (!expertRoutingConfig || expertRoutingConfig.enabled !== 1) {
      throw new Error('Expert routing config not found or disabled');
    }

    const config: ExpertRoutingConfig = JSON.parse(expertRoutingConfig.config);

    const messages = request.body?.messages || [];
    if (messages.length === 0) {
      throw new Error('No messages in request');
    }

    let classificationResult;
    try {
      classificationResult = await this.classify(messages, config.classifier);
    } catch (classifyError: any) {
      memoryLogger.error(
        `分类失败: ${classifyError.message}`,
        'ExpertRouter'
      );

      if (config.fallback) {
        memoryLogger.info('分类失败，触发降级策略', 'ExpertRouter');
        return await this.resolveFallback(config.fallback, 'classification_failed', startTime, expertRoutingId, context);
      }

      throw classifyError;
    }

    const expert = this.selectExpert(classificationResult.category, config.experts);
    if (!expert) {
      memoryLogger.warn(
        `未找到匹配的专家: 分类结果="${classificationResult.category}"`,
        'ExpertRouter'
      );

      if (config.fallback) {
        return await this.resolveFallback(config.fallback, classificationResult.category, startTime, expertRoutingId, context);
      }

      throw new Error(`No expert found for category: ${classificationResult.category}`);
    }

    const classificationTime = Date.now() - startTime;

    const result = await this.resolveExpert(
      expert,
      classificationResult.category,
      classificationTime,
      expertRoutingId,
      context,
      request,
      config.classifier,
      classificationResult
    );

    return result;
  }

  private async classify(
    messages: ChatMessage[],
    classifierConfig: ExpertRoutingConfig['classifier']
  ): Promise<{
    category: string;
    classifierRequest: any;
    classifierResponse: any;
  }> {
    let messagesToClassify = messages;

    if (classifierConfig.max_messages_to_classify && classifierConfig.max_messages_to_classify > 0) {
      messagesToClassify = messagesToClassify.slice(-classifierConfig.max_messages_to_classify);
    }

    if (classifierConfig.ignore_system_messages) {
      messagesToClassify = messagesToClassify.filter(m => m.role !== 'system');
    }

    const userMessages = messagesToClassify.filter(m => m.role === 'user');
    if (userMessages.length === 0) {
      throw new Error('No user message found for classification');
    }

    const lastUserMessage = userMessages.at(-1);
    if (!lastUserMessage) {
      throw new Error('No user message found for classification');
    }
    let userPrompt = typeof lastUserMessage.content === 'string'
      ? lastUserMessage.content
      : JSON.stringify(lastUserMessage.content);

    if (classifierConfig.ignored_tags && classifierConfig.ignored_tags.length > 0) {
      userPrompt = this.filterIgnoredTags(userPrompt, classifierConfig.ignored_tags);
    }

    // 构建对话历史上下文
    const conversationContext = this.buildConversationContext(
      messagesToClassify,
      lastUserMessage,
      classifierConfig.ignored_tags
    );

    // 验证模板格式并处理用户提示符
    const { systemMessage, userMessageContent } = this.processPromptTemplate(classifierConfig.prompt_template, userPrompt);

    // 组装完整的用户消息（包含历史和最新输入）
    const userMessageWithHistory = this.assembleUserMessageWithHistory(
      conversationContext,
      userMessageContent
    );

    const classificationRequest: any = {
      messages: [
        { role: 'system', content: systemMessage },
        { role: 'user', content: userMessageWithHistory }
      ],
      temperature: classifierConfig.temperature ?? 0.0
    };

    if (classifierConfig.max_tokens !== 0) {
      classificationRequest.max_tokens = classifierConfig.max_tokens || DEFAULT_MAX_TOKENS;
    }

    // 添加结构化输出支持
    if (classifierConfig.enable_structured_output) {
      classificationRequest.response_format = { type: 'json_object' };
      
      // 确保系统提示词包含 JSON 输出指引
      if (!systemMessage.toLowerCase().includes('json')) {
        memoryLogger.warn(
          '启用结构化输出但系统提示词中未包含 "json" 关键词，可能导致 API 错误',
          'ExpertRouter'
        );
      }
    }

    // 使用提取的函数解析分类器模型
    const { provider, model } = await resolveClassifierModel(classifierConfig);

    const apiKey = decryptApiKey(provider.api_key);
    const endpoint = buildChatCompletionsEndpoint(provider.base_url);

    const fullClassifierRequest = {
      ...classificationRequest,
      model: model
    };

    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(fullClassifierRequest),
        signal: AbortSignal.timeout(classifierConfig.timeout || DEFAULT_CLASSIFICATION_TIMEOUT)
      });
    } catch (fetchError: any) {
      throw new Error(`Classification request failed: ${fetchError.message}`);
    }

    if (!response.ok) {
      let errorDetail = '';
      try {
        const errorBody = await response.text();
        errorDetail = errorBody.length > 200
          ? errorBody.substring(0, 200)
          : errorBody;
      } catch (e) {
        errorDetail = response.statusText;
      }
      throw new Error(`Classification failed: HTTP ${response.status} - ${errorDetail}`);
    }

    const result = await response.json() as any;

    const rawContent = result.choices?.[0]?.message?.content?.trim();
    if (!rawContent) {
      throw new Error('Empty classification result from classifier');
    }

    let category: string;
    try {
      const cleanedContent = this.cleanMarkdownCodeBlock(rawContent);
      const normalizedContent = this.normalizeJsonQuotes(cleanedContent);
      const parsedJson = JSON.parse(normalizedContent);
      category = parsedJson.type;

      if (!category) {
        throw new Error('Missing "type" field in JSON response');
      }
    } catch (parseError: any) {
      memoryLogger.error(
        `分类器返回的内容不是有效的 JSON 格式: ${rawContent}`,
        'ExpertRouter'
      );
      throw new Error(
        `Classifier must return valid JSON format with "type" field. ` +
        `Expected: {"type": "category_name"}. ` +
        `Received: ${rawContent.substring(0, 100)}${rawContent.length > 100 ? '...' : ''}`
      );
    }

    return {
      category,
      classifierRequest: fullClassifierRequest,
      classifierResponse: result
    };
  }

  private selectExpert(
    category: string,
    experts: ExpertTarget[]
  ): ExpertTarget | null {
    const normalizedCategory = category.trim().toLowerCase();

    const exactMatch = experts.find(
      e => e.category.trim().toLowerCase() === normalizedCategory
    );

    if (exactMatch) {
      memoryLogger.debug(
        `专家匹配成功: 分类="${category}" → 专家="${exactMatch.category}"`,
        'ExpertRouter'
      );
      return exactMatch;
    }

    const partialMatch = experts.find(
      e => {
        const expertCategory = e.category.trim().toLowerCase();
        return normalizedCategory.includes(expertCategory) || expertCategory.includes(normalizedCategory);
      }
    );

    if (partialMatch) {
      memoryLogger.debug(
        `专家部分匹配成功: 分类="${category}" → 专家="${partialMatch.category}"`,
        'ExpertRouter'
      );
      return partialMatch;
    }

    memoryLogger.warn(
      `未找到匹配的专家: 分类="${category}" | 可用专家: ${experts.map(e => e.category).join(', ')}`,
      'ExpertRouter'
    );

    return null;
  }

  private async resolveExpert(
    expert: ExpertTarget,
    category: string,
    classificationTime: number,
    expertRoutingId: string,
    context: RoutingContext,
    request: ProxyRequest,
    classifierConfig: ExpertRoutingConfig['classifier'],
    classificationResult: {
      category: string;
      classifierRequest: any;
      classifierResponse: any;
    }
  ): Promise<ExpertRoutingResult> {
    const resolved = await resolveModelConfig(expert, 'Expert');

    const requestHash = this.generateRequestHash(request);

    // 使用统一的分类器模型名称生成逻辑
    const classifierModelName = this.generateClassifierModelName(classifierConfig);

    await expertRoutingLogDb.create({
      id: nanoid(),
      virtual_key_id: context.virtualKeyId || null,
      expert_routing_id: expertRoutingId,
      request_hash: requestHash,
      classifier_model: classifierModelName,
      classification_result: category,
      selected_expert_id: expert.id,
      selected_expert_type: expert.type,
      selected_expert_name: resolved.expertName,
      classification_time: classificationTime,
      original_request: JSON.stringify(request.body?.messages || []),
      classifier_request: JSON.stringify(classificationResult.classifierRequest),
      classifier_response: JSON.stringify(classificationResult.classifierResponse),
    });

    return {
      provider: resolved.provider!,
      providerId: expert.provider_id!,
      modelOverride: resolved.modelOverride,
      category,
      expert,
      classificationTime,
      expertType: resolved.expertType,
      expertName: resolved.expertName,
      expertModelId: resolved.expertModelId,
    };
  }

  private async resolveFallback(
    fallback: ExpertRoutingConfig['fallback'],
    category: string,
    startTime: number,
    _expertRoutingId: string,
    _context: RoutingContext
  ): Promise<ExpertRoutingResult> {
    if (!fallback) {
      throw new Error('No fallback configured');
    }

    const resolved = await resolveModelConfig(fallback, 'Fallback');
    const classificationTime = Date.now() - startTime;

    return {
      provider: resolved.provider!,
      providerId: fallback.provider_id!,
      modelOverride: resolved.modelOverride,
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
      expertType: resolved.expertType,
      expertName: resolved.expertName,
      expertModelId: resolved.expertModelId,
    };
  }

  private generateRequestHash(request: ProxyRequest): string {
    const messages = request.body?.messages || [];
    const content = JSON.stringify(messages);
    return crypto.createHash('md5').update(content).digest('hex');
  }

  private cleanMarkdownCodeBlock(content: string): string {
    let cleaned = content.trim();

    const jsonBlockPattern = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;
    const match = cleaned.match(jsonBlockPattern);

    if (match) {
      cleaned = match[1].trim();
    }

    return cleaned;
  }

  private normalizeJsonQuotes(content: string): string {
    return content.replace(/'/g, '"');
  }

  private filterIgnoredTags(text: string, ignoredTags: string[]): string {
    let filteredText = text;

    for (const tag of ignoredTags) {
      const tagName = tag.trim();
      if (!tagName) continue;

      const openTag = `<${tagName}>`;
      const closeTag = `</${tagName}>`;
      const regex = new RegExp(`${this.escapeRegex(openTag)}[\\s\\S]*?${this.escapeRegex(closeTag)}`, 'g');

      filteredText = filteredText.replace(regex, '').trim();
    }

    return filteredText.trim();
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * 生成分类器模型名称（用于日志记录）
   */
  private generateClassifierModelName(classifierConfig: ExpertRoutingConfig['classifier']): string {
    if (classifierConfig.type === 'virtual') {
      return classifierConfig.model_id!;
    } else {
      return `${classifierConfig.provider_id}/${classifierConfig.model}`;
    }
  }

  /**
   * 处理提示词模板，分离系统消息和用户消息
   */
  private processPromptTemplate(promptTemplate: string, userPrompt: string): {
    systemMessage: string;
    userMessageContent: string;
  } {
    // 检查是否包含用户提示符标记
    const userPromptMarkers = [
      '---\nUser Prompt:\n{{USER_PROMPT}}\n---',
      '---\nUser Prompt:\n{{user_prompt}}\n---',
      '{{USER_PROMPT}}',
      '{{user_prompt}}'
    ];

    for (const marker of userPromptMarkers) {
      if (promptTemplate.includes(marker)) {
        const parts = promptTemplate.split(marker);

        if (parts.length !== 2) {
          throw new Error(`Invalid prompt template format: marker "${marker}" appears ${parts.length - 1} times, expected exactly once`);
        }

        const systemMessage = parts[0].trim();

        if (!systemMessage) {
          throw new Error(`Invalid prompt template format: marker "${marker}" is at the beginning, no system message found`);
        }

        return {
          systemMessage: systemMessage,
          userMessageContent: userPrompt
        };
      }
    }

    // 如果没有找到标记，假设整个模板都是系统消息
    memoryLogger.warn(
      'No user prompt marker found in template, treating entire template as system message',
      'ExpertRouter'
    );
    
    return {
      systemMessage: promptTemplate.trim(),
      userMessageContent: userPrompt
    };
  }

  /**
   * 构建对话历史上下文
   * @param messages 待分类的消息列表
   * @param lastUserMessage 最后一条用户消息
   * @param ignoredTags 需要过滤的标签列表
   * @returns 格式化的对话历史字符串
   */
  private buildConversationContext(
    messages: ChatMessage[],
    lastUserMessage: ChatMessage,
    ignoredTags?: string[]
  ): string {
    const lastUserIndex = messages.lastIndexOf(lastUserMessage);
    
    // 如果最后一条用户消息是第一条消息，则没有历史
    if (lastUserIndex <= 0) {
      return '';
    }

    // 提取历史消息（最多 MAX_CONTEXT_MESSAGES * 2 条，包含用户和助手消息）
    const startIndex = Math.max(0, lastUserIndex - MAX_CONTEXT_MESSAGES * 2);
    const contextMessages = messages.slice(startIndex, lastUserIndex);

    if (contextMessages.length === 0) {
      return '';
    }

    // 格式化历史消息
    const formattedMessages = contextMessages.map((msg, index) => {
      let content = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);

      // 过滤忽略的标签
      if (ignoredTags && ignoredTags.length > 0) {
        content = this.filterIgnoredTags(content, ignoredTags);
      }

      // 确定角色标签
      const roleLabel = this.getRoleLabel(msg.role);
      
      // 添加序号以便追踪对话顺序
      const messageNumber = index + 1;
      
      return `[${messageNumber}] ${roleLabel}: ${content}`;
    });

    // 构建完整的历史上下文
    return [
      '# Conversation History (for context)',
      ...formattedMessages,
      ''
    ].join('\n');
  }

  /**
   * 组装包含历史的完整用户消息
   * @param conversationContext 对话历史上下文
   * @param currentUserPrompt 当前用户输入
   * @returns 完整的用户消息
   */
  private assembleUserMessageWithHistory(
    conversationContext: string,
    currentUserPrompt: string
  ): string {
    if (!conversationContext) {
      return currentUserPrompt;
    }

    return [
      conversationContext.trim(),
      '',
      '---',
      'Latest User Prompt:',
      currentUserPrompt
    ].join('\n');
  }

  /**
   * 获取角色标签
   * @param role 消息角色
   * @returns 格式化的角色标签
   */
  private getRoleLabel(role: string): string {
    const roleMap: Record<string, string> = {
      'user': 'User',
      'assistant': 'Assistant',
      'system': 'System'
    };

    return roleMap[role.toLowerCase()] || role;
  }
}

export const expertRouter = new ExpertRouter();

