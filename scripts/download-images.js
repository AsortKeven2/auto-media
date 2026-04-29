#!/usr/bin/env node
/**
 * 批量从百度图片搜索下载角色图片
 *
 * 用法:
 *   node scripts/download-images.js 水浒传                   # 扫描已有图片，补齐不足3张的角色
 *   node scripts/download-images.js 水浒传 武大郎 宋江       # 只下载指定角色（自动补齐到3张）
 *   node scripts/download-images.js 水浒传 武大郎 宋江 -n 5  # 每角色下载5张
 *   node scripts/download-images.js 倚天屠龙记 --roles 100 -n 4
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { chrome_path, image_dir } = require('../config.json');

const PROJECT_ROOT = path.join(__dirname, '..');
const CHROME_PATH = chrome_path;
const IMAGE_ROOT = path.resolve(PROJECT_ROOT, image_dir || './images');
const DOWNLOAD_ROOT = path.join(PROJECT_ROOT, 'downloads');
const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

if (!CHROME_PATH || !fs.existsSync(CHROME_PATH)) {
  console.error(`Chrome 浏览器未找到: ${CHROME_PATH || '(未配置)'}`);
  console.error('请在 config.json 中配置 chrome_path，例如:');
  console.error('  macOS:   /Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  console.error('  Windows: C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  console.error('  Linux:   /usr/bin/google-chrome');
  process.exit(1);
}

function parseArgs(argv) {
  if (!argv.length) {
    console.log('用法: node scripts/download-images.js <作品名> [角色1 角色2 ...] [-n 数量] [--roles 角色数]');
    console.log('  无角色名: 扫描 images/<作品名>，补齐不足3张的已有角色');
    console.log('  有角色名: 只下载指定角色');
    console.log('  -n 数量:  每角色目标张数 (默认3)');
    console.log('  --roles:  限制本次扫描/处理的角色数量，例如 --roles 100');
    process.exit(0);
  }

  const work = argv[0];
  const names = [];
  let targetCount = 3;
  let characterLimit = null;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '-n' || arg === '--count') && argv[i + 1]) {
      targetCount = parseInt(argv[++i], 10);
    } else if ((arg === '--roles' || arg === '--limit') && argv[i + 1]) {
      characterLimit = parseInt(argv[++i], 10);
    } else {
      names.push(arg);
    }
  }

  if (!Number.isFinite(targetCount) || targetCount <= 0) targetCount = 3;
  if (!Number.isFinite(characterLimit) || characterLimit <= 0) characterLimit = null;

  return { work, specifiedNames: names, targetCount, characterLimit };
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isImageFile(fileName) {
  return IMAGE_EXTS.includes(path.extname(fileName).toLowerCase());
}

function uniqueNames(names) {
  const seen = new Set();
  const result = [];
  for (const name of names) {
    const clean = String(name || '').trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    result.push(clean);
  }
  return result;
}

function countImages(name, dir) {
  if (!fs.existsSync(dir)) return 0;
  const namePattern = new RegExp(`^${escapeRegExp(name)}\\d+$`);
  return fs.readdirSync(dir).filter(file => {
    if (!isImageFile(file)) return false;
    const base = path.basename(file, path.extname(file));
    return base === name || namePattern.test(base);
  }).length;
}

function scanExistingCharacters(dir) {
  if (!fs.existsSync(dir)) return [];
  const names = new Set();
  for (const file of fs.readdirSync(dir)) {
    if (!isImageFile(file)) continue;
    const base = path.basename(file, path.extname(file));
    if (base === '封面') continue;
    names.add(base.replace(/\d+$/, '') || base);
  }
  return [...names].sort();
}

function buildSearchUrl(work, name) {
  const query = `${work} ${name} 影视 剧照`;
  return `https://image.baidu.com/search/index?tn=baiduimage&word=${encodeURIComponent(query)}&pn=0&rn=60`;
}

function isUsableUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (/\/img\/flexible\/logo\//i.test(url)) return false;
  if (/base64|aigc|sprite|blank/i.test(url)) return false;
  return true;
}

function addCandidate(results, seen, urls, source) {
  const cleanUrls = uniqueNames(urls).filter(isUsableUrl);
  if (!cleanUrls.length) return;

  const key = cleanUrls.join('|');
  if (seen.has(key)) return;
  seen.add(key);
  results.push({ urls: cleanUrls, source });
}

async function fetchBaiduApiImages(work, name) {
  const query = `${work} ${name} 影视 剧照`;
  const params = new URLSearchParams({
    tn: 'resultjson_com',
    ipn: 'rj',
    ct: '201326592',
    fp: 'result',
    queryWord: query,
    cl: '2',
    lm: '-1',
    ie: 'utf-8',
    oe: 'utf-8',
    st: '-1',
    ic: '0',
    face: '0',
    istype: '2',
    nc: '1',
    word: query,
    pn: '0',
    rn: '60',
  });
  const url = `https://image.baidu.com/search/acjson?${params.toString()}`;

  const resp = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Referer': buildSearchUrl(work, name),
      'Accept': 'application/json,text/plain,*/*',
    },
  });
  if (!resp.ok) throw new Error(`百度图片接口返回 ${resp.status}`);

  const text = await resp.text();
  const data = JSON.parse(text);
  const results = [];
  const seen = new Set();

  for (const item of data.data || []) {
    if (!item || typeof item !== 'object') continue;
    const urls = [
      item.thumbURL,
      item.middleURL,
      item.hoverURL,
      item.largeTnImageUrl,
    ];
    if (Array.isArray(item.replaceUrl)) {
      for (const replace of item.replaceUrl) {
        urls.push(replace.ObjURL, replace.ObjUrl, replace.objURL, replace.objUrl);
      }
    }
    addCandidate(results, seen, urls, 'api');
  }

  return results;
}

async function launchBrowser() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
    ],
  });
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setViewport({ width: 1920, height: 1080 });
  return { browser, page };
}

async function fetchDomImages(page, work, name) {
  await page.goto(buildSearchUrl(work, name), { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelectorAll('img[data-thumbnail-url], img[data-objurl], img[src*="baidu.com/it/"]').length > 0,
    { timeout: 12000 }
  ).catch(() => {});

  for (let i = 0; i < 4; i++) {
    await page.evaluate(() => window.scrollBy(0, 900));
    await new Promise(resolve => setTimeout(resolve, 800));
  }

  return page.evaluate(() => {
    const results = [];
    const seen = new Set();

    function isUsable(url) {
      return url && /^https?:\/\//i.test(url) && !/\/img\/flexible\/logo\/|base64|aigc|sprite|blank/i.test(url);
    }

    function add(urls) {
      const clean = urls.filter(isUsable);
      if (!clean.length) return;
      const key = clean.join('|');
      if (seen.has(key)) return;
      seen.add(key);
      results.push({ urls: clean, source: 'dom' });
    }

    for (const img of document.images) {
      add([
        img.getAttribute('data-thumbnail-url'),
        img.currentSrc,
        img.src,
        img.getAttribute('data-objurl'),
      ]);
    }

    return results;
  });
}

function extFromContentType(contentType) {
  const type = String(contentType || '').toLowerCase();
  if (type.includes('png')) return '.png';
  if (type.includes('gif')) return '.gif';
  if (type.includes('webp')) return '.webp';
  return '.jpg';
}

function extFromMagic(buffer, fallback) {
  if (buffer.length >= 12) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return '.jpg';
    if (buffer.slice(0, 8).toString('hex') === '89504e470d0a1a0a') return '.png';
    if (buffer.slice(0, 6).toString() === 'GIF87a' || buffer.slice(0, 6).toString() === 'GIF89a') return '.gif';
    if (buffer.slice(0, 4).toString() === 'RIFF' && buffer.slice(8, 12).toString() === 'WEBP') return '.webp';
  }
  return fallback || '.jpg';
}

async function fetchImageBuffer(url, referer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': referer,
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
    });
    if (!resp.ok) return null;
    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('image')) return null;
    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length < 15000) return null;
    const ext = extFromMagic(buffer, extFromContentType(contentType));
    return { buffer, ext, size: buffer.length };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function buildFilePath(dir, name, idx, ext) {
  const base = idx === 0 ? name : `${name}${idx + 1}`;
  let filePath = path.join(dir, `${base}${ext}`);
  if (!fs.existsSync(filePath)) return filePath;

  for (const candidateExt of IMAGE_EXTS) {
    const candidate = path.join(dir, `${base}${candidateExt}`);
    if (fs.existsSync(candidate)) {
      filePath = candidate;
      break;
    }
  }
  return filePath;
}

async function main() {
  const { work, specifiedNames, targetCount, characterLimit } = parseArgs(process.argv.slice(2));
  const existingDir = path.join(IMAGE_ROOT, work);
  const downloadDir = path.join(DOWNLOAD_ROOT, work);

  let characterNames;
  if (specifiedNames.length) {
    characterNames = uniqueNames(specifiedNames);
    console.log(`指定下载 ${characterNames.length} 个角色: ${characterNames.join(', ')}`);
  } else {
    characterNames = scanExistingCharacters(existingDir);
    console.log(`扫描到 ${characterNames.length} 个已有角色，检查图片完整性...`);
  }

  if (characterLimit) characterNames = characterNames.slice(0, characterLimit);

  if (!characterNames.length) {
    console.error(`没有可处理的角色。请传入角色名，或先确认目录存在: ${existingDir}`);
    process.exit(1);
  }

  fs.mkdirSync(downloadDir, { recursive: true });

  const tasks = [];
  for (const name of characterNames) {
    const existing = countImages(name, existingDir);
    const downloaded = countImages(name, downloadDir);
    const total = existing + downloaded;
    if (total >= targetCount) continue;

    tasks.push({ name, need: targetCount - total, startIdx: total });
  }

  if (!tasks.length) {
    console.log(`所有角色图片已满 ${targetCount} 张，无需下载`);
    return;
  }

  console.log(`需要为 ${tasks.length} 个角色下载图片，共约 ${tasks.reduce((sum, task) => sum + task.need, 0)} 张`);
  console.log('');

  let browser = null;
  let page = null;
  let totalDownloaded = 0;
  let totalFailed = 0;

  try {
    for (let ti = 0; ti < tasks.length; ti++) {
      const { name, need, startIdx } = tasks[ti];
      console.log(`[${ti + 1}/${tasks.length}] ${name} - 需要 ${need} 张`);

      let candidates = [];
      try {
        candidates = await fetchBaiduApiImages(work, name);
        if (!candidates.length) {
          if (!browser) {
            console.log('  API 无结果，启动浏览器兜底...');
            const launched = await launchBrowser();
            browser = launched.browser;
            page = launched.page;
          }
          candidates = await fetchDomImages(page, work, name);
        }
      } catch (e) {
        console.log(`  图片搜索失败: ${e.message}`);
        if (!browser) {
          const launched = await launchBrowser();
          browser = launched.browser;
          page = launched.page;
        }
        try {
          candidates = await fetchDomImages(page, work, name);
        } catch (domErr) {
          console.log(`  DOM 兜底失败: ${domErr.message}`);
        }
      }

      if (!candidates.length) {
        console.log('  未找到图片，跳过');
        totalFailed += need;
        continue;
      }

      console.log(`  找到 ${candidates.length} 组候选图片`);

      let downloaded = 0;
      const referer = buildSearchUrl(work, name);
      for (const candidate of candidates) {
        if (downloaded >= need) break;
        let imageData = null;
        for (const url of candidate.urls) {
          imageData = await fetchImageBuffer(url, referer);
          if (imageData) break;
        }
        if (!imageData) continue;

        const idx = startIdx + downloaded;
        const filePath = buildFilePath(downloadDir, name, idx, imageData.ext);
        fs.writeFileSync(filePath, imageData.buffer);

        console.log(`  OK ${path.basename(filePath)} (${Math.round(imageData.size / 1024)}KB) [${candidate.source}]`);
        downloaded++;
        totalDownloaded++;
      }

      if (downloaded < need) {
        console.log(`  只下载了 ${downloaded}/${need} 张`);
        totalFailed += (need - downloaded);
      }

      if (ti < tasks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 600));
      }
    }
  } finally {
    if (browser) await browser.close();
  }

  console.log('\n' + '='.repeat(50));
  console.log(`下载完成: ${totalDownloaded} 张成功, ${totalFailed} 张失败`);
  console.log(`保存目录: ${downloadDir}`);
  console.log('='.repeat(50));
}

main().catch(e => {
  console.error('脚本出错:', e.message);
  process.exit(1);
});
