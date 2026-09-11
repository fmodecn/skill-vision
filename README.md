# fmode-vision · 视觉识别技能（宿主多模态优先 × Fmode API 回落）

> 给 AI Agent 装上**眼睛**——分析图片、视频帧、视觉素材并输出结构化 JSON。
> 优先用宿主 Agent（Claude Code / Codex）配置的多模态模型直接读图，**零额外调用**；
> 宿主模型不支持视觉时回落 Fmode API 视觉模型 `glm-5.3-flash`。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![npm](https://img.shields.io/badge/npm-fmode--vision-blue)](https://www.npmjs.com/package/fmode-vision)

## 能力

- 👁️ 图片内容识别与结构化提取（严格 JSON 输出）
- 🎯 多轮聚焦分析（每轮专注一个维度，精度高于单轮全量）
- 🎬 视频帧分析（`video_url` 模型自动抽帧）
- 📦 视觉素材批量处理（中间结果缓存、断点续跑）
- 🏠 内置毛坯房量尺 5-pass 提示词管线（透视/吊顶/门窗洞口/障碍物/测量计划）

## 模型选择策略（0.2.0 新增）

技能初始化时**先探测运行环境**，宿主多模态优先：

| 优先级 | 来源 | 结果 |
|-------|------|------|
| ① | Claude Code `./.claude/settings.json` / `~/.claude/settings.json`（含 `.local`）的 `model` / `env.ANTHROPIC_MODEL` | 命中多模态名单 → 用宿主模型 |
| ② | Codex `~/.codex/config.toml` 的 `model` | 命中多模态名单 → 用宿主模型 |
| ③ | 环境变量 `FMODE_VISION_MODEL` | 用户显式指定 → 直接采纳 |
| — | 以上未命中 | 回落 Fmode API `glm-5.3-flash` |

多模态能力名单：`claude-4*` / `claude-opus` / `claude-sonnet-4` / `gpt-4o` / `gpt-5*` / `gemini-2*` / `gemini-3*` / `o3` 等（见 `skills/fmode-vision/scripts/vision-client.mjs` 的 `HOST_VISION_MODEL_PATTERNS`）。

**宿主命中且在 Claude Code / Codex 会话内**：AI 用自带的 Read 工具读图，结合提示词完成分析——不调 GLM、不发网络请求、不消耗 Fmode token，输出注明「已用宿主多模态模型」。
**未命中**：走 Fmode API `glm-5.3-flash`（替代旧的 `doubao-seed-2-0-pro-260215`），按 Fmode token 计费。

## Token 加载链（仅 Fmode API 路径需要）

按优先级自动解析（第0级自举 → 回落，**仓库与代码中无任何密钥**）：

0. **第0级自举（推荐）**：`FMODE_SESSION_TOKEN` 环境变量或 `~/.fmode/config.json` 的 `sessionToken` → 调 fmode API 动态换取 API token。登录 FMODE Studio 即可，无需手工配置；token 仅内存持有，不落盘不进日志
1. 环境变量 `FMODE_API_TOKEN`
2. `~/.fmode/config.json` → `fmodeApiToken` / `newapiToken`（FmodeStudio 保存配置后写入）
3. `~/.claude/settings.json`（含 `settings.local.json` / 项目级 `.claude/`）的 `env.ANTHROPIC_AUTH_TOKEN` —— 即 Claude Code 的 `sk-` token（仅当 `sk-` 开头、非 `sk-ant-`、base 指向 fmode 时采纳，零配置自动命中）
4. 项目 `./.fmode/config.json` → `fmodeApiToken` / `newapiToken`

> 报「未找到 token」= 缺 token，不是技能坏——按上面任一来源补上即可。**不要把任何密钥写进本仓库、issue 或 PR。**

## 各工具安装指南

本技能遵循各 Agent 工具的 Skill 规范。**AI 拿到本仓库后，按自己工具对应的节安装。**

### Claude Code（推荐 npx 安装器）

| 项 | 值 |
|----|----|
| 技能规范路径 | `~/.claude/skills/fmode-vision/`（用户级）或 `./.claude/skills/fmode-vision/`（项目级） |
| token 配置 | 通常零配置（`env.ANTHROPIC_AUTH_TOKEN` 自动命中）；或 `FMODE_API_TOKEN` / `~/.fmode/config.json` |

```bash
npx --yes fmode-vision@latest install          # 装到 ~/.claude/skills/fmode-vision
npx --yes fmode-vision@latest workspace        # 或装到当前项目 ./.claude/skills/
npx --yes fmode-vision@latest check            # 校验安装
```

装完重启 Claude Code 会话，直接说「帮我分析这张图片里的关键内容」即可触发。

### Codex

Codex 无 skill 机制，用 **CLI 直连**方式。在 `~/.codex/AGENTS.md` 加一段：

```markdown
## 视觉识别
分析图片用：把图片路径交给 fmode-vision 技能
（git clone https://github.com/fmodecn/skill-vision.git 后按 skills/fmode-vision/SKILL.md 操作），
或在 Node 里：node --input-type=module -e "import {analyze} from '<repo>/skills/fmode-vision/scripts/vision-client.mjs'; ..."
token 从 FMODE_API_TOKEN 或 ~/.fmode/config.json 读取。
```

Codex 的视觉模型配置在 `~/.codex/config.toml` 的 `model` 字段——若该模型在多模态名单内，技能会优先用宿主模型读图。

### Gemini CLI

Gemini CLI 支持自定义命令（`~/.gemini/commands/`）。把技能装到自定义命令：

```bash
git clone https://github.com/fmodecn/skill-vision.git
mkdir -p ~/.gemini/commands
# 新建 ~/.gemini/commands/vision.toml，prompt 段写：
#   分析图片 {{args}}：按 skills/fmode-vision/SKILL.md 的工作流，
#   用 vision-client.mjs 的 analyze() 完成识别，输出结构化 JSON。
```

Gemini CLI 的模型在 `~/.gemini/settings.json` 的 `model` 字段配置（`gemini-2*`/`gemini-3*` 均在多模态名单内）。

### WorkBuddy

凡支持「SKILL.md + scripts/」目录规范的工具（WorkBuddy 等）：

| 项 | 值 |
|----|----|
| 技能规范路径 | `<工具技能目录>/fmode-vision/`（含 SKILL.md + scripts/） |
| token 配置 | `FMODE_API_TOKEN` 环境变量，或 `~/.fmode/config.json` |

```bash
git clone https://github.com/fmodecn/skill-vision.git
cp -r skill-vision/skills/fmode-vision <你的工具技能目录>/fmode-vision
```

### Hermes

复制技能目录到 Hermes 的 skills 目录，Hermes 的 skill 加载器会读取 SKILL.md：

| 项 | 值 |
|----|----|
| 技能规范路径 | `~/.hermes/skills/fmode-vision/`（或 profile 对应 skills 目录） |
| token 配置 | `FMODE_API_TOKEN` 环境变量，或 `~/.fmode/config.json` |

```bash
git clone https://github.com/fmodecn/skill-vision.git
cp -r skill-vision/skills/fmode-vision ~/.hermes/skills/
hermes skills   # 确认 fmode-vision 出现在列表
```

### 技能目录结构（所有工具通用）

```
fmode-vision/
├── SKILL.md            # 技能说明（frontmatter: name/description）
├── README.md           # 维护文档
└── scripts/
    ├── vision-client.mjs   # 运行器（Node ≥18，零依赖）
    └── prompts/
        └── room-measurement.mjs   # 毛坯房量尺 5-pass 提示词
```

## 用法

在 Claude Code 里直接自然语言触发：

```
帮我分析这张图片里的关键内容，输出结构化信息。
```

在 Node 脚本中调用：

```js
import { analyze, resolveVisionModel } from './skills/fmode-vision/scripts/vision-client.mjs';

console.log(resolveVisionModel());   // 先看会走宿主还是 Fmode API
const result = await analyze({
  imagePath: '/path/to/image.jpg',
  systemPrompt: '你是影像分析专家，输出严格 JSON',
  userPrompt: '描述图片中的关键元素',
});
// provider==='host' → 按 result.instruction 用 Read 工具读图
// provider==='fmode' → result.raw / result.parsed（API 返回）
```

## 验证

```bash
npm run smoke    # 包结构 + 模块导出 + 探测/解析链自检
```

## 安全

- **密钥零残留**：本仓库任何文件不写入真实 token/密钥；`.fmode/config.json`、`.env` 已列入 `.gitignore`
- token 只从用户目录与环境变量读取，见上方「Token 加载链」
- 发现密钥泄露请立即在 FmodeStudio 重置 token

## License

MIT
