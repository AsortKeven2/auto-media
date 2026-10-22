/**
 * 统一配置加载 - 从 config.json 读取所有配置
 */

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '../..', 'config.json');
const PROJECT_ROOT = path.join(__dirname, '../..');

let _cache = null;

function loadConfig() {
  if (_cache) return _cache;

  if (!fs.existsSync(CONFIG_PATH)) {
    console.error('config.json 不存在，请创建并填写配置（参考 config.json.example）');
    process.exit(1);
  }

  try {
    _cache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return _cache;
  } catch (e) {
    console.error(`config.json 解析失败: ${e.message}`);
    process.exit(1);
  }
}

function get(key, fallback) {
  const config = loadConfig();
  return config[key] !== undefined && config[key] !== '' ? config[key] : (fallback || '');
}

/** 平台用哪个模型：config.json 里该平台下的 llm，"claude"、"workbuddy" 或 "doubao"（不写默认豆包） */
function llmProvider(platform) {
  const section = platform ? loadConfig()[platform] : null;
  return (section && section.llm) || 'doubao';
}

/** Claude 的设置：config.json 顶层的 claude（model、effort、bin） */
function claudeSettings() {
  return loadConfig().claude || {};
}

/** WorkBuddy 网关的设置：config.json 顶层的 workbuddy（base_url 到 /v1 为止、api_key、model） */
function workbuddySettings() {
  return loadConfig().workbuddy || {};
}

function doubaoKey()   { return get('doubao_api_key'); }
function doubaoModel() { return get('doubao_model', 'doubao-seed-1-8-251228'); }
function imageDir()    { const v = get('image_dir'); return v ? path.resolve(PROJECT_ROOT, v) : path.join(PROJECT_ROOT, 'images'); }
function tailImage()   { const v = get('tail_image'); return v ? path.resolve(PROJECT_ROOT, v) : path.join(PROJECT_ROOT, 'images', 'cover.jpg'); }

/** 获取头条号 cookie（头条不支持多账号，直接从 toutiao.cookie 读） */
function toutiaoCookie() {
  const config = loadConfig();
  return (config.toutiao && config.toutiao.cookie) || '';
}

/** 写入配置到 config.json */
function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  _cache = null;
}

module.exports = {
  loadConfig,
  llmProvider,
  claudeSettings,
  workbuddySettings,
  doubaoKey,
  doubaoModel,
  imageDir,
  tailImage,
  toutiaoCookie,
  saveConfig,
};
