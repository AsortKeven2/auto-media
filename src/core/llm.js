/**
 * 统一 LLM 调用：按当前平台在 config.json 里的 llm 配置选模型，"claude" 走本机已登录的 Claude Code，
 * "workbuddy" 走 NAS 上的 WorkBuddy2API 网关（OpenAI 兼容），其他（默认）走豆包。
 * 入口脚本启动时用 useLlmFor(平台) 声明自己跑的是哪个平台。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');
const axios = require('axios');
const config = require('./config');

const CLAUDE_DEFAULT_MODEL = 'claude-opus-5-5';
const CLAUDE_TIMEOUT_MS = 10 * 60 * 1000;
const CONTENT_SYSTEM_PROMPT = '你是严谨的中文内容助手。严格按照用户要求的内容和格式直接输出结果，不要寒暄，不要解释你的做法。';
// 开思考时思考也算进 max_tokens，额外留出这些给思考，免得正文被截断（按实际用量计费，上限放宽不多花）
const THINKING_TOKEN_BUDGET = 8000;

let currentPlatform = null;
let announcedProvider = false;
let claudeEnv = null;
const thinkingContext = new AsyncLocalStorage();

/** 声明当前进程跑的是哪个平台（wechat / baijiahao），模型按该平台的 llm 配置选 */
function useLlmFor(platform) {
  currentPlatform = platform;
}

/** 在 fn 里（包括它等待的异步调用）走 WorkBuddy 网关的请求都按 effort 档位开思考，如 'low'；豆包和 Claude 不受影响 */
function withThinking(effort, fn) {
  return thinkingContext.run(effort, fn);
}

async function callLLM(prompt, options = {}) {
  const provider = config.llmProvider(currentPlatform);
  if (provider === 'claude') return callClaudeCli(prompt, options, config.claudeSettings());
  if (provider === 'workbuddy') return callOpenAICompatible(prompt, options, config.workbuddySettings());
  return callDoubao(prompt, options);
}

/**
 * OpenAI 兼容接口：NAS 上的 WorkBuddy2API 网关把自己的 WorkBuddy 账号包装成 /v1/chat/completions。
 * 网关在局域网里，不走系统代理；限流、超时、5xx 重试
 */
async function callOpenAICompatible(prompt, options, settings) {
  const { maxTokens = 4000, retries = 3 } = options;
  // 思考：调用时显式传的优先（档位字符串，或 true 用网关默认档），否则看 withThinking 的上下文；都没有就不思考
  let thinking = options.thinking ?? thinkingContext.getStore() ?? false;
  if (!settings.base_url || !settings.model) {
    console.error('config.json 未配置 workbuddy.base_url 或 workbuddy.model');
    return null;
  }
  if (!announcedProvider) {
    announcedProvider = true;
    console.log(`  模型：WorkBuddy 网关（${settings.model}）`);
  }
  const url = `${String(settings.base_url).replace(/\/+$/, '')}/chat/completions`;
  const buildBody = () => {
    const body = {
      model: settings.model,
      messages: [{ role: 'system', content: CONTENT_SYSTEM_PROMPT }, { role: 'user', content: prompt }],
      max_tokens: thinking ? maxTokens + THINKING_TOKEN_BUDGET : maxTokens,
      stream: false,
      // 网关对 deepseek 系模型默认开高档思考，不显式关掉 max_tokens 会被思考耗光、正文为空；默认不思考，写文章时开低档
      thinking: { type: thinking ? 'enabled' : 'disabled' },
    };
    if (typeof thinking === 'string') body.reasoning_effort = thinking;
    return body;
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { data } = await axios.post(url, buildBody(), {
        headers: { 'Authorization': `Bearer ${settings.api_key || ''}`, 'Content-Type': 'application/json' },
        timeout: (Number(settings.timeout_seconds) || 300) * 1000,
        proxy: false,
      });
      const choice = data.choices?.[0];
      const content = choice?.message?.content || '';
      // 思考把 max_tokens 用完了（正文为空或被截断）：原样重发结果一样，改成不思考重发，不算一次失败
      if (thinking && choice?.finish_reason === 'length') {
        console.warn(`  ⚠ 思考用完了 ${data.usage?.completion_tokens ?? '全部'} 个 token 还没写完，改成不思考重发`);
        thinking = false;
        attempt -= 1;
        continue;
      }
      if (content.trim()) return content.trim();
      throw new Error(`没有返回内容（finish_reason=${choice?.finish_reason ?? '无'}，输出 ${data.usage?.completion_tokens ?? '?'} token）`);
    } catch (e) {
      const status = e.response?.status;
      const retryable = !status || status === 429 || status >= 500;
      const reason = e.response?.data?.error?.message || e.message;
      if (retryable && attempt < retries) {
        const delay = attempt * 15;
        console.warn(`  ⚠ WorkBuddy 网关调用失败，${delay}s 后重试 (${attempt}/${retries})：${status ? `HTTP ${status} ` : ''}${String(reason).slice(0, 120)}`);
        await new Promise(r => setTimeout(r, delay * 1000));
        continue;
      }
      console.error(`  WorkBuddy 网关调用失败: ${status ? `HTTP ${status} ` : ''}${String(reason).slice(0, 200)}`);
      return null;
    }
  }
  return null;
}

async function callDoubao(prompt, options) {
  const { maxTokens = 4000, retries = 3, thinking = false } = options;
  const apiKey = config.doubaoKey();
  if (!apiKey) {
    console.error('config.json 未配置 doubao_api_key');
    return null;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { data } = await axios.post(
        'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
        {
          model: config.doubaoModel(),
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          thinking: { type: thinking ? 'enabled' : 'disabled' },
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 180000,
        }
      );
      const content = data.choices?.[0]?.message?.content || '';
      if (content.trim()) return content.trim();
      return null;
    } catch (e) {
      const status = e.response?.status;
      const isTimeout = e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT';
      if ((status === 429 || isTimeout) && attempt < retries) {
        const delay = isTimeout ? attempt * 15 : attempt * 10;
        const reason = isTimeout ? '超时' : '限流(429)';
        console.warn(`  ⚠ API ${reason}，${delay}s 后重试 (${attempt}/${retries})`);
        await new Promise(r => setTimeout(r, delay * 1000));
        continue;
      }
      console.error(`  豆包调用失败: ${e.message}`);
      return null;
    }
  }
  return null;
}

/**
 * 通过 Claude Code 命令行的无头模式调用：用本机的登录态，不需要 API key；
 * 关掉所有工具、不存会话、不加载 MCP 和项目设置，在临时目录里运行，只当纯文本生成用
 */
async function callClaudeCli(prompt, options, settings) {
  const { retries = 3 } = options;
  const bin = resolveClaudeBinary(settings.bin);
  const model = settings.model || CLAUDE_DEFAULT_MODEL;
  const args = [
    '-p', '--output-format', 'json',
    '--model', model,
    '--system-prompt', CONTENT_SYSTEM_PROMPT,
    '--tools', '',
    '--no-session-persistence', '--strict-mcp-config', '--disable-slash-commands',
    '--setting-sources', '',
  ];
  if (settings.effort) args.push('--effort', settings.effort);

  if (!announcedProvider) {
    announcedProvider = true;
    console.log(`  模型：本机 Claude Code（${model}${settings.effort ? `，effort ${settings.effort}` : ''}）`);
  }

  const env = buildClaudeEnv(settings);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = JSON.parse(await runClaude(bin, args, prompt, env));
      const text = typeof result.result === 'string' ? result.result.trim() : '';
      if (!result.is_error && text) return text;
      throw new Error(text || result.subtype || '没有返回内容');
    } catch (e) {
      if (attempt < retries) {
        const delay = attempt * 10;
        console.warn(`  ⚠ Claude 调用失败，${delay}s 后重试 (${attempt}/${retries})：${e.message.slice(0, 120)}`);
        await new Promise(r => setTimeout(r, delay * 1000));
        continue;
      }
      console.error(`  Claude 调用失败: ${e.message.slice(0, 200)}`);
      return null;
    }
  }
  return null;
}

/**
 * Claude Code 子进程的环境变量：每次运行时自动找本机代理，只给 Claude 用，豆包和平台接口不受影响。
 * 优先 config.json 的 claude.proxy，其次 macOS 当前生效的系统代理（哪个代理软件开着就是哪个的端口），最后是环境变量
 */
function buildClaudeEnv(settings) {
  if (claudeEnv) return claudeEnv;
  claudeEnv = { ...process.env };
  const found = resolveClaudeProxy(settings.proxy);
  if (found) {
    // 大小写和 all_proxy 都设上：Claude Code 不同环节（接口请求、登录刷新）认的变量不一样
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) {
      claudeEnv[name] = found.proxy;
    }
    if (!claudeEnv.NO_PROXY) claudeEnv.NO_PROXY = 'localhost,127.0.0.1,::1';
    if (!claudeEnv.no_proxy) claudeEnv.no_proxy = claudeEnv.NO_PROXY;
    console.log(`  Claude 代理：${found.proxy}（${found.source}）`);
  } else {
    console.warn('  ⚠ 没找到本机代理，Claude 直连；如果报 403，请打开代理软件的“系统代理”');
  }
  return claudeEnv;
}

function resolveClaudeProxy(configured) {
  if (configured) return { proxy: configured, source: 'config.json 的 claude.proxy' };
  const system = readSystemProxy();
  if (system) return { proxy: system, source: '系统代理' };
  const fromEnv = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  return fromEnv ? { proxy: fromEnv, source: '环境变量' } : null;
}

/** 读 macOS 当前生效的系统代理（scutil --proxy），先 HTTPS 后 HTTP */
function readSystemProxy() {
  if (process.platform !== 'darwin') return null;
  try {
    const output = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 5000 });
    const read = key => (output.match(new RegExp(`\\b${key}\\s*:\\s*(\\S+)`)) || [])[1];
    for (const kind of ['HTTPS', 'HTTP']) {
      const host = read(`${kind}Proxy`);
      const port = read(`${kind}Port`);
      if (read(`${kind}Enable`) === '1' && host && port) return `http://${host}:${port}`;
    }
  } catch {
    // 读不到系统代理就当没有
  }
  return null;
}

function runClaude(bin, args, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: os.tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`超过 ${CLAUDE_TIMEOUT_MS / 60000} 分钟没有返回`));
    }, CLAUDE_TIMEOUT_MS);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (stdout.trim()) resolve(stdout);
      else reject(new Error(stderr.trim() || `Claude Code 退出码 ${code}`));
    });
    child.stdin.end(input);
  });
}

/** 配置了路径就用配置的；否则用桌面端自带的最新版 Claude Code，再不行用 ~/.local/bin/claude */
function resolveClaudeBinary(configured) {
  if (configured) return configured;
  const bundledRoot = path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code');
  try {
    const versions = fs.readdirSync(bundledRoot)
      .filter(name => /^\d+\.\d+\.\d+$/.test(name))
      .sort((a, b) => compareVersions(b, a));
    for (const version of versions) {
      for (const build of fs.readdirSync(path.join(bundledRoot, version))) {
        const bin = path.join(bundledRoot, version, build, 'claude.app', 'Contents', 'MacOS', 'claude');
        if (fs.existsSync(bin)) return bin;
      }
    }
  } catch {
    // 没装桌面端
  }
  const localBin = path.join(os.homedir(), '.local', 'bin', 'claude');
  return fs.existsSync(localBin) ? localBin : 'claude';
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

module.exports = { callLLM, useLlmFor, withThinking };
