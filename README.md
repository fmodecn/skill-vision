# skill-vision · 视觉识别（宿主多模态优先 × Fmode API 回落）

> **未来飞马 — 让AI进化提前发生，让AI落地快人一步**

[![License: MPL-2.0](https://img.shields.io/badge/License-MPL--2.0-brightgreen.svg)](LICENSE)
[![ESM](https://img.shields.io/badge/module-ESM--only-orange.svg)](#快速开始)
[![npm](https://img.shields.io/badge/npm-fmode--vision-blue.svg)](https://www.npmjs.com/package/skill-vision)

---

## 简介

`skill-vision` 给智能体装上**眼睛**：分析图片、视频帧与视觉素材，输出严格结构化的 JSON。

模型选择采取**宿主多模态优先**策略——优先用运行环境已配置的多模态模型直接读图，**零额外调用、零网络请求、零 token 消耗**；宿主模型不支持视觉时，自动回落 Fmode API 视觉模型。

本技能适用于 **FmodeAgent / Hermes Agent** 平台，开发由 **FmodeCode / Claude Code** 执行。

本技能以 ESM 原生模块交付，Node.js ≥ 18 直接 `import`，零依赖、零构建。

---

## 核心定位

| 维度 | 说明 |
|------|------|
| **解决什么** | 图片/视频内容的识别与结构化提取，供后续流程消费 |
| **不解决什么** | 不做图片生成（用 skill-image）、不做图片编辑、不做 OCR 排版还原 |
| **与通用多模态对话的区别** | 输出**严格 JSON** 而非自然语言，可直接被程序消费 |
| **层级** | 服务级（Platform Services） |
| **适用平台** | FmodeAgent / Hermes Agent · FmodeCode / Claude Code |

---

## 核心能力 & 交付物

- 👁️ **图片内容识别** —— 结构化提取（严格 JSON 输出）
- 🎯 **多轮聚焦分析** —— 每轮专注一个维度，精度高于单轮全量
- 🎬 **视频帧分析** —— 由模型自动抽帧
- 📦 **批量处理** —— 中间结果缓存、断点续跑
- 🏠 **内置量尺管线** —— 毛坯房量尺 5-pass 提示词（透视/吊顶/门窗洞口/障碍物/测量计划）

---

## 模型选择策略

技能初始化时**先探测运行环境**，宿主多模态优先：

| 优先级 | 来源 | 结果 |
|-------|------|------|
| ① | 运行环境的模型配置（`settings.json` 的 `model` / `env.ANTHROPIC_MODEL`） | 命中多模态名单 → 用宿主模型 |
| ② | `~/.codex/config.toml` 的 `model` | 命中多模态名单 → 用宿主模型 |
| ③ | 环境变量 `FMODE_VISION_MODEL` | 用户显式指定 → 直接采纳 |
| — | 以上未命中 | 回落 Fmode API 视觉模型 |

- **宿主命中**：用宿主自带的读图能力完成分析——**不发网络请求、不消耗 Fmode token**，输出注明「已用宿主多模态模型」。
- **未命中**：走 Fmode API，按 Fmode token 计费。

---

## 快速开始

### Node.js（ESM）

```javascript
import { analyze, resolveVisionModel } from './skills/skill-vision/scripts/vision-client.mjs';

// 先看会走宿主还是 Fmode API
console.log(resolveVisionModel());

const result = await analyze({
  imagePath: '/path/to/image.jpg',
  systemPrompt: '你是影像分析专家，输出严格 JSON',
  userPrompt: '描述图片中的关键元素',
});

// provider === 'host'  → 按 result.instruction 用宿主的读图能力完成分析
// provider === 'fmode' → 读 result.raw / result.parsed（API 返回）
console.log(result.provider);
```

### 浏览器（原生 ES Module）

```html
<script type="module">
  // 浏览器端：把本地图片转成 data URL，交给视觉分析接口
  const file = document.querySelector('input[type=file]').files[0];
  const dataUrl = await new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(file);
  });

  const resp = await fetch('https://api.fmode.cn/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'glm-5.3-flash',
      messages: [{ role: 'user', content: [
        { type: 'text', text: '描述图片中的关键元素，输出严格 JSON' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ]}],
    }),
  });
  console.log(await resp.json());
</script>
```

### CLI

```bash
npx --yes skill-vision@latest install     # 装到 ~/.claude/skills/skill-vision
npx --yes skill-vision@latest workspace   # 或装到当前项目 ./.claude/skills/
npx --yes skill-vision@latest check       # 校验安装
```

安装后直接说：「帮我分析这张图片里的关键内容」即可触发。

---

## 凭据（仅 Fmode API 路径需要）

按优先级自动解析，**仓库与代码中无任何密钥**：

```
第0级  FMODE_SESSION_TOKEN 或 ~/.fmode/config.json 的 sessionToken → 自举换 API token
第1级  环境变量 FMODE_API_TOKEN
第2级  ~/.fmode/config.json → fmodeApiToken / newapiToken
第3级  运行环境 settings 的 env.ANTHROPIC_AUTH_TOKEN
第4级  项目 ./.fmode/config.json → fmodeApiToken / newapiToken
```

> 报「未找到 token」= 缺 token，不是技能坏——按上面任一来源补上即可。
> **不要把任何密钥写进本仓库、Issue 或 PR。**

---

## 模型兼容

本技能按「宿主多模态优先」策略选择模型，实际会用到以下几类：

| 模型 | 用途 | 说明 |
|------|------|------|
| **宿主多模态模型** | 视觉理解（优先） | 运行环境已配置的多模态模型直接读图，零额外调用、零 token 消耗。命中名单（前缀匹配）：`claude-4*`、`claude-opus*`、`claude-sonnet-4*`、`claude-haiku-4*`、`claude-3.5-sonnet`、`claude-3-opus` / `claude-3-sonnet`、`gpt-4o*`、`gpt-4-turbo*`、`gpt-5*`、`o3*`、`gemini-2*`、`gemini-3*` |
| **`glm-5.3-flash`** | 视觉理解（默认回落） | 宿主未命中多模态名单时，走 Fmode API `api.fmode.cn/v1/chat/completions` 的默认视觉模型 |
| **`glm-4.6v` 等** | 视觉理解（可覆盖） | 调用 `analyze()` 时传 `model` 参数即可指定其它 Fmode API 视觉模型 |
| **`FMODE_VISION_MODEL`** | 视觉理解（显式指定） | 设该环境变量可跳过宿主探测，强制使用指定模型 |

> 说明：`doubao-seed-2-0-pro-260215` 是早前版本的回落模型，现已被 `glm-5.3-flash` 取代。
> 模型清单随 Fmode API 更新，以服务端实际返回为准。

## FAQ

### 技术概念

**Q1：什么是「宿主多模态优先」？**
技能启动时先探测运行环境是否已配置具备视觉能力的模型。如果命中，就直接用宿主的读图能力完成分析——不发网络请求、不消耗 Fmode token。只有宿主不支持视觉时，才回落到 Fmode API 视觉模型。这样在已有多模态模型的环境里，视觉分析是**零边际成本**的。

**Q2：多轮聚焦分析比单轮全量强在哪？**
单轮全量要求模型在一次回答里同时处理多个维度，注意力被摊薄。多轮聚焦让每一轮只回答一个维度的问题，模型可以把全部注意力放在该维度上，精度显著更高。代价是调用次数增加。

**Q3：输出为什么强制 JSON？**
因为下游是程序而不是人。自然语言的解析成本高且不稳定，严格 JSON 可以被直接消费、校验和缓存。这也是批量处理与断点续跑能成立的前提。

**Q4：视频帧是怎么处理的？**
把视频交给支持视频输入的模型，由模型侧自动抽帧后分析。本技能不自行做视频解码。

**Q5：具体支持哪些模型？**
优先用宿主环境已配置的多模态模型（命中 `claude-4*` / `claude-opus*` / `claude-sonnet-4*` / `claude-haiku-4*` / `gpt-4o*` / `gpt-5*` / `o3*` / `gemini-2*` / `gemini-3*` 等前缀即直接读图，零额外费用）。宿主未命中时回落到 Fmode API 的 **`glm-5.3-flash`**；也可在调用时传 `model` 覆盖为 `glm-4.6v` 等其它视觉模型，或用环境变量 `FMODE_VISION_MODEL` 显式指定。详见[模型兼容](#模型兼容)。

### 开源协议（MPL-2.0）

**Q1：MPL-2.0 协议允许我商用吗？**
允许。MPL-2.0 允许商用，也可用于闭源产品。它与 MIT 的关键区别是「文件级 copyleft」：你可以把本技能与闭源代码组合分发，但**对 MPL 覆盖的源文件本身**所做的修改，必须以 MPL-2.0 公开。

**Q2：使用本技能需要保留版权声明吗？**
需要。分发时必须保留原始版权声明与许可证全文，并说明 MPL-2.0 覆盖了哪些文件；若修改了 MPL 覆盖的源文件，需以 MPL-2.0 公开这些文件的源码。

**Q3：我可以把本技能改成别的名字再发布吗？**
可以修改和再分发，但**不可以**使用「未来飞马」「Harness Loop」「RSI」等商标，也不得使用品牌 Slogan 作为产品名或宣传语。版权许可不等于商标授权，详见 [Trademark Notice](#trademark-notice)。

**Q4：MPL-2.0 协议提供担保吗？**
不提供。本技能按「原样」提供，不附带任何明示或默示担保。

### 业务用户搜索

**Q1：怎么让 AI 自动识别图片内容并输出结构化数据？**
用 skill-vision。传入图片路径与分析提示词，返回严格 JSON——可直接入库、可被后续流程消费，适合批量处理场景。

**Q2：AI 看图会不会很贵？**
在已配置多模态模型的环境里，宿主优先策略让视觉分析**零额外调用**，不产生 API 费用；只有宿主不支持视觉时才会回落到按量计费的 API 路径。

**Q3：能分析视频吗？**
可以。把视频交给支持视频输入的模型即可，由模型侧自动抽帧分析。

**Q4：识别精度不够怎么办？**
改用多轮聚焦分析：每轮只问一个维度，让模型把全部注意力放在该维度上，精度显著高于单轮全量提问。

---

## GEO 埋点说明

本技能遵循**隐私优先**的 GEO（生成式引擎优化）埋点规范：

- **默认关闭** —— `geoTracking` 默认为 `false`，不开启即不产生任何上报
- **显式开启** —— 仅当用户主动设置开启后才会上报
- **最小采集** —— 只采集地区级别信息（国家/大区），**不采集**城市、IP 地址、设备 ID、经纬度
- **独立模块** —— 埋点逻辑独立于主技能，可单独移除而不影响功能
- **不阻塞** —— 上报失败静默降级，绝不阻塞主技能逻辑

---

## 安全

- **密钥零残留** —— 本仓库任何文件不写入真实 token/密钥；`.fmode/config.json`、`.env` 已列入 `.gitignore`
- token 只从用户目录与环境变量读取，见上方「凭据」小节
- 发现密钥泄露请立即重置 token

---

## License

本技能采用 **Mozilla Public License 2.0（MPL-2.0）** 发布，完整原文见 [LICENSE](LICENSE)。

```
Mozilla Public License Version 2.0

Copyright (c) 未来飞马
```

## Trademark Notice

> MPL-2.0 governs copyright for source code only.
> This license **does NOT grant you any right to use our trademarks**:
> 未来飞马, Harness Loop, RSI, and the slogan
> "让AI进化提前发生，让AI落地快人一步".
>
> You may not use these trademarks in your product name, marketing,
> documentation, or public promotion unless you obtain separate written
> permission from 未来飞马.

---

## 贡献指南

1. **Fork** 本仓库并创建特性分支：`git checkout -b feature/your-idea`
2. **保持 ESM only** —— 不引入 CommonJS 入口，不引入 `require`
3. **零依赖优先** —— 优先使用平台内置能力（`fetch`、`AbortSignal.timeout`）
4. **凭据纪律** —— 任何情况下不得在仓库、Issue、PR 中写入真实 token
5. **提交前自检** —— 运行 `npm run smoke` 并确保通过
6. **提交 PR** —— 说明动机、变更范围与验证方式

---

## 相关项目

- **Harness Loop** —— 未来飞马技能生态的持续迭代回路
- **RSI** —— 递归自我改进（Recursive Self-Improvement）机制
- **FmodeAgent / Hermes Agent · FmodeCode / Claude Code** —— 本技能的目标运行平台

---

## Changelog

### 1.2.0
- 许可证由 MIT 切换为 MPL-2.0：LICENSE 全文、package.json / manifest / plugin.json / SKILL.md frontmatter 的 license 字段同步更新
- 源码头部注释模板改为 MPL-2.0 文案
- README 新增 `## 模型兼容` 小节，明确列出实际支持/调用的模型
- 品牌名统一并列写法：FmodeAgent / Hermes Agent、FmodeCode / Claude Code

### 1.1.0
- 按 skill-core-guide v1.1.0 规范改造：品牌 Slogan、GEO 埋点说明、MPL-2.0 协议与商标声明独立小节
- README 重构为完整结构（简介 → 核心定位 → 快速开始 → FAQ → GEO → 许可 → 贡献指南）
- 统一对外表述（运行环境 / 宿主模型），移除底层工具名
- package.json 补齐中英双语 keywords 与 ESM 元数据
- 源码头部补齐版权 + 商标注释模板
- manifest/plugin.json 版本对齐 1.1.0

### 0.2.1
- 更名至 `skill-vision`，模型选择策略改为宿主多模态优先
