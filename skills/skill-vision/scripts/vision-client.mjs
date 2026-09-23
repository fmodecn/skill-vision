// Copyright (c) 未来飞马
//
// Licensed under the MIT License. See LICENSE in the project root
// for the full license text.
//
// Trademark Notice:
// The MIT license grants copyright permissions for source code only.
// It does NOT grant any rights to use trademarks including "未来飞马",
// "Harness Loop", "RSI", and associated slogan "让AI进化提前发生，让AI落地快人一步".
// Any use of these trademarks requires separate written permission.
/**
 * Fmode Vision API 通用客户端
 *
 * 功能：
 *   - resolveApiToken()         按 token 加载链获取 API token（仓库内零密钥）
 *   - detectHostVisionModel()   宿主多模态优先探测（Claude Code / Codex）
 *   - resolveVisionModel()      模型选择策略入口：host 优先，回落 Fmode glm-5.3-flash
 *   - analyze()                 单次视觉分析总入口（自动走宿主或 Fmode API）
 *   - callVisionAPI()           单轮 Fmode 视觉分析
 *   - callMultiPass()           多轮聚焦分析（支持缓存）
 *   - extractJSON()             从 LLM 响应提取 JSON
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ============================================================
// Token 加载链（与 voc / fmode-listen 共享层一致）
// ============================================================
//
// 优先级（第0级为 sessionToken 自举，其余为回落链）：
//   0. sessionToken 自举：FMODE_SESSION_TOKEN 环境变量或 ~/.fmode/config.json 的
//      sessionToken → POST https://server.fmode.cn/api/fmode/voc-skill/install-prompt
//      → 从返回 prompt 中提取 fmode API token（sk- 开头，排除 sk-ant-）。
//      ⚠️ token 仅内存持有，不落盘不进日志。
//   1. 环境变量 FMODE_API_TOKEN
//   2. ~/.fmode/config.json → fmodeApiToken / newapiToken
//   3. ~/.claude/settings.json（含 settings.local.json / 项目级 .claude/）
//      的 env.ANTHROPIC_AUTH_TOKEN——即 Claude Code 的 sk- token
//   4. 项目 ./.fmode/config.json → fmodeApiToken / newapiToken
//
// 关键：fmode 的 newapi SK 默认就是 Claude Code 的 env.ANTHROPIC_AUTH_TOKEN。
// 校验规则：sk- 开头、排除真 Anthropic 官方 key（sk-ant- 开头）、
// 若设了 ANTHROPIC_BASE_URL 则必须指向 fmode。
//
// 注意：本仓库内绝不出现任何真实密钥——token 只从上述用户目录/环境读取。

// UTF-8 BOM（EF BB BF）：用户手工保存的 config.json 可能带 BOM，解析前剥掉。
const BOM_RE = /^﻿/;

const FMODE_API_BASE = (process.env.FMODE_API_BASE || 'https://server.fmode.cn').replace(/\/$/, '');

/** 第0级：解析 sessionToken（env FMODE_SESSION_TOKEN → ~/.fmode/config.json）。找不到返回 null。 */
function resolveSessionToken() {
  if (process.env.FMODE_SESSION_TOKEN) return process.env.FMODE_SESSION_TOKEN.trim();
  const p = path.join(os.homedir(), '.fmode', 'config.json');
  try {
    if (!fs.existsSync(p)) return null;
    const cfg = JSON.parse(fs.readFileSync(p, 'utf-8').replace(BOM_RE, ''));
    const t = cfg.sessionToken || (cfg.user && cfg.user.sessionToken) || null;
    return t && String(t).trim() ? String(t).trim() : null;
  } catch { return null; }
}

/**
 * 第0级：sessionToken → fmode API token（自举）。
 * 服务端唯一以 session 鉴权并返回 token 本体的端点是 voc-skill 安装指令生成器；
 * token 内嵌在返回 prompt 文本中，这里提取后仅内存持有（不落盘不进日志）。
 * @returns {Promise<string|null>} 提取失败返回 null（调用方回落下一级）。
 */
async function fetchApiTokenFromSession(sessionToken) {
  if (!sessionToken) return null;
  try {
    const res = await fetch(`${FMODE_API_BASE}/api/fmode/voc-skill/install-prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-parse-session-token': sessionToken },
      body: JSON.stringify({ channel: 'claude-code', scope: 'user', source: 'skill-token-bootstrap' }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const prompt = body && body.data && typeof body.data.prompt === 'string' ? body.data.prompt : '';
    const m = prompt.match(/sk-(?!ant-)[A-Za-z0-9_-]{8,}/);
    return m ? m[0] : null;
  } catch { /* 网络失败一律回落，不泄露错误细节 */ }
  return null;
}

function readJsonMaybe(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, 'utf-8').replace(BOM_RE, ''));
  } catch {
    return {};
  }
}

function readTokenFromConfig(configPath) {
  try {
    if (!fs.existsSync(configPath)) return null;
    const raw = fs.readFileSync(configPath, 'utf-8').replace(BOM_RE, '');
    const cfg = JSON.parse(raw);
    return cfg.fmodeApiToken || cfg.newapiToken || null;
  } catch {
    return null;
  }
}

// 合并读取 Claude Code 的 settings env（用户级 + 项目级，含 .local 覆盖文件）。
function readClaudeSettingsEnv() {
  const files = [
    path.join(os.homedir(), '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.local.json'),
    path.join(process.cwd(), '.claude', 'settings.json'),
    path.join(process.cwd(), '.claude', 'settings.local.json'),
  ];
  const merged = {};
  for (const filePath of files) {
    const json = readJsonMaybe(filePath);
    const env = json && typeof json.env === 'object' && json.env ? json.env : null;
    if (!env) continue;
    for (const [key, value] of Object.entries(env)) {
      if (merged[key] === undefined && typeof value === 'string' && value.trim()) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

// 仅当 ANTHROPIC_AUTH_TOKEN 看起来是 fmode 的 newapi SK 时才采纳：
// - 必须 sk- 开头，且排除真 Anthropic 官方 key（sk-ant- 开头）；
// - 若设了 ANTHROPIC_BASE_URL，必须指向 fmode（否则这把 token 是发往别处的）。
function pickFmodeAnthropicToken(env) {
  const token = env && typeof env.ANTHROPIC_AUTH_TOKEN === 'string' ? env.ANTHROPIC_AUTH_TOKEN.trim() : '';
  if (!token || !/^sk-/i.test(token) || /^sk-ant-/i.test(token)) return '';
  const base = String((env && (env.ANTHROPIC_BASE_URL || env.ANTHROPIC_API_BASE)) || '').toLowerCase();
  if (base && !base.includes('fmode')) return '';
  return token;
}

/**
 * 获取 fmode API token。加载链优先级（第0级自举 → 回落）：
 *   0. sessionToken 自举（FMODE_SESSION_TOKEN 或 ~/.fmode/config.json）→ fmode API 换取
 *   1. 环境变量 FMODE_API_TOKEN
 *   2. ~/.fmode/config.json → fmodeApiToken / newapiToken（FmodeStudio 保存写这里）
 *   3. ~/.claude/settings.json 等 → env.ANTHROPIC_AUTH_TOKEN（sk- 开头非 sk-ant-）
 *   4. <project>/.fmode/config.json → fmodeApiToken / newapiToken
 *
 * @param {string} [projectRoot] 项目根目录，默认 process.cwd()
 * @returns {Promise<{ token: string, source: string }>}
 */
export async function resolveApiToken(projectRoot) {
  // 第0级自举：sessionToken → fmode API 换取
  const sessionToken = resolveSessionToken();
  if (sessionToken) {
    const bootstrapped = await fetchApiTokenFromSession(sessionToken);
    if (bootstrapped) {
      return { token: bootstrapped, source: 'level0:sessionToken->fmode-api' };
    }
    // 自举失败：明确报错指向重新登录，随后回落
    console.error('sessionToken 存在但换取 fmode API token 失败——sessionToken 缺失或失效，请重新登录 FMODE Studio 或配置 FMODE_SESSION_TOKEN');
  }

  // 1. 环境变量
  if (process.env.FMODE_API_TOKEN) {
    return { token: process.env.FMODE_API_TOKEN, source: 'env:FMODE_API_TOKEN' };
  }

  // 2. 用户级配置 ~/.fmode/config.json
  const userConfigPath = path.join(os.homedir(), '.fmode', 'config.json');
  const userToken = readTokenFromConfig(userConfigPath);
  if (userToken) {
    return { token: userToken, source: userConfigPath };
  }

  // 3. Claude Code 默认入口：~/.claude/settings.json（含 .local / 项目级）里的
  //    env.ANTHROPIC_AUTH_TOKEN（sk- token，Claude Code 会话内也常被注入进程环境）
  const injected = pickFmodeAnthropicToken(process.env);
  if (injected) {
    return { token: injected, source: 'env:ANTHROPIC_AUTH_TOKEN' };
  }
  const claudeEnv = readClaudeSettingsEnv();
  const fromSettings = pickFmodeAnthropicToken(claudeEnv);
  if (fromSettings) {
    return { token: fromSettings, source: '~/.claude/settings.json:env.ANTHROPIC_AUTH_TOKEN' };
  }

  // 4. 项目级配置 <project>/.fmode/config.json
  const root = projectRoot || process.cwd();
  const projectConfigPath = path.join(root, '.fmode', 'config.json');
  const projectToken = readTokenFromConfig(projectConfigPath);
  if (projectToken) {
    return { token: projectToken, source: projectConfigPath };
  }

  throw new Error(
    '未找到 Fmode API token。请通过以下任一方式提供（第0级自举 → 回落）：\n' +
    '  0. 登录 FMODE Studio 后自动自举（FMODE_SESSION_TOKEN 或 ~/.fmode/config.json 的 sessionToken）\n' +
    '  1. 环境变量 FMODE_API_TOKEN\n' +
    '  2. ~/.fmode/config.json 中 fmodeApiToken / newapiToken 字段（FmodeStudio 保存配置后写入）\n' +
    '  3. ~/.claude/settings.json 的 env.ANTHROPIC_AUTH_TOKEN（Claude Code 的 sk- token，会自动读取）\n' +
    '  4. 项目 ./.fmode/config.json 中 fmodeApiToken 字段\n' +
    '  注意：这是缺 token，不是「用不了」——请勿点任何付费/充值弹窗。'
  );
}

// ============================================================
// 模型选择策略：宿主多模态优先探测
// ============================================================
//
// 技能初始化时先探测运行环境：
//   ① Claude Code：~/.claude/settings.json 或 ./.claude/settings.json 的
//      model 字段 / env.ANTHROPIC_MODEL，命中多模态能力名单 → 用宿主模型，
//      不调 GLM；
//   ② Codex：~/.codex/config.toml 的 model 配置；
//   ③ 环境变量 FMODE_VISION_MODEL（强制指定）。
// 命中即返回 { provider: 'host', model }；未命中回落
// { provider: 'fmode', model: 'glm-5.3-flash' }（Fmode API 视觉模型）。

const DEFAULT_CONFIG = {
  apiBase: 'https://api.fmode.cn',
  model: 'glm-5.3-flash',
  temperature: 0.12,
  maxTokens: 2000,
};

// 宿主模型多模态（视觉）能力名单。前缀匹配，大小写不敏感。
const HOST_VISION_MODEL_PATTERNS = [
  /^claude-4/i,
  /^claude-opus/i,
  /^claude-sonnet-4/i,
  /^claude-haiku-4/i,
  /^claude-3[-.]5-sonnet/i,
  /^claude-3[-.](opus|sonnet)/i,
  /^gpt-4o/i,
  /^gpt-4-turbo/i,
  /^gpt-5/i,
  /^o3/i,
  /^gemini-2/i,
  /^gemini-3/i,
];

// 已知纯文本模型：即便命中上面名单形态也判为不支持视觉。
const HOST_TEXT_ONLY_PATTERNS = [/^o1(?!-vision)/i];

function modelSupportsVision(name) {
  const n = String(name || '').toLowerCase();
  if (!n) return false;
  if (HOST_TEXT_ONLY_PATTERNS.some(re => re.test(n))) return false;
  return HOST_VISION_MODEL_PATTERNS.some(re => re.test(n));
}

function readClaudeHostModel() {
  const files = [
    path.join(process.cwd(), '.claude', 'settings.json'),
    path.join(process.cwd(), '.claude', 'settings.local.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.local.json'),
  ];
  for (const filePath of files) {
    const json = readJsonMaybe(filePath);
    // settings 的顶层 model 字段
    if (typeof json.model === 'string' && json.model.trim()) {
      return { model: json.model.trim(), source: filePath };
    }
    // env.ANTHROPIC_MODEL
    const envModel = json.env && typeof json.env === 'object'
      ? (json.env.ANTHROPIC_MODEL || json.env.ANTHROPIC_DEFAULT_OPUS_MODEL || json.env.ANTHROPIC_DEFAULT_SONNET_MODEL)
      : '';
    if (typeof envModel === 'string' && envModel.trim()) {
      return { model: envModel.trim(), source: `${filePath}:env.ANTHROPIC_MODEL` };
    }
  }
  return null;
}

// Codex：~/.codex/config.toml 里的 model = "..."（简单解析顶层 model 行）
function readCodexHostModel() {
  const tomlPath = path.join(os.homedir(), '.codex', 'config.toml');
  try {
    if (!fs.existsSync(tomlPath)) return null;
    const raw = fs.readFileSync(tomlPath, 'utf-8');
    const m = raw.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
    if (m && m[1].trim()) return { model: m[1].trim(), source: tomlPath };
  } catch { /* ignore */ }
  return null;
}

function isHostAgentSession() {
  // 运行在 Claude Code / Codex 会话内的常用信号
  return Boolean(
    process.env.CLAUDECODE ||
    process.env.CLAUDE_CODE_ENTRYPOINT ||
    process.env.CODEX_SANDBOX ||
    process.env.CODEX_HOME
  );
}

/**
 * 探测宿主是否自带多模态（视觉）模型。
 * 探测顺序：① Claude Code settings ② Codex config.toml ③ FMODE_VISION_MODEL。
 *
 * @returns {{ provider: 'host', model: string, source: string } | null}
 *          命中宿主多模态时返回，否则 null（回落 Fmode API）
 */
export function detectHostVisionModel() {
  // ③ 环境变量强制指定（最高优先：用户显式声明的视觉模型，直接采纳）
  const forced = process.env.FMODE_VISION_MODEL;
  if (forced && forced.trim()) {
    return { provider: 'host', model: forced.trim(), source: 'env:FMODE_VISION_MODEL' };
  }

  // ① Claude Code settings（项目级优先于用户级）
  const claude = readClaudeHostModel();
  if (claude && modelSupportsVision(claude.model)) {
    return { provider: 'host', model: claude.model, source: claude.source };
  }

  // ② Codex config.toml
  const codex = readCodexHostModel();
  if (codex && modelSupportsVision(codex.model)) {
    return { provider: 'host', model: codex.model, source: codex.source };
  }

  return null;
}

/**
 * 模型选择策略总入口：
 * - 宿主（Claude Code / Codex）配置模型支持多模态 → 用宿主模型，不调 GLM
 * - 否则回落 Fmode API 的 glm-5.3-flash
 *
 * @param {string} [explicitModel] 调用方显式指定的模型（最高优先）
 * @returns {{ provider: 'host'|'fmode', model: string, source: string }}
 */
export function resolveVisionModel(explicitModel) {
  if (explicitModel && explicitModel.trim()) {
    return { provider: 'fmode', model: explicitModel.trim(), source: 'explicit' };
  }
  const host = detectHostVisionModel();
  if (host) return host;
  return { provider: 'fmode', model: DEFAULT_CONFIG.model, source: 'fmode-default' };
}

// ============================================================
// 宿主多模态直读（Claude Code / Codex 会话内）
// ============================================================
//
// 当 detectHostVisionModel() 命中且运行在宿主 Agent 会话内时，
// analyze() 不发网络请求，而是把图片交给宿主 Agent 用自带的 Read 工具读图、
// 按传入的提示词完成识别。返回结构与 callVisionAPI() 一致，
// 上层（SKILL.md 工作流）拿到结果后无感知。

/**
 * 生成交给宿主 Agent 的读图指令。
 * AI（Claude Code / Codex）应使用自己的 Read 工具读取 imagePath 的图片，
 * 结合 systemPrompt + userPrompt 完成分析，并把输出喂回 analyze() 的宿主路径。
 *
 * @param {Object} opts 与 analyze() 相同的参数
 * @returns {{ provider: 'host', model: string, source: string,
 *              instruction: string, imagePath?: string }}
 */
export function buildHostReadInstruction(opts) {
  const resolved = resolveVisionModel(opts && opts.model);
  const imagePath = opts && (opts.imagePath || opts.imageUrl || opts.videoUrl) || '';
  const instruction = [
    `[宿主多模态模式] 请使用你的 Read 工具直接读取图片文件：${imagePath}`,
    `(已用宿主多模态模型：${resolved.model}，来源：${resolved.source}；本次不调用 Fmode API / GLM)`,
    '',
    '系统提示词：',
    String(opts && opts.systemPrompt || ''),
    '',
    '用户提示词：',
    String(opts && opts.userPrompt || ''),
    '',
    '请按提示词要求完成识别并输出结果。',
  ].join('\n');
  return { provider: 'host', model: resolved.model, source: resolved.source, instruction, imagePath };
}

// ============================================================
// 分析总入口
// ============================================================

/**
 * 单次视觉分析总入口：宿主多模态优先，回落 Fmode API。
 *
 * - 宿主命中且运行在 Claude Code / Codex 会话内 → 返回 { provider:'host', ...,
 *   instruction }，AI 用自己的 Read 工具读图后按提示词分析，不再调 GLM；
 * - 否则走 Fmode API（glm-5.3-flash）。
 *
 * @param {Object} opts 同 callVisionAPI()：
 *   imagePath | imageBase64 | imageUrl | videoUrl + systemPrompt + userPrompt
 *   + 可选 model / temperature / maxTokens / apiToken
 * @returns {Promise<{ provider: 'host'|'fmode', model: string,
 *   raw?: string, parsed: object|null, error: string|null, usage: object|null,
 *   instruction?: string }>}
 */
export async function analyze(opts) {
  const resolved = resolveVisionModel(opts && opts.model);

  // 宿主多模态命中 + 运行在宿主 Agent 会话内 → 交给宿主读图，不调 Fmode API
  if (resolved.provider === 'host') {
    if (isHostAgentSession()) {
      const host = buildHostReadInstruction(opts);
      return {
        provider: 'host',
        model: host.model,
        raw: null,
        parsed: null,
        error: null,
        usage: null,
        instruction: host.instruction,
        imagePath: host.imagePath,
      };
    }
    // 探测到宿主多模态模型但不在会话内（如脚本独立运行）→ 回落 Fmode API
    return runFmodeVision({ ...opts, model: DEFAULT_CONFIG.model });
  }

  // Fmode API 路径
  return runFmodeVision(opts);
}

async function runFmodeVision(opts) {
  const result = await callVisionAPI(opts);
  return { provider: 'fmode', model: (opts && opts.model) || DEFAULT_CONFIG.model, ...result };
}

// ============================================================
// Fmode API 调用
// ============================================================

/**
 * 调用 Fmode Vision API
 *
 * @param {Object} opts
 * @param {string} [opts.imagePath]    本地图片路径
 * @param {string} [opts.imageBase64]  图片 base64 数据（与 imagePath 二选一）
 * @param {string} [opts.imageUrl]     远程图片 URL
 * @param {string} [opts.videoUrl]     视频 URL
 * @param {string} opts.systemPrompt   系统提示词
 * @param {string} opts.userPrompt     用户提示词
 * @param {string} [opts.model]        模型名，默认 glm-5.3-flash
 * @param {number} [opts.temperature]  默认 0.12
 * @param {number} [opts.maxTokens]    默认 2000
 * @param {string} [opts.apiToken]     手动传入 token，否则自动解析
 * @returns {Promise<{ raw: string, parsed: object|null, error: string|null, usage: object|null }>}
 */
export async function callVisionAPI(opts) {
  const {
    imagePath, imageBase64, imageUrl, videoUrl,
    systemPrompt, userPrompt,
    model, temperature, maxTokens, apiToken,
  } = opts;

  const token = apiToken || (await resolveApiToken()).token;
  const messages = [{ role: 'system', content: systemPrompt }];

  const userContent = [{ type: 'text', text: userPrompt }];

  // 视觉内容
  if (imagePath) {
    const buffer = fs.readFileSync(imagePath);
    const ext = path.extname(imagePath).slice(1).toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    const b64 = buffer.toString('base64');
    userContent.push({
      type: 'image_url',
      image_url: { url: `data:${mime};base64,${b64}` },
    });
  } else if (imageBase64) {
    userContent.push({
      type: 'image_url',
      image_url: { url: imageBase64 },
    });
  } else if (imageUrl) {
    userContent.push({
      type: 'image_url',
      image_url: { url: imageUrl },
    });
  } else if (videoUrl) {
    userContent.push({
      type: 'video_url',
      video_url: { url: videoUrl },
    });
  }

  messages.push({ role: 'user', content: userContent });

  const body = {
    model: model || DEFAULT_CONFIG.model,
    messages,
    temperature: temperature ?? DEFAULT_CONFIG.temperature,
    max_tokens: maxTokens || DEFAULT_CONFIG.maxTokens,
  };

  const res = await fetch(`${DEFAULT_CONFIG.apiBase}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '';

  const { parsed, error } = extractJSON(content);

  return { raw: content, parsed, error, usage: data.usage || null };
}

// ============================================================
// JSON 提取
// ============================================================

/**
 * 从 LLM 响应中提取 JSON 对象
 * 容忍 markdown 代码块包裹、前后文字
 */
export function extractJSON(rawContent) {
  const m = rawContent.match(/\{[\s\S]*\}/);
  if (!m) return { parsed: null, error: 'No JSON object in response' };

  try {
    return { parsed: JSON.parse(m[0]), error: null };
  } catch (e) {
    return { parsed: null, error: e.message };
  }
}

// ============================================================
// 多轮分析
// ============================================================

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * 多轮聚焦分析
 * 每轮独立调用 API，中间结果写入缓存目录。已有缓存则跳过。
 *
 * @param {Object} opts
 * @param {string} opts.imagePath       图片路径
 * @param {Array}  opts.passes           轮次配置数组
 *   [{ name: string, systemPrompt: string, userPrompt: string, maxTokens?: number }]
 * @param {string} opts.cacheDir         缓存目录
 * @param {string} [opts.model]          模型名
 * @param {number} [opts.delayMs=1500]   轮次间延迟
 * @returns {Promise<Array<{ pass: number, name: string, raw: string, parsed: object|null, error: string|null, usage: object|null }>>}
 */
export async function callMultiPass(opts) {
  const { imagePath, passes, cacheDir, model, delayMs = 1500 } = opts;

  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  const results = [];

  for (let i = 0; i < passes.length; i++) {
    const p = passes[i];
    const passNum = i + 1;
    const cacheFile = path.join(cacheDir, `pass${passNum}.json`);

    // 检查缓存
    if (fs.existsSync(cacheFile)) {
      console.log(`  Pass ${passNum} (${p.name}): 已有缓存，跳过`);
      results.push(JSON.parse(fs.readFileSync(cacheFile, 'utf-8')));
      continue;
    }

    console.log(`  Pass ${passNum} (${p.name}, ${p.maxTokens || 2000}t)...`);
    try {
      const result = await analyze({
        imagePath,
        systemPrompt: p.systemPrompt,
        userPrompt: p.userPrompt,
        maxTokens: p.maxTokens,
        model,
      });
      const entry = { pass: passNum, name: p.name, ...result };
      fs.writeFileSync(cacheFile, JSON.stringify(entry, null, 2));
      results.push(entry);
      console.log(`    ${result.error ? '✗ ' + result.error : '✓ OK'} | tokens:${result.usage?.total_tokens || '?'}`);
    } catch (e) {
      console.log(`    ✗ ${e.message}`);
      const entry = { pass: passNum, name: p.name, error: e.message, parsed: null, usage: null };
      fs.writeFileSync(cacheFile, JSON.stringify(entry, null, 2));
      results.push(entry);
    }

    if (i < passes.length - 1) await sleep(delayMs);
  }

  return results;
}
