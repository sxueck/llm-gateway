import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// 守护任务一的成果：页面级标题只允许走 components/PageHeader.vue。
// 仓库没有样式层面的强制手段，所以用文件级断言兜住：
// 1) 每个导航页面必须使用 PageHeader（少数无壳路由除外，见下）；
// 2) 不允许再出现已被删除的全局标题工具类，避免有人绕过组件手搓样式。
const VIEW_DIR = join(__dirname);

const ROUTELESS_VIEWS = new Set([
  // 登录/注册自带全屏布局；ApiGuideView 已被 Playground 取代。
  'auth',
]);

const FORBIDDEN_CLASSES = ['page-title', 'page-subtitle'];

function viewFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ROUTELESS_VIEWS.has(entry.name)) continue;
      viewFiles(full, out);
    } else if (entry.name.endsWith('View.vue')) {
      out.push(full);
    }
  }
  return out;
}

const views = viewFiles(VIEW_DIR);

describe('页面标题规范', () => {
  it('发现了待检查的页面文件', () => {
    // 若这条失败，说明 views 目录结构变了，本测试的覆盖前提不再成立。
    expect(views.length).toBeGreaterThanOrEqual(18);
  });

  it.each(views.map((f) => [f.replace(/\\/g, '/').split('/').slice(-1)[0], f]))(
    '%s 使用 PageHeader 且不使用被删除的标题工具类',
    (_name, file) => {
      const src = readFileSync(file as string, 'utf8');
      // 引号风格因文件而异（单/双都有），只断言路径与用法。
      expect(src).toMatch(/PageHeader from ['"]@\/components\/PageHeader\.vue['"]/);
      expect(src).toContain('<PageHeader');
      for (const cls of FORBIDDEN_CLASSES) {
        expect(src).not.toContain(`class="${cls}"`);
        expect(src).not.toContain(`class="${cls} `);
      }
    },
  );

  it('每个 PageHeader 都带 eyebrow 分类标签', () => {
    const missing = views
      .filter((f) => {
        const src = readFileSync(f, 'utf8');
        const block = src.slice(src.indexOf('<PageHeader'));
        return !/eyebrow=/.test(block.slice(0, 600));
      })
      .map((f) => f.split('/').slice(-1)[0]);
    expect(missing).toEqual([]);
  });
});
