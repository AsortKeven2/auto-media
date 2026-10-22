/**
 * 并发工具：限制同时进行的任务数、串行队列（发布、上传等不能并发的步骤），
 * 以及按任务给日志加前缀，便于并发时分辨每行日志属于哪篇文章
 */

const { AsyncLocalStorage } = require('async_hooks');

const logContext = new AsyncLocalStorage();
let consolePatched = false;

function patchConsoleForPrefix() {
  if (consolePatched) return;
  consolePatched = true;
  for (const method of ['log', 'warn', 'error']) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      const prefix = logContext.getStore();
      if (prefix && typeof args[0] === 'string') {
        args[0] = args[0].replace(/^(\n*)/, `$1${prefix} `);
      }
      original(...args);
    };
  }
}

/** 在带日志前缀的上下文里运行 fn，fn 里（包括它等待的异步调用）打出的日志都会带上前缀 */
function runWithLogPrefix(prefix, fn) {
  if (!prefix) return fn();
  patchConsoleForPrefix();
  return logContext.run(prefix, fn);
}

/**
 * 并发限制器：最多同时运行 limit 个任务，其余按提交顺序排队
 * @returns {(task: () => Promise<any>) => Promise<any>}
 */
function createLimiter(limit) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= limit || !waiting.length) return;
    active += 1;
    const { task, resolve, reject } = waiting.shift();
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return task => new Promise((resolve, reject) => {
    waiting.push({ task, resolve, reject });
    next();
  });
}

/**
 * 串行队列：放进来的任务按顺序一个接一个执行；某个任务失败不影响后面的任务
 * @returns {(task: () => Promise<any>) => Promise<any>}
 */
function createSerialQueue() {
  let tail = Promise.resolve();
  return task => {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  };
}

/** 解析并发数：非法值用默认值，上限 10，避免把 AI 接口打到限流 */
function resolveConcurrency(value, fallback = 5) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 10) : fallback;
}

module.exports = { createLimiter, createSerialQueue, runWithLogPrefix, resolveConcurrency };
