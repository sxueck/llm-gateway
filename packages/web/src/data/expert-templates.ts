export interface ExpertTemplate {
  label: string;
  value: string;
  description: string;
  utterances: string[];
}

export const expertTemplates: ExpertTemplate[] = [
  {
    label: 'Debug (故障排查/修复)',
    value: 'debug',
    description: '当用户的主要目标是“定位并修复当前存在的错误或不符合预期的行为”，包括运行时报错、测试失败、线上异常、功能回归、输出不正确、边界条件出错等。',
    utterances: [
      'Fix this error.',
      'Why is my build failing?',
      '本地运行时报 `NullPointerException`，帮我定位并修复。',
      'The application crashes with a segfault when I upload a file larger than 10MB.',
      'Investigate why the API latency spikes to 5 seconds every hour.',
      'My unit tests are failing with "expected 200 but got 500" after the last merge.',
      '这个函数在输入为 0 时输出不对，应该返回 1。',
      'I\'m seeing a memory leak in production. Here is the heap dump analysis. Help me find the root cause.',
      'The frontend is not rendering the updated state despite the Redux action being fired.'
    ]
  },
  {
    label: 'Explain (解释/理解)',
    value: 'explain',
    description: '当用户的主要目标是“理解某段代码、概念、机制或工具的工作原理”，需要解释、讲解、举例、画流程（文字化）、澄清术语时。',
    utterances: [
      'Explain this code.',
      'What does `useEffect` do?',
      'Walk me through how the OAuth2 authorization code flow works.',
      '解释一下这段 SQL 为什么会慢，以及执行计划怎么看。',
      'Analyze the time complexity of this sorting algorithm.',
      'What is the difference between TCP and UDP?',
      'Clarify the concept of "closure" in JavaScript with an example.',
      '这个正则表达式每一部分是什么意思？',
      'Document this class and its methods, explaining the design pattern used.'
    ]
  },
  {
    label: 'Feature (新增功能)',
    value: 'feature',
    description: '当用户的主要目标是“新增或扩展产品/系统能力”，需要产出可运行的实现代码、接口、页面、脚本、配置变更等，使系统具备此前没有的功能时。',
    utterances: [
      'Create a login page.',
      'Add a dark mode toggle.',
      'Implement a REST API for managing todo items with CRUD operations.',
      '帮我实现一个 `/users/{id}` 的 GET 接口，返回用户信息。',
      'Write a Python script to resize all images in a folder.',
      'Build a React component that displays a real-time stock price chart using WebSockets.',
      'Add a "Forgot Password" feature that sends an email with a reset link.',
      'Generate a Dockerfile for this Node.js application.',
      '新增 4 个导出 CSV 的功能，并支持按日期过滤。'
    ]
  },
  {
    label: 'Plan (方案设计/规划)',
    value: 'plan',
    description: '当用户的主要目标是“获得一个可执行的方案/设计/步骤”，而不是立刻产出具体实现代码或直接修 bug 时。',
    utterances: [
      'Plan a system upgrade.',
      'How should I structure this project?',
      'Design a database schema for an e-commerce platform.',
      '我们要做多租户改造，帮我给一个实施方案和拆分步骤。',
      'Outline the steps to migrate from monolith to microservices.',
      'Propose a high-availability architecture for our payment gateway.',
      'Create a roadmap for implementing the new search functionality.',
      'Draft a technical specification for the user authentication system.',
      '帮我规划一下把单体拆成服务的迁移路线。'
    ]
  },
  {
    label: 'Refactor (重构)',
    value: 'refactor',
    description: '当用户的主要目标是“改善代码结构与可维护性”，并明确或隐含地要求“不改变现有业务行为/对外语义”，例如提取函数、拆分模块、改善命名、消除重复等。',
    utterances: [
      'Clean up this code.',
      'Refactor to use async/await.',
      'Optimize this loop for better performance.',
      '这段代码太乱了，帮我重构一下，逻辑保持不变。',
      'Extract the validation logic into a separate helper function.',
      'Rename variables to be more descriptive.',
      'Modernize this legacy Java 7 code to use Java 8 streams and lambdas.',
      'Simplify this complex if-else chain using a lookup table or polymorphism.',
      'Restructure this component to separate view logic from business logic.'
    ]
  },
  {
    label: 'Review (评审/把关)',
    value: 'review',
    description: '当用户的主要目标是“对已有代码/提交/PR/设计文档进行评审”，关注正确性、可维护性、性能、安全、风格一致性、潜在 bug、边界条件等，并给出修改建议时。',
    utterances: [
      'Review this PR.',
      'Check for security flaws.',
      'Does this code follow best practices?',
      '帮我 review 这段代码，看有没有潜在 bug 和边界问题。',
      'Audit this smart contract for vulnerabilities.',
      'Review my database indexing strategy for performance issues.',
      'Critique this API design for RESTfulness and consistency.',
      'Look for potential race conditions in this concurrent code.',
      '这是我 PR 的 diff，给我一些改进建议。'
    ]
  },
  {
    label: 'Setup (环境/配置)',
    value: 'setup',
    description: '当用户的主要目标是“把项目或某个工具链跑起来”，涉及依赖安装、编译构建、运行配置、容器化、CI/CD、权限/网络/系统配置等问题时。',
    utterances: [
      'How to install this?',
      'Configure webpack.',
      'Set up a CI/CD pipeline.',
      'npm install 报 peer dependency 冲突，怎么解决？',
      'Troubleshoot this "permission denied" error during npm install.',
      'Config nginx to reverse proxy to my app.',
      'Initialize a new TypeScript project with strict mode enabled.',
      'Help me configure VS Code for Python development with linting.',
      'docker compose 起服务报端口冲突，怎么改？'
    ]
  },
  {
    label: 'Test (测试编写)',
    value: 'test',
    description: '当用户的主要目标是“编写、修改、组织、运行测试”，包括单元测试/集成测试/E2E、测试数据构造、mock/stub、覆盖率提升、测试框架使用、测试用例设计等。',
    utterances: [
      'Write a test.',
      'Fix this flaky test.',
      'Add unit tests for the User class.',
      '帮我给这个函数补充单元测试，覆盖空输入和异常分支。',
      'Create an E2E test scenario for the checkout flow.',
      'Mock the external API call in this test case.',
      'Improve test coverage for this module to 90%.',
      'Write a performance test script using k6.',
      'Generate test data for boundary conditions.'
    ]
  },
  {
    label: 'Other (综合/闲聊)',
    value: 'other',
    description: '处理问候、闲聊、简单工具调用（如查天气、时间）、翻译等非编码类或通用任务。',
    utterances: [
      'Hello.',
      'Hi there!',
      'Who are you?',
      'What time is it?',
      'Tell me a joke.',
      'Translate "Hello world" to French.',
      'Just checking in.',
      'Weather in Tokyo?',
      'Summary this text.'
    ]
  }
];
