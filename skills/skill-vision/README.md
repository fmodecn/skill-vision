# Fmode Vision Skill — 维护文档

## 项目结构

```
.claude/skills/skill-vision/
├── SKILL.md                       # 技能入口，Claude 读取后知道何时及如何使用本技能
├── README.md                      # 本文件：开发者维护文档
├── .skillfish.json                # 技能元信息（版本、来源仓库）
└── scripts/
    ├── vision-client.mjs           # 核心：通用视觉 API 客户端
    └── prompts/
        └── room-measurement.mjs    # 领域模块：毛坯房量尺 5-pass 提示词
```

## 核心逻辑

### 1. Token 解析链 (`resolveApiToken`)

第0级自举 + 四级回落，短路返回：

```
【第0级 自举】FMODE_SESSION_TOKEN 环境变量 或 ~/.fmode/config.json 的 sessionToken
  → 调 fmode API 动态换取 API token（登录 FMODE Studio 即可，无需手工配置；
    token 仅内存持有，不落盘不进日志；换取失败明确报错后回落）
FMODE_API_TOKEN 环境变量
  → ~/.fmode/config.json 的 fmodeApiToken / newapiToken 字段
    → ~/.claude/settings.json（含 settings.local.json / 项目级 .claude/）
      的 env.ANTHROPIC_AUTH_TOKEN（sk- 开头、非 sk-ant-、base 指向 fmode）
      （Claude Code 会话内注入的进程环境变量也在此级命中）
      → <project>/.fmode/config.json 的 fmodeApiToken / newapiToken 字段
        → 抛出异常（提示用户配置）
```

设计原因：环境变量适合 CI/CD；用户级配置适合个人开发机；Claude Code 的 `sk-` token 零配置自动命中；项目级配置适合团队共享（加入 .gitignore）。

### 1.5 模型选择策略 (`detectHostVisionModel` / `resolveVisionModel` / `analyze`)

宿主多模态优先，回落 Fmode API：

```
resolveVisionModel():
  显式传入 model 参数        → { provider:'fmode', model }（强制 Fmode API）
  ③ FMODE_VISION_MODEL 环境变量 → { provider:'host', model }（用户显式指定）
  ① Claude Code settings 的 model / env.ANTHROPIC_MODEL
     命中多模态名单且在会话内  → { provider:'host', model }
  ② ~/.codex/config.toml 的 model 命中名单 → { provider:'host', model }
  未命中                    → { provider:'fmode', model:'glm-5.3-flash' }
```

`analyze()` 是总入口：`provider==='host'` 且在 Claude Code / Codex 会话内时返回
`{ provider:'host', model, instruction, imagePath }`，AI 用自己的 Read 工具读图完成分析
（不调 GLM、不消耗 Fmode token）；否则走 Fmode API。探测到宿主多模态但独立脚本运行时
回落 Fmode API。多模态能力名单见 `vision-client.mjs` 的 `HOST_VISION_MODEL_PATTERNS`。

### 2. API 调用流程 (`callVisionAPI`)

```
输入: imagePath | imageBase64 | imageUrl | videoUrl
  |
  ├─ 解析 token
  ├─ 构造 messages 数组
  │   ├─ system prompt
  │   └─ user content:
  │       ├─ text part（用户提示词）
  │       └─ image_url / video_url part（视觉内容）
  ├─ POST https://api.fmode.cn/v1/chat/completions
  │   body: { model, messages, temperature, max_tokens }
  ├─ 响应的 content 字符串 → extractJSON()
  └─ 返回 { raw, parsed, error, usage }
```

### 3. 多轮分析模式 (`callMultiPass`)

核心理念：每轮独立调用 API，各自聚焦一个分析维度，最后一轮合并。这比单轮全量分析精度更高。

```
输入: imagePath + passes[{name, systemPrompt, userPrompt, maxTokens}]
  |
  for each pass:
  ├─ 检查 cacheDir/pass<N>.json 是否存在
  │   ├─ 存在 → 跳过，读取缓存
  │   └─ 不存在 → callVisionAPI() → 写入缓存
  ├─ sleep(delayMs) 避免限流
  |
  └─ 返回 results[]
```

缓存设计：
- 每轮结果独立缓存，支持断点续跑
- 缓存 key = pass 序号，与提示词内容无关
- 如需强制重新分析，删除对应缓存文件即可
- 提示词迭代时，建议手动清理缓存

### 4. JSON 提取 (`extractJSON`)

LLM 响应可能被 markdown 代码块包裹（```json ... ```），也可能前后有解释文字。用正则 `/\{[\s\S]*\}/` 提取第一个 JSON 对象。

### 5. 毛坯房 5-pass 专用流程 (`room-measurement.mjs`)

继承自 `analyze-photos-v4.mjs`，5 轮各有独立职责：

| Pass | 名称 | 分析焦点 | tokens |
|------|------|---------|--------|
| 1 | spatial | 空间结构：透视类型、墙面多边形、阴阳角、天地面 | 2000 |
| 2 | ceiling | 吊顶特征：cornice/trayStep/beam/bulkhead | 1000 |
| 3 | openings | 门窗洞口：双层框架（outer+inner polygon） | 2500 |
| 4 | obstacles | 障碍物：插座/开关/电箱/踢脚线/风口等 | 1500 |
| 5 | merge | 文本合并：场景描述、房间类型、测量计划、质量评估 | 2000 |

质量验证：
- 踢脚线 height > 10% → 警告（应为 2-5%）
- 吊顶特征 polygon 顶点 > 4 → 警告

## 配置说明

### API Token

方式一：环境变量
```bash
export FMODE_API_TOKEN="sk-****（占位符，换成你自己的 token）"
```

方式二：用户级配置 `~/.fmode/config.json`
```json
{
  "fmodeApiToken": "sk-****（占位符，换成你自己的 token）"
}
```

方式三：项目级配置 `<project>/.fmode/config.json`（需加入 .gitignore）
```json
{
  "fmodeApiToken": "sk-****（占位符，换成你自己的 token）"
}
```

### 可用模型

| 模型 ID | 用途 | 备注 |
|---------|------|------|
| `glm-5.3-flash` | 视觉理解（默认回落） | Fmode API 默认视觉模型，替代旧 doubao |
| 宿主配置模型 | 视觉理解（优先） | Claude Code / Codex 配置的多模态模型，零额外计费 |
| `glm-4.6v` 等 | 视觉理解 | 调用时传 `model` 参数覆盖 |

模型列表可能更新，以 Fmode API 返回为准。

## 扩展指南

### 添加新的提示词模板

在 `scripts/prompts/` 下新建 `.mjs` 文件：

```js
import { callVisionAPI, callMultiPass } from '../vision-client.mjs';

export const MY_SYSTEM_PROMPT = `...`;
export const MY_USER_PROMPT = `...`;

export async function analyzeSomething(imagePath) {
  const result = await callVisionAPI({
    imagePath,
    systemPrompt: MY_SYSTEM_PROMPT,
    userPrompt: MY_USER_PROMPT,
    maxTokens: 1000,
  });
  return result.parsed;
}
```

### 添加新模型

在 `vision-client.mjs` 的 `DEFAULT_CONFIG` 中调整默认模型，或调用时传入 `model` 参数：

```js
const result = await callVisionAPI({
  imagePath: '/path/to/img.jpg',
  systemPrompt: '...',
  userPrompt: '...',
  model: 'glm-4.6v',  // 覆盖默认模型（强制走 Fmode API）
});
```

### 多轮分析自定义

```js
import { callMultiPass } from './vision-client.mjs';

const results = await callMultiPass({
  imagePath: '/path/to/img.jpg',
  cacheDir: '/tmp/my-analysis/img-001/',
  passes: [
    { name: 'overview', systemPrompt: '...', userPrompt: '描述整体场景', maxTokens: 500 },
    { name: 'details', systemPrompt: '...', userPrompt: '标注细节元素', maxTokens: 1500 },
    { name: 'verify',  systemPrompt: '...', userPrompt: '验证前两轮一致性', maxTokens: 1000 },
  ],
});
```

## 依赖

仅使用 Node.js 内置模块：`fs`, `path`, `os`。无需 `npm install`。

全局 `fetch` 需要 Node.js 18+（已内置）。
