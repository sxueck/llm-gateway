# 前端色彩台账（改动前）

基线：`a47bb92`。命令：`rg -o '#[0-9a-fA-F]{6}\b' packages/web/src --no-filename | sort | uniq -c`。结果为 **530 处六位 hex、146 个大小写敏感的不同值，涉及 43 个 Vue 文件**；另有 **98 处三位 hex**，合计 628。六位口径不包括三位、八位、rgba 或其他 CSS 表示。

- 品牌：`#0f6b4a` 16、`#006241` 7、`#68756f` 11、`#17231e` 6、`#e8eeea` 6、`#f8faf9` 5；`#1e3932` 另有大小写拼法。背景基色 `#f5f5f5` 叠加两层品牌绿径向渐变。
- 中性：Ant 系 `#8c8c8c` 34、`#f0f0f0` 22、`#e8e8e8` 16、`#fafafa` 15、`#595959` 9、`#262626` 5；Tailwind 系 `#e5e7eb` 19、`#9ca3af` 18、`#6b7280` 16、`#1f2937` 17、`#111827` 10、`#374151` 7。另有三位灰色和 rgba。
- 语义：`#18a058` 12、`#2080f0` 5、`#f0a020` 9、`#d03050` 19（区分大小写）；naive-ui `type` 组件还会使用框架默认语义色。`App.vue` 目前仅显式覆盖品牌色三态；`style.css` 与 `styles/shadcn.css` 另有独立 token。
- Dashboard 图表 `COLOR_PALETTE` 的 8 个线色为 `#006241`、`#C4996C`、`#1E3932`、`#2D8A6D`、`#A89F91`、`#6CA68D`、`#4A4A4A`、`#D4E9E2`；作为既有视觉例外保留。ECharts 使用 Canvas，不能把 JavaScript 图表颜色机械替换成 CSS `var()`。

## 设计依据与约束

- [Radix Colors](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale) 将 12 阶分配给背景、交互、边框、实色与文本；其文本阶对比度保证使用 APCA，不能直接当作 WCAG 比值。
- [Material Design 3](https://m3.material.io/styles/color/system/how-the-system-works) 将种子生成按 tone 分级的多个色板，再赋予语义角色；本项目借鉴角色分层，不直接套用整个体系。
- [Tailwind v4](https://tailwindcss.com/docs/colors) 以 OKLCH 表达 50–950 色阶；色阶本身不保证任意组合达标，本项目使用低彩度品牌色及绿调中性灰，并核算实际组合。
- [WCAG 2.1 1.4.3](https://www.w3.org/TR/WCAG21/#contrast-minimum)：普通文本至少 4.5:1，大字至少 3:1；[1.4.11](https://www.w3.org/TR/WCAG21/#non-text-contrast)：辨识 UI 组件和必要图形的相邻色至少 3:1；非活动组件有例外。
- naive-ui 2.43.2 的 common theme 使用静态默认值，`use-theme.mjs` 只合并 override，不从 seed 推导 hover/pressed。经用户确认，应从同一 token 源派生各状态并显式传入，而不是仅覆盖 seed。

## 基线视觉记录

`/tmp/llm-gateway-color-baseline-a47bb92` 运行 `npm run dev:all`；当前工作树也运行同一命令。隔离测试数据库沿用上轮授权的 `llm_gateway_ui_test_954cc77`。本轮同视口基线截图目录：`/home/sxueck/.pi/agent/cache/browser/`，Dashboard `screenshot-2026-11-14T10-44-40.png`、Providers `10-44-48`、VirtualKeys `10-44-54`、Playground `10-45-43`、运维监控 `10-46-44`（后三项均有相同 `screenshot-2026-11-14T` 前缀及 `.png` 后缀）。基线计算样式：body 背景 `rgb(245,245,245)`、标题 `rgb(30,57,50)`、侧栏背景 `rgba(255,255,255,0.78)`，普通卡片白色；Dashboard 的统计卡使用自身浅绿色。

## 调整后验证记录

同视口截图目录同上：Dashboard `11-09-25`、Providers `11-09-32`、VirtualKeys `11-10-27`、Playground `11-10-33`、运维监控 `11-11-28`，文件名为 `screenshot-2026-11-14T<时间>.png`。调整后 body 基色、侧栏背景和标题计算值不变；Dashboard 主统计卡从 `rgb(237,247,241)` 变为 `rgb(227,241,233)`。截图使用空测试库，不代表所有数据状态。

颜色源中 success/info/warning/error base 分别为 `#337344`、`#3e6596`、`#804d0c`、`#92413d`，hover/pressed 逐级变深；禁用态单独设置，naive-ui 还应用禁用透明度。上述截图记录的是中间版本：Dashboard 主卡原先采用 brand-500 的文字对 brand-100 仅 3.01:1，曾改为 brand-700（6.38:1）。后续按用户选择改为 brand-700 深绿底与白字，对比度 7.44:1；最新截图为 `screenshot-2026-11-14T12-13-14.png`。

### 对比度采样（WCAG 2.1，相对亮度）

用临时 `tsx` 脚本调用 `color-tokens.ts` 的 `contrastRatio` 计算。背景列依次是白卡 `#ffffff`、body 基色 `#f5f5f5`、基线截图顶部渐变实测像素 `#e4eae8`、调整中使用的浅绿卡 `#e3f1e9`（已被深绿主卡替代）。实际渐变随位置变化；截图像素使用已安装的 sharp 解码，不代表完整渐变的每个像素。

| 前景 | 白卡 | body | 渐变采样 | 主卡 |
|---|---:|---:|---:|---:|
| primary `#0f6b4a` | 6.52 | 5.98 | 5.35 | 5.59 |
| title `#1e3932` | 12.45 | 11.42 | 10.22 | 10.69 |
| 正文 `#2f3833` | 12.11 | 11.11 | 9.94 | 10.39 |
| 次级文本 `#535a56` | 7.08 | 6.50 | 5.81 | 6.08 |
| success `#337344` | 5.71 | 5.24 | 4.69 | 4.90 |
| info `#3e6596` | 5.99 | 5.49 | 4.91 | 5.14 |
| warning `#804d0c` | 7.04 | 6.45 | 5.77 | 6.04 |
| error `#92413d` | 6.89 | 6.32 | 5.66 | 5.92 |
| neutral-500 `#878e8a` | 3.35 | 3.07 | **2.75** | **2.88** |
| neutral-600 `#6c746f` | 4.81 | 4.41 | 3.95 | 4.13 |

neutral-500 不适合在这些背景上作普通文字或在渐变上作必要图标；业务普通文本已改用 neutral-700。disabled 态另按 WCAG 非活动组件例外处理。以上是重点 token 的采样核算，不是对所有页面、透明叠层及图表组合的穷尽证明；尤其保留的 Dashboard 8 色盘需按实际图表含义单独评估。

交互复核：中文与英文中 Ctrl+K 均打开 CommandPalette 并显示对应提示；LanguageSwitcher 从中文切到英文再切回；两种语言的用户下拉分别显示 Logout / 退出登录。未执行退出登录动作。800px/520px 通过 iframe 视口检查，document scrollWidth 与 viewport 相等，header 内 scrollWidth 与 clientWidth 相等；这不等于五页所有内层容器均已验证。

防回流：CSS/TS 使用新增 ast-grep advisory 规则；ast-grep 0.51 不解析 Vue，`npm run ast` 额外调用 `scripts/check-web-vue-hex.mjs` 进行词法告警，并只豁免 Dashboard 的 `COLOR_PALETTE` 块。词法检查并非 Vue AST，不能替代人工审查。

