/**
 * 文章原文抓取 — 通过搜索引擎获取热点相关内容
 */

const https = require('https');
const http = require('http');

function httpGetText(url, headers = {}, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        ...headers,
      },
    };
    const req = mod.request(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        const loc = res.headers.location;
        const redirectUrl = loc.startsWith('http') ? loc : `${u.protocol}//${u.host}${loc}`;
        resolve(httpGetText(redirectUrl, headers, maxRedirects - 1));
        return;
      }
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

/**
 * 通过 Bing 搜索获取热点话题的相关内容摘要
 */
async function fetchArticleContent(url, title) {
  const keyword = title || url;
  if (!keyword) return '';

  try {
    const encoded = encodeURIComponent(keyword);
    const searchUrl = `https://cn.bing.com/search?q=${encoded}&count=10`;
    const html = await httpGetText(searchUrl, { Referer: 'https://cn.bing.com/' });

    // 提取搜索结果摘要
    const snippets = html.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || [];
    const texts = snippets
      .map(s => s.replace(/<[^>]+>/g, '').replace(/&\w+;/g, ' ').trim())
      .filter(t => t.length > 50 && !t.includes('function') && !t.includes('var '));

    if (!texts.length) return '';

    // 合并去重
    const seen = new Set();
    const unique = [];
    for (const t of texts) {
      const key = t.slice(0, 50);
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(t);
      }
    }

    return unique.join('\n\n');
  } catch (e) {
    console.log(`搜索内容抓取失败: ${e.message}`);
    return '';
  }
}

module.exports = { fetchArticleContent };
