import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { generalMenuParentByKey, mainMenuParentByKey } from './menu-mappings';

// 映射表本身是数据，逐格断言只是重述实现；真正会静默坏掉的是「菜单项/分组改名后
// 映射指向不存在的 key，点击子项时分组不展开」。所以按 MainLayout 源码分菜单校验
// key 是否存在（同 page-title-convention.test.ts 的文件级断言做法）。
const src = readFileSync(join(__dirname, '../layouts/MainLayout.vue'), 'utf8');

function renderedKeys(startAnchor: string, endAnchor: string): Set<string> {
  const start = src.indexOf(startAnchor);
  const end = src.indexOf(endAnchor);
  expect(start, `MainLayout.vue 缺少锚点 ${startAnchor}`).toBeGreaterThanOrEqual(0);
  expect(end, `MainLayout.vue 缺少锚点 ${endAnchor}`).toBeGreaterThan(start);
  return new Set([...src.slice(start, end).matchAll(/key:\s*'([^']+)'/g)].map((match) => match[1]));
}

function unrenderedKeys(mapping: Record<string, string>, rendered: Set<string>): string[] {
  return [...new Set(Object.entries(mapping).flat())].filter((key) => !rendered.has(key));
}

describe('菜单父子映射与 MainLayout 渲染一致', () => {
  it('主菜单映射的菜单项与分组都在 menuOptions 内渲染', () => {
    // advancedToolsChildren 也属于主菜单区块，故切片终点取 generalMenuOptions。
    expect(unrenderedKeys(mainMenuParentByKey, renderedKeys('const menuOptions', 'const generalMenuOptions'))).toEqual([]);
  });

  it('通用菜单映射的菜单项与分组都在 generalMenuOptions 内渲染', () => {
    expect(unrenderedKeys(generalMenuParentByKey, renderedKeys('const generalMenuOptions', 'const userOptions'))).toEqual([]);
  });
});
