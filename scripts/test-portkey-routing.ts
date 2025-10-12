import { portkeyRouter } from '../src/services/portkey-router.js';
import { portkeyGatewayDb, modelRoutingRuleDb } from '../src/db/index.js';
import { nanoid } from 'nanoid';

async function testPortkeyRouting() {
  console.log('='.repeat(60));
  console.log('Portkey 路由测试');
  console.log('='.repeat(60));

  console.log('\n1. 创建测试网关...');
  const gateway1 = await portkeyGatewayDb.create({
    id: nanoid(),
    name: 'US Gateway',
    url: 'http://localhost:8787',
    description: '美国地区网关',
    is_default: 1,
    enabled: 1,
  });
  console.log(`✓ 创建默认网关: ${gateway1!.name}`);

  const gateway2 = await portkeyGatewayDb.create({
    id: nanoid(),
    name: 'CN Gateway',
    url: 'http://localhost:8788',
    description: '中国地区网关',
    is_default: 0,
    enabled: 1,
  });
  console.log(`✓ 创建中国网关: ${gateway2!.name}`);

  console.log('\n2. 创建路由规则...');
  const rule1 = await modelRoutingRuleDb.create({
    id: nanoid(),
    name: 'GPT-4 to US',
    portkey_gateway_id: gateway1!.id,
    rule_type: 'model_name',
    rule_value: 'gpt-4*',
    priority: 100,
    enabled: 1,
  });
  console.log(`✓ 创建规则: ${rule1!.name} (${rule1!.rule_type}:${rule1!.rule_value})`);

  const rule2 = await modelRoutingRuleDb.create({
    id: nanoid(),
    name: 'DeepSeek to CN',
    portkey_gateway_id: gateway2!.id,
    rule_type: 'model_name',
    rule_value: 'deepseek*',
    priority: 90,
    enabled: 1,
  });
  console.log(`✓ 创建规则: ${rule2!.name} (${rule2!.rule_type}:${rule2!.rule_value})`);

  console.log('\n3. 测试路由选择...');
  
  portkeyRouter.clearCache();

  const testCases = [
    { modelName: 'gpt-4-turbo', expected: 'US Gateway' },
    { modelName: 'gpt-4-vision-preview', expected: 'US Gateway' },
    { modelName: 'deepseek-chat', expected: 'CN Gateway' },
    { modelName: 'deepseek-coder', expected: 'CN Gateway' },
    { modelName: 'claude-3-opus', expected: 'US Gateway' },
  ];

  for (const testCase of testCases) {
    const context = { modelName: testCase.modelName };
    const selectedGateway = portkeyRouter.selectGateway(context);
    
    const result = selectedGateway?.name === testCase.expected ? '✓' : '✗';
    console.log(
      `${result} 模型 "${testCase.modelName}" -> ${selectedGateway?.name || 'None'} (期望: ${testCase.expected})`
    );
  }

  console.log('\n4. 清理测试数据...');
  await modelRoutingRuleDb.delete(rule1!.id);
  await modelRoutingRuleDb.delete(rule2!.id);
  await portkeyGatewayDb.delete(gateway1!.id);
  await portkeyGatewayDb.delete(gateway2!.id);
  console.log('✓ 测试数据已清理');

  console.log('\n' + '='.repeat(60));
  console.log('测试完成');
  console.log('='.repeat(60));
}

export { testPortkeyRouting };

