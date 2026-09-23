---
name: skill-vision
description: "通过 Fmode API 调用视觉模型对图片、视频进行分析。适用场景：(1) 图片内容识别与结构化提取, (2) 多轮聚焦分析获取高精度结果, (3) 视频帧分析, (4) 视觉素材批量处理"
description_en: "Analyze images and videos via Fmode API vision models. Use for: (1) Image content recognition and structured extraction, (2) Multi-pass focused analysis for high-precision results, (3) Video frame analysis, (4) Batch visual material processing"
version: 1.1.0
author: Yuyang001 (FmodeAgent)
license: MPL-2.0
copyright: "Copyright (c) 2026 未来飞马 Fmode"
tags: [未来飞马, 智能体技能, 超级技能, 服务级, 图像视觉, FmodeAgent, Hermes Agent, FmodeCode, Claude Code, vision, image-analysis, multimodal, structured-output]
---

# Fmode Vision — 视觉识别技能

## Overview

本技能封装视觉识别能力：优先用**宿主 Agent 自带的多模态模型**读图（FmodeCode / Claude Code / Codex 配置的模型支持视觉时直接用，不产生任何额外调用），否则回落 Fmode API (api.fmode.cn) 的视觉模型 `glm-5.3-flash`，支持单轮和多轮分析。用户可能要求你分析图片、处理视频帧、或对视觉素材进行结构化信息提取。

## 模型选择策略（初始化时必读）

技能初始化时**先探测运行环境**，决定视觉识别走哪条路：

```
detectHostVisionModel() 探测顺序：
① FmodeCode / Claude Code 配置：./.claude/settings.json 或 ~/.claude/settings.json
   （含 settings.local.json）的 model 字段 / env.ANTHROPIC_MODEL
② Codex 配置：~/.codex/config.toml 的 model 字段
③ 环境变量 FMODE_VISION_MODEL（用户显式指定的视觉模型，直接采纳）
```

- **宿主模型命中多模态能力名单**（`claude-4*` / `claude-opus` / `claude-sonnet-4` / `gpt-4o` / `gpt-5*` / `gemini-2*` / `gemini-3*` / `o3` 等）且运行在 FmodeCode / Claude Code / Codex 会话内
  → **直接用宿主模型读图**：用你自己的 Read 工具读取图片文件，结合提示词完成分析。
  **不调 GLM、不发网络请求、不消耗 Fmode token。** 输出时注明「已用宿主多模态模型」。
- **未命中**（宿主模型不支持视觉，或独立脚本运行）
  → 回落 **Fmode API 的 `glm-5.3-flash`**（替代旧的 `doubao-seed-2-0-pro-260215`）。

代码入口：

```js
import { resolveVisionModel, analyze } from './scripts/vision-client.mjs';

resolveVisionModel();   // => { provider: 'host'|'fmode', model, source }
                        //    host: 宿主多模态模型；fmode: glm-5.3-flash（默认回落）

// analyze() 是总入口：自动按上面的策略分发
const result = await analyze({ imagePath, systemPrompt, userPrompt });
if (result.provider === 'host') {
  // 用 Read 工具读 result.imagePath，按 systemPrompt+userPrompt 分析，输出注明「已用宿主多模态模型」
} else {
  // result.raw / result.parsed —— Fmode API 返回
}
```

## Token 获取（加载链）

仅 Fmode API 路径需要 token（宿主多模态路径零 token）。按以下优先级查找（第0级自举 → 回落）：

0. **第0级自举**：`FMODE_SESSION_TOKEN` 或 `~/.fmode/config.json` 的 `sessionToken` → 调 fmode API 动态换取 API token（登录 FMODE Studio 即可，无需手工配置；token 仅内存持有，不落盘不进日志）
1. **环境变量** `FMODE_API_TOKEN`
   ```bash
   echo $FMODE_API_TOKEN
   ```
2. **用户级配置** `~/.fmode/config.json` → `fmodeApiToken` / `newapiToken` 字段
   ```bash
   cat ~/.fmode/config.json
   ```
3. **FmodeCode / Claude Code 配置** `~/.claude/settings.json`（含 settings.local.json / 项目级 `.claude/`）的 `env.ANTHROPIC_AUTH_TOKEN` —— 即 FmodeCode / Claude Code 的 `sk-` token（`sk-` 开头、非 `sk-ant-`、base 指向 fmode 时自动采纳，无需手动配置）
4. **项目级配置** `<project>/.fmode/config.json` → `fmodeApiToken` / `newapiToken`

如果四级都未找到，提示用户提供 token。**仓库与文档中不出现任何真实密钥。**

## API 调用规范（Fmode 回落路径）

- **Base URL**: `https://api.fmode.cn`
- **Endpoint**: `POST /v1/chat/completions`
- **Auth**: `Authorization: Bearer <token>`
- **默认视觉模型**: `glm-5.3-flash`
- **备选模型**: 调用时传 `model` 参数覆盖（如 `glm-4.6v`，以账号可用列表为准）

### 请求体结构

```json
{
  "model": "glm-5.3-flash",
  "messages": [
    { "role": "system", "content": "系统提示词" },
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "用户提示词" },
        { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,<base64>" } }
      ]
    }
  ],
  "temperature": 0.12,
  "max_tokens": 2000
}
```

### 视觉内容支持

| 类型 | 传递方式 | 适用场景 |
|------|---------|---------|
| 本地图片 | `data:image/<fmt>;base64,<data>` | jpg/png/webp |
| 远程图片 | 直接 URL | 需模型支持公网访问 |
| 视频 | `type: "video_url"` | 模型自动抽帧 |

## 核心工作流

### 决策树

```
需要分析视觉内容？
├── 宿主多模态命中（FmodeCode / Claude Code / Codex 视觉模型）→ Read 工具直接读图
├── 简单描述/单维度提取 → 单轮分析 (analyze / callVisionAPI)
├── 多维度精确标注 → 多轮聚焦分析 (callMultiPass)
│   ├── 每轮独立调用，专注一个维度
│   ├── 中间结果写入缓存目录
│   └── 最后一轮合并所有结果
└── 批量处理 → 遍历 + 单轮/多轮
```

### 单轮分析

使用 `scripts/vision-client.mjs` 的 `analyze()`（推荐，自动选路）或 `callVisionAPI()`（强制走 Fmode API）：

```js
import { analyze, resolveApiToken } from './scripts/vision-client.mjs';

const result = await analyze({
  imagePath: '/path/to/image.jpg',
  systemPrompt: '你是一位影像分析专家...',
  userPrompt: '请描述这张图片中的关键元素...',
  maxTokens: 1000,
});
// result = { provider, model, raw, parsed, error, usage, instruction? }
// provider==='host' 时按 instruction 用 Read 工具读图完成分析
```

### 多轮聚焦分析

使用 `callMultiPass()` 封装，适用于需要从不同维度精确分析的场景：

```js
import { callMultiPass } from './scripts/vision-client.mjs';

const passes = [
  { name: 'structure', systemPrompt: '...', userPrompt: '...', maxTokens: 2000 },
  { name: 'details', systemPrompt: '...', userPrompt: '...', maxTokens: 1000 },
];

const results = await callMultiPass({
  imagePath: '/path/to/image.jpg',
  passes,
  cacheDir: '/tmp/analysis/image-id/',
});
```

## 提示词工程

### 结构化输出

始终要求模型输出严格 JSON，在 system prompt 中给出完整 schema：

```
## 输出格式（严格JSON，无markdown代码块）
{
  "field1": "value",
  "field2": [{ "sub": "value" }]
}
```

### 聚焦原则

多轮分析中每轮只关注一个维度，明确告知模型忽略其他内容：
```
## 规则
1. 只标注 X 类元素，忽略 Y、Z 等其他所有元素
2. 每个元素标注精确的 boundingBox
```

### JSON 提取

模型可能包裹 markdown 代码块，使用 `extractJSON()` 提取：

```js
import { extractJSON } from './scripts/vision-client.mjs';
const parsed = extractJSON(rawResponse);
```

## 结果缓存

多轮分析支持中间结果缓存：
- 每轮结果写入 `cacheDir/pass<N>.json`
- 重新运行时自动跳过已有缓存
- 如需强制重新分析，删除对应缓存文件

## 领域模块

### 毛坯房量尺分析

`scripts/prompts/room-measurement.mjs` 提供 5-pass 量尺分析提示词：
- Pass 1: 空间结构（透视/墙面/阴阳角）
- Pass 2: 吊顶特征（cornice/trayStep/beam/bulkhead）
- Pass 3: 门窗洞口（双层框架）
- Pass 4: 障碍物（精确 boundingBox）
- Pass 5: 合并 + 测量计划

```js
import { processPhoto } from './scripts/prompts/room-measurement.mjs';
const merged = await processPhoto('/path/to/photo.jpg', 'photo-001', 'photo-001.jpg');
```
