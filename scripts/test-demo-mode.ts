import { config } from 'dotenv';

config();

console.log('========================================');
console.log('演示模式配置测试');
console.log('========================================\n');

const demoMode = process.env.DEMO_MODE;

console.log('环境变量 DEMO_MODE:', demoMode || '(未设置)');

if (demoMode === 'true' || demoMode === 'enabled') {
  console.log('✓ 演示模式已启用');
  console.log('\n功能说明:');
  console.log('  - 每隔 3 天自动清理所有数据');
  console.log('  - 自动创建演示用户 (demo/demo1234)');
  console.log('  - 登录页面显示演示模式提示');
  console.log('\n⚠️  警告: 请勿在生产环境中启用演示模式！');
} else {
  console.log('✗ 演示模式未启用');
  console.log('\n如需启用演示模式，请在 .env 文件中添加:');
  console.log('  DEMO_MODE=true');
}

console.log('\n========================================\n');

