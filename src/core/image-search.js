/**
 * 网络图片搜索 — Bing 图片
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./config');

const TMP_DIR = path.join(PROJECT_ROOT, 'data', 'tmp', 'images');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function httpGetBuffer(url, headers = {}, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...headers,
      },
    };
    const req = mod.request(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        const redirectUrl = res.headers.location.startsWith('http') ? res.headers.location : `${u.protocol}//${u.host}${res.headers.location}`;
        resolve(httpGetBuffer(redirectUrl, headers, maxRedirects - 1));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

/**
 * 搜索 Bing 图片，返回图片 URL 列表
 */
async function searchBingImages(keyword, count = 5) {
  const urls = [];
  try {
    const encoded = encodeURIComponent(keyword);
    const url = `https://cn.bing.com/images/async?q=${encoded}&first=0&count=${count * 2}&mmasync=1&qft=+filterui:photo-photo`;
    const raw = await httpGetBuffer(url, {
      'Accept': 'text/html',
      'Referer': 'https://cn.bing.com/',
    });
    const html = raw.toString('utf-8');
    const matches = html.match(/murl&quot;:&quot;(https?:\/\/[^&]+?)&quot;/g) || [];
    for (const m of matches) {
      const imgUrl = m.replace('murl&quot;:&quot;', '').replace('&quot;', '');
      if (imgUrl && imgUrl.startsWith('http')) {
        urls.push(imgUrl);
        if (urls.length >= count) break;
      }
    }
  } catch (e) {
    console.log(`Bing 图片搜索失败: ${e.message}`);
  }
  return urls;
}

/**
 * 下载图片到本地临时目录
 */
async function downloadImage(url, filename) {
  ensureDir(TMP_DIR);
  const urlPath = new URL(url).pathname;
  let ext = path.extname(urlPath);
  if (!ext || ext.length > 5) ext = '.jpg';
  const filePath = path.join(TMP_DIR, `${filename}${ext}`);

  try {
    const data = await httpGetBuffer(url);
    if (data.length < 2000) return null;
    fs.writeFileSync(filePath, data);
    return filePath;
  } catch (e) {
    console.log(`图片下载失败: ${e.message}`);
    return null;
  }
}

/**
 * 搜索并下载图片，返回本地路径数组
 */
async function searchAndDownloadImages(keyword, count = 3) {
  const urls = await searchBingImages(keyword, count + 3);
  const results = [];
  const ts = Date.now();

  for (let i = 0; i < urls.length && results.length < count; i++) {
    const localPath = await downloadImage(urls[i], `hot_${ts}_${i}`);
    if (localPath) results.push(localPath);
  }

  return results;
}

module.exports = { searchBingImages, searchAndDownloadImages, downloadImage };
