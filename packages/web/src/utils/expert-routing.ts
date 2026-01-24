import type { ClassifierConfig, CreateExpertRoutingRequest } from '@/api/expert-routing';

export function createDefaultClassifierConfig(): ClassifierConfig {
  return {
    type: 'real',
    prompt_template: '{{USER_PROMPT}}',
    system_prompt: `You are an intelligent router for an LLM gateway system. Your task is to analyze the user's request and route it to the most suitable expert model based on their specific capabilities and boundaries.

### Task
Analyze the user request and classify it into ONE of the available expert categories.
Select the expert whose capabilities and boundaries best match the intent and complexity of the request.

### Output Format
You must return a strictly valid JSON object. Do not add any markdown formatting or explanation outside the JSON.
Format:
{
  "category": "The exact category name from the list above",
  "reason": "A brief explanation (1-2 sentences) citing specific boundaries or capabilities that matched"
}

### Fallback Rules
- If the request exactly matches an expert's boundary, choose that expert.
- If the request is ambiguous but leans towards a specific domain, choose the relevant expert.
- If the request is completely outside all expert boundaries, use "fallback" (if available) or the most general expert.`,
    max_tokens: 200,
    temperature: 0.1,
    timeout: 10000,
    ignore_system_messages: false,
    max_messages_to_classify: 0,
    enable_structured_output: true
  };
}

export function createDefaultExpertRoutingConfig(): CreateExpertRoutingRequest {
  return {
    name: '',
    description: '',
    enabled: true,
    classifier: createDefaultClassifierConfig(),
    experts: [],
  };
}

