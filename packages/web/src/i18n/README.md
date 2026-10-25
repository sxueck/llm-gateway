# 国际化 (i18n) 使用指南

本项目使用 vue-i18n 实现中英文切换功能。

## 目录结构

```
web/src/i18n/
├── index.ts           # i18n 配置文件
├── locales/
│   ├── zh-CN.ts      # 中文语言包
│   └── en-US.ts      # 英文语言包
└── README.md         # 本文档
```

## 功能特性

- 支持中文 (zh-CN) 和英文 (en-US) 两种语言
- 语言选择持久化保存在 localStorage
- 页面刷新后保持用户选择的语言
- 响应式语言切换,无需刷新页面

## 使用方法

### 1. 在组件中使用翻译

```vue
<template>
  <div>
    <h1>{{ t('dashboard.title') }}</h1>
    <p>{{ t('dashboard.subtitle') }}</p>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';

const { t } = useI18n();
</script>
```

### 2. 在计算属性中使用翻译

```vue
<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

const menuOptions = computed(() => [
  {
    label: t('menu.dashboard'),
    key: 'dashboard',
  },
  {
    label: t('menu.providers'),
    key: 'providers',
  },
]);
</script>
```

### 3. 切换语言

使用 LanguageSwitcher 组件或通过 localeStore:

```typescript
import { useLocaleStore } from '@/stores/locale';
import { useI18n } from 'vue-i18n';

const localeStore = useLocaleStore();
const { locale } = useI18n();

function switchLanguage(newLocale: 'zh-CN' | 'en-US') {
  localeStore.setLocale(newLocale);
  locale.value = newLocale;
}
```

## 添加新的翻译

### 1. 在语言包中添加翻译键值

在 `locales/zh-CN.ts` 中添加中文翻译:

```typescript
export default {
  // ... 其他翻译
  myFeature: {
    title: '我的功能',
    description: '这是一个新功能',
  },
};
```

在 `locales/en-US.ts` 中添加英文翻译:

```typescript
export default {
  // ... 其他翻译
  myFeature: {
    title: 'My Feature',
    description: 'This is a new feature',
  },
};
```

### 2. 在组件中使用新的翻译

```vue
<template>
  <div>
    <h2>{{ t('myFeature.title') }}</h2>
    <p>{{ t('myFeature.description') }}</p>
  </div>
</template>
```

## 语言包结构

语言包采用嵌套对象结构,便于组织和管理:

```typescript
{
  common: {        // 通用翻译
    confirm: '确认',
    cancel: '取消',
    // ...
  },
  menu: {          // 菜单相关
    dashboard: '仪表盘',
    providers: '提供商列表',
    // ...
  },
  dashboard: {     // 仪表盘页面
    title: '仪表盘',
    subtitle: '这里监控着当前服务的全部数据',
    // ...
  },
  // ... 其他模块
}
```

## 待完成的工作

其他视图和组件的翻译可以按照相同的模式继续添加:

1. 在对应的语言包中添加翻译键值
2. 在组件中导入 `useI18n`
3. 使用 `t()` 函数替换硬编码的文本
4. 对于动态选项,使用 `computed` 包装

## 技术细节

- **库**: vue-i18n v9
- **模式**: Composition API (legacy: false)
- **默认语言**: zh-CN
- **回退语言**: zh-CN
- **持久化**: localStorage (key: 'locale')

