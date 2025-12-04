/**
 * Gemini 原生协议透传测试脚本
 * 
 * 使用方法：
 * 1. 确保已配置好 Provider 和虚拟密钥
 * 2. 设置环境变量 GATEWAY_URL 和 VIRTUAL_KEY
 * 3. 运行: npx tsx scripts/test-gemini-native.ts
 */

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:3000';
const VIRTUAL_KEY = process.env.VIRTUAL_KEY || '';

if (!VIRTUAL_KEY) {
  console.error('❌ 请设置环境变量 VIRTUAL_KEY');
  process.exit(1);
}

interface TestResult {
  name: string;
  success: boolean;
  duration: number;
  error?: string;
  response?: any;
}

const results: TestResult[] = [];

async function testEndpoint(
  name: string,
  method: string,
  path: string,
  body?: any
): Promise<TestResult> {
  const startTime = Date.now();
  
  try {
    console.log(`\n🧪 测试: ${name}`);
    console.log(`   ${method} ${GATEWAY_URL}${path}`);
    
    const options: RequestInit = {
      method,
      headers: {
        'Authorization': `Bearer ${VIRTUAL_KEY}`,
        'Content-Type': 'application/json',
      },
    };

    if (body) {
      options.body = JSON.stringify(body);
      console.log(`   请求体: ${JSON.stringify(body, null, 2).substring(0, 200)}...`);
    }

    const response = await fetch(`${GATEWAY_URL}${path}`, options);
    const duration = Date.now() - startTime;
    
    const contentType = response.headers.get('content-type') || '';
    let responseData: any;

    if (contentType.includes('application/json')) {
      responseData = await response.json();
    } else {
      responseData = await response.text();
    }

    if (response.ok) {
      console.log(`   ✅ 成功 (${response.status}) - ${duration}ms`);
      console.log(`   响应: ${JSON.stringify(responseData, null, 2).substring(0, 300)}...`);
      
      return {
        name,
        success: true,
        duration,
        response: responseData,
      };
    } else {
      console.log(`   ❌ 失败 (${response.status}) - ${duration}ms`);
      console.log(`   错误: ${JSON.stringify(responseData, null, 2)}`);
      
      return {
        name,
        success: false,
        duration,
        error: JSON.stringify(responseData),
      };
    }
  } catch (error: any) {
    const duration = Date.now() - startTime;
    console.log(`   ❌ 异常 - ${duration}ms`);
    console.log(`   错误: ${error.message}`);
    
    return {
      name,
      success: false,
      duration,
      error: error.message,
    };
  }
}

async function testStreamEndpoint(
  name: string,
  path: string,
  body: any
): Promise<TestResult> {
  const startTime = Date.now();
  
  try {
    console.log(`\n🧪 测试: ${name} (流式)`);
    console.log(`   POST ${GATEWAY_URL}${path}`);
    
    const response = await fetch(`${GATEWAY_URL}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VIRTUAL_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('无法读取响应流');
    }

    const decoder = new TextDecoder();
    let chunks = 0;
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      chunks++;
      totalBytes += value.length;
      
      const chunk = decoder.decode(value, { stream: true });
      if (chunks <= 3) {
        console.log(`   📦 Chunk ${chunks}: ${chunk.substring(0, 100)}...`);
      }
    }

    const duration = Date.now() - startTime;
    console.log(`   ✅ 流式完成 - ${duration}ms | chunks: ${chunks} | bytes: ${totalBytes}`);

    return {
      name,
      success: true,
      duration,
      response: { chunks, totalBytes },
    };
  } catch (error: any) {
    const duration = Date.now() - startTime;
    console.log(`   ❌ 流式失败 - ${duration}ms`);
    console.log(`   错误: ${error.message}`);
    
    return {
      name,
      success: false,
      duration,
      error: error.message,
    };
  }
}

async function runTests() {
  console.log('='.repeat(60));
  console.log('🚀 Gemini 原生协议透传测试');
  console.log('='.repeat(60));
  console.log(`网关地址: ${GATEWAY_URL}`);
  console.log(`虚拟密钥: ${VIRTUAL_KEY.substring(0, 10)}...`);

  // 测试 1: 获取模型列表
  results.push(await testEndpoint(
    '获取模型列表',
    'GET',
    '/v1beta/models'
  ));

  // 测试 2: 获取特定模型信息
  results.push(await testEndpoint(
    '获取模型信息',
    'GET',
    '/v1beta/models/gemini-1.5-pro'
  ));

  // 测试 3: 非流式生成内容
  results.push(await testEndpoint(
    '非流式生成内容',
    'POST',
    '/v1beta/models/gemini-1.5-pro:generateContent',
    {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: '用一句话解释什么是人工智能'
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 100
      }
    }
  ));

  // 测试 4: Token 计数
  results.push(await testEndpoint(
    'Token 计数',
    'POST',
    '/v1beta/models/gemini-1.5-pro:countTokens',
    {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: '这是一段测试文本，用于计算 token 数量。'
            }
          ]
        }
      ]
    }
  ));

  // 测试 5: 流式生成内容
  results.push(await testStreamEndpoint(
    '流式生成内容',
    '/v1beta/models/gemini-1.5-pro:streamGenerateContent',
    {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: '写一首关于春天的短诗'
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.9,
        maxOutputTokens: 200
      }
    }
  ));

  // 打印测试总结
  console.log('\n' + '='.repeat(60));
  console.log('📊 测试总结');
  console.log('='.repeat(60));

  const successful = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const totalDuration = results.reduce((sum, r) => sum + r.duration, 0);

  console.log(`\n总测试数: ${results.length}`);
  console.log(`✅ 成功: ${successful}`);
  console.log(`❌ 失败: ${failed}`);
  console.log(`⏱️  总耗时: ${totalDuration}ms`);
  console.log(`📈 平均耗时: ${Math.round(totalDuration / results.length)}ms`);

  console.log('\n详细结果:');
  results.forEach((result, index) => {
    const status = result.success ? '✅' : '❌';
    console.log(`${index + 1}. ${status} ${result.name} - ${result.duration}ms`);
    if (result.error) {
      console.log(`   错误: ${result.error.substring(0, 100)}...`);
    }
  });

  if (failed === 0) {
    console.log('\n🎉 所有测试通过！');
  } else {
    console.log(`\n⚠️  有 ${failed} 个测试失败，请检查配置和日志`);
  }

  console.log('='.repeat(60));
}

// 运行测试
runTests().catch(error => {
  console.error('测试执行失败:', error);
  process.exit(1);
});