#!/usr/bin/env node
/**
 * 批量从百度图片搜索下载角色图片
 * 通过 puppeteer 无头浏览器提取 data-objurl/data-thumbnail-url
 *
 * 用法:
 *   node scripts/download-images.js 水浒传                   # 扫描已有图片，补齐不足3张的角色
 *   node scripts/download-images.js 水浒传 武大郎 宋江       # 只下载指定角色（自动补齐到3张）
 *   node scripts/download-images.js 水浒传 武大郎 宋江 -n 5  # 每角色下载5张
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const { chromePath, imageDir } = require('../src/env');

const CHROME_PATH = chromePath();
if (!CHROME_PATH || !fs.existsSync(CHROME_PATH)) {
  console.error(`Chrome 浏览器未找到: ${CHROME_PATH || '(未配置)'}`);
  console.error('请在 .env.local 中配置 CHROME_PATH，例如:');
  console.error('  macOS:   CHROME_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  console.error('  Windows: CHROME_PATH=C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  console.error('  Linux:   CHROME_PATH=/usr/bin/google-chrome');
  process.exit(1);
}

const PUBLISH_CONFIG_PATH = path.join(__dirname, '..', 'publish_config.json');

if (!fs.existsSync(PUBLISH_CONFIG_PATH)) {
  console.error('未找到 publish_config.json，请先创建配置文件');
  process.exit(1);
}
let WORKS;
try {
  const config = JSON.parse(fs.readFileSync(PUBLISH_CONFIG_PATH, 'utf-8'));
  WORKS = Object.keys(config.works || {});
} catch (e) {
  console.error(`publish_config.json 解析失败: ${e.message}`);
  process.exit(1);
}

// 解析参数
const args = process.argv.slice(2);
if (!args.length) {
  console.log('用法: node scripts/download-images.js <作品名> [角色1 角色2 ...] [-n 数量]');
  console.log('  无角色名: 扫描图片目录，补齐不足3张的角色');
  console.log('  有角色名: 只下载指定角色');
  console.log('  -n 数量:  每角色目标张数 (默认3)');
  process.exit(0);
}

const WORK = args[0];
if (!WORKS.includes(WORK)) {
  console.error(`未知作品: ${WORK}\n可选: ${WORKS.join(', ')}`);
  process.exit(1);
}

let TARGET_COUNT = 3;
const nIdx = args.indexOf('-n');
if (nIdx !== -1 && args[nIdx + 1]) {
  TARGET_COUNT = parseInt(args[nIdx + 1]);
  args.splice(nIdx, 2);
}

const specifiedNames = args.slice(1);
const EXISTING_DIR = path.join(imageDir(), WORK);
const DOWNLOAD_DIR = path.join(imageDir(), '..', 'downloads', WORK);

function countImages(name, dir) {
  if (!fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir);
  return files.filter(f => {
    const base = path.basename(f, path.extname(f));
    return base === name || new RegExp(`^${name}\\d+$`).test(base);
  }).length;
}

/**
 * 扫描图片目录，提取所有角色名（去重去编号）
 */
function scanExistingCharacters(dir) {
  if (!fs.existsSync(dir)) return [];
  const names = new Set();
  for (const f of fs.readdirSync(dir)) {
    const ext = path.extname(f).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) continue;
    const base = path.basename(f, ext);
    if (base === '封面') continue;
    const name = base.replace(/\d+$/, '') || base;
    names.add(name);
  }
  return [...names].sort();
}

async function main() {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  // 确定角色列表
  let characterNames;
  if (specifiedNames.length) {
    characterNames = specifiedNames;
    console.log(`指定下载 ${characterNames.length} 个角色: ${characterNames.join(', ')}`);
  } else {
    characterNames = scanExistingCharacters(EXISTING_DIR);
    console.log(`扫描到 ${characterNames.length} 个已有角色，检查图片完整性...`);
  }

  // 计算每个角色需要下载多少张
  const tasks = [];
  for (const name of characterNames) {
    const existing = countImages(name, EXISTING_DIR);
    const downloaded = countImages(name, DOWNLOAD_DIR);
    const total = existing + downloaded;
    if (total >= TARGET_COUNT) continue;
    tasks.push({ name, need: TARGET_COUNT - total, startIdx: total });
  }

  if (!tasks.length) {
    console.log(`所有角色图片已满 ${TARGET_COUNT} 张，无需下载`);
    return;
  }

  console.log(`需要为 ${tasks.length} 个角色下载图片，共约 ${tasks.reduce((s, t) => s + t.need, 0)} 张\n`);

  console.log('启动无头浏览器...');
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1920,1080'],
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setViewport({ width: 1920, height: 1080 });

  // 单独的下载页面
  const dlPage = await browser.newPage();
  await dlPage.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  let totalDownloaded = 0;
  let totalFailed = 0;

  for (let ti = 0; ti < tasks.length; ti++) {
    const { name, need, startIdx } = tasks[ti];
    console.log(`[${ti + 1}/${tasks.length}] ${name} — 需要 ${need} 张`);

    try {
      const searchUrl = `https://image.baidu.com/search/index?tn=baiduimage&word=${encodeURIComponent(WORK + ' ' + name + ' 影视')}&pn=0&rn=30`;
      await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 25000 });
      await new Promise(r => setTimeout(r, 2000));

      // 滚动一下让更多图片加载
      await page.evaluate(() => window.scrollBy(0, 800));
      await new Promise(r => setTimeout(r, 1500));

      // 提取图片 URL：优先 data-thumbnail-url（百度CDN大图），备选 data-objurl（原始源）
      const imageUrls = await page.evaluate(() => {
        const results = [];
        const imgs = document.querySelectorAll('img[data-objurl]');
        for (const img of imgs) {
          const thumbUrl = img.getAttribute('data-thumbnail-url') || '';
          const objUrl = img.getAttribute('data-objurl') || '';
          if (thumbUrl && thumbUrl.includes('baidu.com/it/')) {
            results.push({ thumb: thumbUrl, obj: objUrl });
          } else if (objUrl) {
            results.push({ thumb: '', obj: objUrl });
          }
        }
        return results;
      });

      if (!imageUrls.length) {
        console.log(`  ⚠ 未找到图片，跳过`);
        totalFailed += need;
        continue;
      }

      console.log(`  找到 ${imageUrls.length} 张候选图片`);

      let downloaded = 0;
      for (let i = 0; i < imageUrls.length && downloaded < need; i++) {
        const { thumb, obj } = imageUrls[i];
        // 优先用百度 CDN 缩略图（稳定、无防盗链），备选用原始 URL
        const urlToTry = thumb || obj;
        const idx = startIdx + downloaded;
        const fileName = idx === 0 ? `${name}.jpg` : `${name}${idx + 1}.jpg`;
        const filePath = path.join(DOWNLOAD_DIR, fileName);

        try {
          // 通过浏览器 fetch 下载（绕过 CORS/防盗链）
          const imgData = await dlPage.evaluate(async (url) => {
            try {
              const resp = await fetch(url, { referrerPolicy: 'no-referrer' });
              if (!resp.ok) return null;
              const ct = resp.headers.get('content-type') || '';
              if (!ct.includes('image')) return null;
              const buf = await resp.arrayBuffer();
              if (buf.byteLength < 15000) return null; // 过滤 logo
              const bytes = new Uint8Array(buf);
              let binary = '';
              for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
              return { base64: btoa(binary), size: buf.byteLength };
            } catch { return null; }
          }, urlToTry);

          if (!imgData) {
            // 如果百度CDN失败，尝试原始URL
            if (obj && urlToTry !== obj) {
              const imgData2 = await dlPage.evaluate(async (url) => {
                try {
                  const resp = await fetch(url, { referrerPolicy: 'no-referrer' });
                  if (!resp.ok) return null;
                  const ct = resp.headers.get('content-type') || '';
                  if (!ct.includes('image')) return null;
                  const buf = await resp.arrayBuffer();
                  if (buf.byteLength < 15000) return null;
                  const bytes = new Uint8Array(buf);
                  let binary = '';
                  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
                  return { base64: btoa(binary), size: buf.byteLength };
                } catch { return null; }
              }, obj);

              if (imgData2) {
                fs.writeFileSync(filePath, Buffer.from(imgData2.base64, 'base64'));
                console.log(`  ✓ ${fileName} (${Math.round(imgData2.size / 1024)}KB) [原始源]`);
                downloaded++;
                totalDownloaded++;
                continue;
              }
            }
            continue;
          }

          fs.writeFileSync(filePath, Buffer.from(imgData.base64, 'base64'));
          console.log(`  ✓ ${fileName} (${Math.round(imgData.size / 1024)}KB)`);
          downloaded++;
          totalDownloaded++;
        } catch (e) {
          // 静默跳过
        }
      }

      if (downloaded < need) {
        console.log(`  ⚠ 只下载了 ${downloaded}/${need} 张`);
        totalFailed += (need - downloaded);
      }

    } catch (e) {
      console.log(`  ✗ 搜索失败: ${e.message}`);
      totalFailed += need;
    }

    if (ti < tasks.length - 1) {
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  await browser.close();

  console.log('\n' + '='.repeat(50));
  console.log(`下载完成: ${totalDownloaded} 张成功, ${totalFailed} 张失败`);
  console.log(`保存目录: ${DOWNLOAD_DIR}`);
  console.log('='.repeat(50));

}

main().catch(e => {
  console.error('脚本出错:', e.message);
  process.exit(1);
});
