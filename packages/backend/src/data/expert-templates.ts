export interface ExpertTemplate {
  label: string;
  value: string;
  description: string;
  utterances: string[];
  system_prompt?: string;
}

export const expertTemplates: ExpertTemplate[] = [
  {
    label: 'Debug (故障排查/修复)',
    value: 'debug',
    description:
      '定位并修复当前存在的错误或不符合预期的行为：运行时报错、测试失败、线上异常、回归、边界条件错误等。',
    // Classification criteria for this expert (NOT forwarded to upstream model).
    system_prompt: `用于故障排查与修复。

应归类到 debug：
- 用户描述报错/异常/崩溃/测试失败/功能回归/性能异常，并希望定位原因与修复。

不应归类到 debug：
- 主要目标是新增功能/方案设计/代码讲解/评审/写测试/环境配置（分别归类到 feature/plan/explain/review/test/setup）。`,
    utterances: [
      'Fix this error.',
      'Why is my build failing?',
      '本地运行时报 `NullPointerException`，帮我定位并修复。',
      'The application crashes with a segfault when I upload a file larger than 10MB.',
      'Investigate why the API latency spikes to 5 seconds every hour.',
      'My unit tests are failing with "expected 200 but got 500" after the last merge.',
      '这个函数在输入为 0 时输出不对，应该返回 1。',
      "I'm seeing a memory leak in production. Here is the heap dump analysis. Help me find the root cause.",
      'The frontend is not rendering the updated state despite the Redux action being fired.',
    ],
  },
  {
    label: 'Explain (解释/理解)',
    value: 'explain',
    description: '解释代码/概念/机制/工具原理，讲清楚“是什么、为什么、怎么用”，并提供例子。',
    system_prompt: `用于解释与理解。

应归类到 explain：
- 用户要理解代码/概念/机制/工具原理，要求讲解、举例、对比、走读。

不应归类到 explain：
- 主要目标是修 bug（debug）或直接实现功能（feature）或出方案（plan）。`,
    utterances: [
      'Explain this code.',
      'What does `useEffect` do?',
      'Walk me through how the OAuth2 authorization code flow works.',
      '解释一下这段 SQL 为什么会慢，以及执行计划怎么看。',
      'Analyze the time complexity of this sorting algorithm.',
      'What is the difference between TCP and UDP?',
      'Clarify the concept of "closure" in JavaScript with an example.',
      '这个正则表达式每一部分是什么意思？',
      'Document this class and its methods, explaining the design pattern used.',
    ],
  },
  {
    label: 'Feature (新增功能)',
    value: 'feature',
    description: '新增或扩展系统能力：实现接口、页面、脚本、配置变更，让系统具备之前没有的功能。',
    system_prompt: `用于新增/扩展功能的实现。

应归类到 feature：
- 用户明确要“新增功能/加模块/做接口/写脚本/加页面”，期望产出实现代码。

不应归类到 feature：
- 主要目标是修复现有 bug（debug）或给方案不落代码（plan）或做评审（review）。`,
    utterances: [
      'Create a login page.',
      'Add a dark mode toggle.',
      'Implement a REST API for managing todo items with CRUD operations.',
      '帮我实现一个 `/users/{id}` 的 GET 接口，返回用户信息。',
      'Write a Python script to resize all images in a folder.',
      'Build a React component that displays a real-time stock price chart using WebSockets.',
      'Add a "Forgot Password" feature that sends an email with a reset link.',
      'Generate a Dockerfile for this Node.js application.',
      '新增 4 个导出 CSV 的功能，并支持按日期过滤。',
    ],
  },
  {
    label: 'Plan (方案设计/规划)',
    value: 'plan',
    description: '给出可执行的方案/架构/步骤拆分与里程碑；更偏设计与决策，而不是直接写实现代码。',
    system_prompt: `用于方案设计与规划。

应归类到 plan：
- 用户要“架构方案/拆分步骤/选型对比/实施路线图/技术规格”。

不应归类到 plan：
- 主要目标是直接写实现代码（feature）或修 bug（debug）。`,
    utterances: [
      'Plan a system upgrade.',
      'How should I structure this project?',
      'Design a database schema for an e-commerce platform.',
      '我们要做多租户改造，帮我给一个实施方案和拆分步骤。',
      'Outline the steps to migrate from monolith to microservices.',
      'Propose a high-availability architecture for our payment gateway.',
      'Create a roadmap for implementing the new search functionality.',
      'Draft a technical specification for the user authentication system.',
      '帮我规划一下把单体拆成服务的迁移路线。',
    ],
  },
  {
    label: 'Refactor (重构)',
    value: 'refactor',
    description:
      '改善代码结构与可维护性，但不改变对外行为：提取函数、拆分模块、命名优化、去重复、消除坏味道等。',
    system_prompt: `用于重构。

应归类到 refactor：
- 用户要改善代码结构/可维护性/可读性，并强调“逻辑不变/行为不变”。

不应归类到 refactor：
- 主要目标是修 bug（debug）或新增能力（feature）。`,
    utterances: [
      'Clean up this code.',
      'Refactor to use async/await.',
      'Optimize this loop for better performance.',
      '这段代码太乱了，帮我重构一下，逻辑保持不变。',
      'Extract the validation logic into a separate helper function.',
      'Rename variables to be more descriptive.',
      'Modernize this legacy Java 7 code to use Java 8 streams and lambdas.',
      'Simplify this complex if-else chain using a lookup table or polymorphism.',
      'Restructure this component to separate view logic from business logic.',
    ],
  },
  {
    label: 'Review (评审/把关)',
    value: 'review',
    description: '对已有代码/提交/PR/设计进行评审，把关正确性、性能、安全与一致性，给出可执行修改建议。',
    system_prompt: `用于代码/设计评审。

应归类到 review：
- 用户请求 review/审查/把关：找 bug、风险、边界条件、安全/性能问题并给建议。

不应归类到 review：
- 主要目标是直接实现功能（feature）或修 bug（debug）。`,
    utterances: [
      'Review this PR.',
      'Check for security flaws.',
      'Does this code follow best practices?',
      '帮我 review 这段代码，看有没有潜在 bug 和边界问题。',
      'Audit this smart contract for vulnerabilities.',
      'Review my database indexing strategy for performance issues.',
      'Critique this API design for RESTfulness and consistency.',
      'Look for potential race conditions in this concurrent code.',
      '这是我 PR 的 diff，给我一些改进建议。',
    ],
  },
  {
    label: 'Setup (环境/配置)',
    value: 'setup',
    description: '环境搭建/依赖安装/构建部署/容器化/CI/CD/权限网络配置相关问题。',
    system_prompt: `用于环境与配置。

应归类到 setup：
- 依赖安装、构建失败、运行环境配置、容器化、CI/CD、权限/网络等。

不应归类到 setup：
- 主要目标是业务功能实现（feature）或代码讲解（explain）。`,
    utterances: [
      'How to install this?',
      'Configure webpack.',
      'Set up a CI/CD pipeline.',
      'npm install 报 peer dependency 冲突，怎么解决？',
      'Troubleshoot this "permission denied" error during npm install.',
      'Config nginx to reverse proxy to my app.',
      'Initialize a new TypeScript project with strict mode enabled.',
      'Help me configure VS Code for Python development with linting.',
      'docker compose 起服务报端口冲突，怎么改？',
    ],
  },
  {
    label: 'Test (测试编写)',
    value: 'test',
    description: '编写/修改/组织/运行测试：单测、集成、E2E、mock、覆盖率、测试用例设计。',
    system_prompt: `用于测试。

应归类到 test：
- 用户要写/补/修测试：单测、集成、E2E、mock、覆盖率、用例设计。

不应归类到 test：
- 主要目标是新增业务功能（feature）。`,
    utterances: [
      'Write a test.',
      'Fix this flaky test.',
      'Add unit tests for the User class.',
      '帮我给这个函数补充单元测试，覆盖空输入和异常分支。',
      'Create an E2E test scenario for the checkout flow.',
      'Mock the external API call in this test case.',
      'Improve test coverage for this module to 90%.',
      'Write a performance test script using k6.',
      'Generate test data for boundary conditions.',
    ],
  },
  {
    label: 'Other (综合/闲聊)',
    value: 'other',
    description: '问候、闲聊、翻译、摘要等通用任务；非编码或轻量编码问题。',
    system_prompt: `用于通用/非技术任务。

应归类到 other：
- 闲聊、翻译、摘要、简单问答。

不应归类到 other：
- 明确的软件工程任务（debug/feature/plan/...）。`,
    utterances: [
      'Hello.',
      'Hi there!',
      'Who are you?',
      'What time is it?',
      'Tell me a joke.',
      'Translate "Hello world" to French.',
      'Just checking in.',
      'Weather in Tokyo?',
      'Summary this text.',
    ],
  },
];
