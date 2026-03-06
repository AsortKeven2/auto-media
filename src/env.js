/**
 * 统一配置加载 - 从 .env.local 读取所有配置
 */

const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env.local');

let _cache = null;

function loadEnv() {
  if (_cache) return _cache;

  if (!fs.existsSync(ENV_PATH)) {
    console.error('.env.local 不存在，请创建并填写配置');
    process.exit(1);
  }

  const env = {};
  const lines = fs.readFileSync(ENV_PATH, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    env[key] = val;
  }

  _cache = env;
  return env;
}

// 快捷访问
function get(key, fallback) {
  const env = loadEnv();
  return env[key] || fallback || '';
}

function cookie()         { return get('BJH_COOKIE'); }
function toutiaoCookie()  { return get('TOUTIAO_COOKIE'); }
function wechatCookie()   { return get('WECHAT_COOKIE'); }
function doubaoKey()      { return get('DOUBAO_API_KEY'); }
function doubaoModel()    { return get('DOUBAO_MODEL', 'doubao-seed-1-8-251228'); }
const PROJECT_ROOT = path.join(__dirname, '..');

function imageDir()     { return get('IMAGE_DIR', path.join(PROJECT_ROOT, 'images')); }
function tailImage()    { return get('TAIL_IMAGE', path.join(PROJECT_ROOT, 'images', 'cover.jpg')); }

/** Chrome 浏览器路径：优先 .env.local 配置，否则按平台使用默认路径 */
function chromePath() {
  const configured = get('CHROME_PATH');
  if (configured) return configured;

  const platform = process.platform;
  const defaults = {
    darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    linux: '/usr/bin/google-chrome',
  };
  return defaults[platform] || '';
}

// 更新 Cookie（写回 .env.local）
function updateCookie(newCookie) {
  const raw = fs.readFileSync(ENV_PATH, 'utf-8');
  const lines = raw.split('\n');
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('BJH_COOKIE=')) {
      lines[i] = `BJH_COOKIE=${newCookie.trim()}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    lines.push(`BJH_COOKIE=${newCookie.trim()}`);
  }
  fs.writeFileSync(ENV_PATH, lines.join('\n'), 'utf-8');
  _cache = null; // 清缓存
  console.log('Cookie 已更新到 .env.local');
}

module.exports = { loadEnv, get, cookie, toutiaoCookie, wechatCookie, doubaoKey, doubaoModel, imageDir, tailImage, chromePath, updateCookie };
