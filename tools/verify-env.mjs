#!/usr/bin/env node
/**
 * GY-I25 接入验证：环境与配置体检
 * ------------------------------------------------------------
 * 只做三件事，不调用任何计费接口：
 *   1. 检查 Node 版本是否满足基线（24 LTS）
 *   2. 检查 config.local.json 的配置完整性
 *   3. 探测各服务端点的网络可达性（不带鉴权，期望 401/403 表示可达）
 *
 * 密钥安全：脚本只检查环境变量是否存在，绝不打印其值。
 *
 * 用法：
 *   node tools/verify-env.mjs
 *   node tools/verify-env.mjs --json    # 输出 JSON，便于归档
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, 'docs', 'verification', 'config.local.json');
const AS_JSON = process.argv.includes('--json');

const REQUIRED_NODE_MAJOR = 24;
const PROVIDERS = [
  ['weedRecognition', '识草'],
  ['ocr', '标签 OCR'],
  ['asr', '普通话 ASR'],
  ['tts', '语音合成 TTS'],
  ['llm', '大模型'],
  ['moderation', '文字/图片 AI 筛查']
];

const results = [];
const add = (level, area, item, detail) => results.push({ level, area, item, detail });
const ok = (area, item, detail) => add('PASS', area, item, detail);
const warn = (area, item, detail) => add('WARN', area, item, detail);
const fail = (area, item, detail) => add('FAIL', area, item, detail);

// 1) Node 版本
const major = Number(process.versions.node.split('.')[0]);
if (major >= REQUIRED_NODE_MAJOR) ok('环境', 'Node 版本', process.versions.node);
else fail('环境', 'Node 版本', `${process.versions.node}，基线要求 ${REQUIRED_NODE_MAJOR} LTS`);

// 2) 配置文件
let config = null;
if (!existsSync(CONFIG_PATH)) {
  fail('配置', 'config.local.json', '不存在，请先复制 config.example.json 并填写');
} else {
  try {
    config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    ok('配置', 'config.local.json', '解析成功');
  } catch (err) {
    fail('配置', 'config.local.json', `JSON 解析失败：${err.message}`);
  }
}

if (config) {
  if (config.appid) ok('配置', 'AppID', '已填写');
  else warn('配置', 'AppID', '未填写（测试号不可作为验证证据）');

  if (config.domain?.apiBase) ok('配置', 'API 域名', config.domain.apiBase);
  else warn('配置', 'API 域名', '未填写，需为已在小程序后台配置的 HTTPS 域名');

  if (config.database?.url) ok('配置', '数据库连接', '已填写');
  else warn('配置', '数据库连接', '未填写，比赛前接入');

  if (config.privacy?.allowUserDataForTraining === false) ok('配置', '训练用途策略', '已关闭用户数据训练');
  else fail('配置', '训练用途策略', '必须显式为 false');

  if (config.privacy?.sendRealUserDataBeforeConsent === false) ok('配置', '外发策略', '未取得授权前不外发真实资料');
  else fail('配置', '外发策略', '必须显式为 false');

  for (const [key, label] of PROVIDERS) {
    const p = config.providers?.[key];
    if (!p || (!p.vendor && !p.endpoint)) {
      fail('供应商', label, '未填写供应商或端点');
      continue;
    }
    if (!p.endpoint) {
      fail('供应商', label, '缺少 endpoint');
      continue;
    }
    let parsed = null;
    try {
      parsed = new URL(p.endpoint);
    } catch {
      fail('供应商', label, `endpoint 不是合法 URL：${p.endpoint}`);
      continue;
    }
    if (parsed.protocol !== 'https:') {
      fail('供应商', label, 'endpoint 必须使用 HTTPS');
      continue;
    }
    ok('供应商', label, `已配置 ${p.vendor || '未填供应商'}，密钥环境变量 ${p.apiKeyEnv}`);
    if (p.apiKeyEnv) {
      if (process.env[p.apiKeyEnv]) ok('密钥', label, `环境变量 ${p.apiKeyEnv} 已设置`);
      else fail('密钥', label, `环境变量 ${p.apiKeyEnv} 未设置`);
    } else {
      fail('密钥', label, '未声明 apiKeyEnv');
    }
  }
}

// 3) 网络可达性（不带鉴权，不产生调用费用）
async function probe(label, endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    fail('网络', label, 'endpoint 非法，跳过探测');
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url.origin, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timer);
    if (res.status === 401 || res.status === 403 || res.ok) {
      ok('网络', label, `可达（HTTP ${res.status}）`);
    } else {
      warn('网络', label, `可达但返回 HTTP ${res.status}，需确认端点路径`);
    }
  } catch (err) {
    clearTimeout(timer);
    const reason = err.name === 'AbortError' ? '超时 8 秒' : err.message;
    fail('网络', label, `不可达：${reason}`);
  }
}

if (config?.providers) {
  for (const [key, label] of PROVIDERS) {
    const endpoint = config.providers[key]?.endpoint;
    if (endpoint) await probe(label, endpoint);
  }
}

// 4) 报告
const counts = results.reduce((acc, r) => ({ ...acc, [r.level]: (acc[r.level] || 0) + 1 }), {});

if (AS_JSON) {
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), counts, results }, null, 2));
} else {
  console.log('\nGY-I25 接入验证 · 环境与配置体检\n');
  let currentArea = '';
  for (const r of results) {
    if (r.area !== currentArea) {
      currentArea = r.area;
      console.log(`\n【${currentArea}】`);
    }
    const icon = r.level === 'PASS' ? '✓' : r.level === 'WARN' ? '!' : '×';
    console.log(`  ${icon} ${r.item}：${r.detail}`);
  }
  console.log(`\n合计：PASS ${counts.PASS || 0} ／ WARN ${counts.WARN || 0} ／ FAIL ${counts.FAIL || 0}\n`);
  console.log('说明：本脚本未调用任何计费接口；网络探测只做不带鉴权的可达性判断。');
  if ((counts.FAIL || 0) > 0) {
    console.log('存在 FAIL 项，请先补齐后在 provider-matrix.md 中更新状态。\n');
  }
}

process.exit((counts.FAIL || 0) > 0 ? 1 : 0);
