/**
 * 公众号 Cookie 自动提取
 * 用 puppeteer-core 启动本地 Chrome，打开 mp.weixin.qq.com 扫码登录，
 * 登录成功后自动抓取 Cookie 并写入 config.json 对应账号。
 */

const fs = require('fs');
const readline = require('readline');
const puppeteer = require('puppeteer-core');

const { loadConfig, saveConfig } = require('../core/config');
const { WechatAPI } = require('../core/wechat-api');

const LOGIN_URL = 'https://mp.weixin.qq.com/';
const LOGIN_TIMEOUT_MS = 3 * 60 * 1000; // 等待扫码登录的最长时间

/** 常见的本地 Chrome / Edge 可执行文件路径（按平台） */
const CHROME_CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ],
};

/** 找到一个可用的浏览器可执行文件 */
function resolveChromePath(config) {
  const explicit =
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    process.env.CHROME_PATH ||
    (config.wechat && config.wechat.chrome_path) ||
    config.chrome_path;
  if (explicit) {
    if (fs.existsSync(explicit)) return explicit;
    throw new Error(`配置的 Chrome 路径不存在: ${explicit}`);
  }

  const candidates = CHROME_CANDIDATES[process.platform] || [];
  const found = candidates.find(p => fs.existsSync(p));
  if (found) return found;

  throw new Error(
    '未找到本地 Chrome 浏览器。请安装 Google Chrome，或在 config.json 中设置 "chrome_path"（或设置环境变量 CHROME_PATH）。'
  );
}

/** 简单的命令行提问 */
function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans.trim()); }));
}

/**
 * 决定 Cookie 要写入哪个账号
 * 逻辑与 `login` 命令保持一致：
 * - 指定 account：按名匹配
 * - 仅 1 个账号：直接用
 * - 多个账号且未指定：交互式选择
 * - 没有 accounts：写入扁平的 wechat.cookie
 * @returns {{ apply: (cookie: string) => void, label: string }}
 */
async function resolveTarget(cfg, accountName) {
  if (!cfg.wechat) cfg.wechat = {};
  const accounts = cfg.wechat.accounts || [];

  if (accountName) {
    const matched = accounts.find(a => a.name === accountName);
    if (!matched) {
      throw new Error(`未找到账号 "${accountName}"，可用账号: ${accounts.map(a => a.name).join('、')}`);
    }
    return { apply: cookie => { matched.cookie = cookie; }, label: matched.name };
  }

  if (accounts.length === 1) {
    return { apply: cookie => { accounts[0].cookie = cookie; }, label: accounts[0].name };
  }

  if (accounts.length > 1) {
    console.log('\n检测到多个公众号账号：');
    accounts.forEach((a, i) => console.log(`  ${i + 1}. ${a.name}`));
    const ans = await prompt(`请选择要登录的账号 (1-${accounts.length}): `);
    const idx = parseInt(ans, 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= accounts.length) {
      throw new Error('无效的选择');
    }
    const chosen = accounts[idx];
    return { apply: cookie => { chosen.cookie = cookie; }, label: chosen.name };
  }

  // 没有配置 accounts：兼容扁平结构
  return { apply: cookie => { cfg.wechat.cookie = cookie; }, label: 'default' };
}

/** 等待扫码登录完成：轮询页面 URL，出现 token= 即视为登录成功 */
async function waitForLogin(page) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const url = page.url();
    if (/[?&]token=\d+/.test(url)) return url;
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('等待扫码登录超时（3 分钟），请重试');
}

/** 从浏览器抓取 mp.weixin.qq.com 的 Cookie 并拼成请求头字符串 */
async function extractCookieString(page, browser) {
  let cookies;
  try {
    cookies = await page.cookies(LOGIN_URL);
  } catch {
    cookies = await browser.cookies();
  }
  return cookies.map(c => `${c.name}=${c.value}`).join('; ');
}

/**
 * CLI 入口：打开浏览器扫码登录并提取 Cookie
 * @param {{ account?: string }} [opts]
 */
async function cliExtract(opts = {}) {
  const cfg = loadConfig();
  const target = await resolveTarget(cfg, opts.account);
  const chromePath = resolveChromePath(cfg);

  console.log(`\n将为账号「${target.label}」提取 Cookie`);
  console.log(`使用浏览器: ${chromePath}`);
  console.log('正在启动浏览器，请在打开的窗口中扫码登录...\n');

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: chromePath,
    defaultViewport: null,
    args: ['--no-first-run', '--no-default-browser-check', '--start-maximized'],
  });

  try {
    const page = (await browser.pages())[0] || (await browser.newPage());
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    await waitForLogin(page);
    console.log('✓ 检测到登录成功，正在提取 Cookie...');

    const cookieStr = await extractCookieString(page, browser);
    if (!cookieStr) throw new Error('未能从浏览器读取到 Cookie');

    target.apply(cookieStr.trim());
    saveConfig(cfg);
    console.log(`✓ Cookie 已写入 config.json（账号: ${target.label}）`);

    // 立即验证一次
    console.log('\n验证登录状态...');
    await new WechatAPI(cookieStr).checkAuth();
  } finally {
    await browser.close();
  }
}

module.exports = { cliExtract, resolveChromePath };
