const MAX_BODY_LENGTH = 10000;
const MAX_STRING_LENGTH = 1000;

function truncateStringsRecursively(obj, maxLength = MAX_STRING_LENGTH) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    return obj.length > maxLength ? obj.substring(0, maxLength) + '...[truncated]' : obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => truncateStringsRecursively(item, maxLength));
  }
  if (typeof obj === 'object') {
    const result = {};
    for (const key in obj) {
      if (obj.hasOwnProperty(key)) {
        result[key] = truncateStringsRecursively(obj[key], maxLength);
      }
    }
    return result;
  }
  return obj;
}

function truncateRequestBody(body) {
  if (!body) return '';
  try {
    const parsed = typeof body === 'string' ? JSON.parse(body) : body;
    const truncated = {};
    for (const key in parsed) {
      if (key === 'tools') {
        truncated.tools = Array.isArray(parsed.tools)
          ? `[${parsed.tools.length} 个工具定义]`
          : parsed.tools;
      } else if (key === 'functions') {
        truncated.functions = Array.isArray(parsed.functions)
          ? `[${parsed.functions.length} 个函数定义]`
          : parsed.functions;
      } else {
        truncated[key] = truncateStringsRecursively(parsed[key]);
      }
    }
    const result = JSON.stringify(truncated);
    return result.length <= MAX_BODY_LENGTH
      ? result
      : result.substring(0, MAX_BODY_LENGTH) + '...[truncated]';
  } catch (e) {
    console.error('Error:', e.message);
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    return bodyStr.substring(0, MAX_BODY_LENGTH) + '...[truncated]';
  }
}

// Test with a body similar to what's in the database
const testBody = {
  model: 'claude-sonnet-4-5-20250929',
  max_tokens: 8192,
  temperature: 0.9,
  system: [{
    text: 'x'.repeat(50000) // Very long system prompt
  }]
};

const result = truncateRequestBody(testBody);
console.log('=== Test Results ===');
console.log('Original system[0].text length:', testBody.system[0].text.length);
console.log('Final result length:', result.length);
console.log('Expected max length:', MAX_BODY_LENGTH);
console.log('Is correctly truncated?', result.length <= MAX_BODY_LENGTH);
console.log('\n=== First 200 chars of result ===');
console.log(result.substring(0, 200));
console.log('\n=== Last 100 chars of result ===');
console.log(result.substring(result.length - 100));
