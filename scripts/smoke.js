#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const SKILL_DIR = path.join(ROOT, 'skills', 'skill-vision');

function fail(msg) { console.error('SMOKE FAIL: ' + msg); process.exit(1); }

const required = [
  'SKILL.md',
  'scripts/vision-client.mjs',
  'scripts/prompts/room-measurement.mjs'
];
for (const rel of required) {
  if (!fs.existsSync(path.join(SKILL_DIR, rel))) fail('missing ' + rel);
}

(async () => {
  const mod = await import(pathToFileURL(path.join(SKILL_DIR, 'scripts', 'vision-client.mjs')).href);
  for (const fn of ['resolveApiToken', 'callVisionAPI', 'callMultiPass', 'extractJSON', 'detectHostVisionModel', 'resolveVisionModel', 'analyze']) {
    if (typeof mod[fn] !== 'function') fail('export ' + fn + ' is not a function');
  }
  const { parsed } = mod.extractJSON('text {"a":1} tail');
  if (!parsed || parsed.a !== 1) fail('extractJSON did not parse JSON');

  // 默认模型：glm-5.3-flash（无宿主配置时回落）
  const cleanEnv = { ...process.env };
  delete cleanEnv.FMODE_VISION_MODEL;
  const savedEnv = process.env;
  for (const k of Object.keys(cleanEnv)) if (k === 'FMODE_VISION_MODEL') delete process.env[k];
  const fallback = mod.resolveVisionModel();
  if (fallback.provider !== 'fmode' || fallback.model !== 'glm-5.3-flash') {
    fail('fallback model should be fmode/glm-5.3-flash, got ' + JSON.stringify(fallback));
  }

  // 宿主探测：FMODE_VISION_MODEL 命中 → host
  process.env.FMODE_VISION_MODEL = 'claude-sonnet-4-5';
  const host = mod.resolveVisionModel();
  if (host.provider !== 'host' || host.model !== 'claude-sonnet-4-5') {
    fail('FMODE_VISION_MODEL should resolve to host, got ' + JSON.stringify(host));
  }
  delete process.env.FMODE_VISION_MODEL;

  // analyze() 宿主会话内 → 返回 instruction，不调 API
  if (process.env.CLAUDECODE || process.env.CODEX_SANDBOX || process.env.CODEX_HOME) {
    process.env.FMODE_VISION_MODEL = 'claude-opus-4-1';
    const r = await mod.analyze({ imagePath: '/nonexistent.jpg', systemPrompt: 's', userPrompt: 'u' });
    if (r.provider !== 'host' || !r.instruction) fail('analyze() host path did not return instruction');
    delete process.env.FMODE_VISION_MODEL;
  }

  // Token 加载链：隔离 HOME 下无任何 token → 应抛错并列出四级来源
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-vision-smoke-'));
  const oldHome = process.env.HOME;
  process.env.HOME = tmpHome;
  const savedToken = process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  const savedBase = process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_BASE_URL;
  const savedFmodeToken = process.env.FMODE_API_TOKEN;
  delete process.env.FMODE_API_TOKEN;
  try {
    await mod.resolveApiToken(tmpHome);
    fail('resolveApiToken should throw when no token source exists');
  } catch (e) {
    if (!/FMODE_API_TOKEN/.test(e.message)) fail('error message should mention FMODE_API_TOKEN');
  } finally {
    process.env.HOME = oldHome;
    if (savedToken) process.env.ANTHROPIC_AUTH_TOKEN = savedToken;
    if (savedBase) process.env.ANTHROPIC_BASE_URL = savedBase;
    if (savedFmodeToken) process.env.FMODE_API_TOKEN = savedFmodeToken;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }

  console.log('SMOKE OK: skill-vision package structure + module exports + model selection + token chain verified');
})().catch(e => fail(e.message));
