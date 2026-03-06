/**
 * 批量发布 - 文章（已含配图）→ 尾图 → HTML → 推送/发布
 * 配图由 AI 在生成文章时自主选择插入
 * 封面优先选择与主题角色匹配且比例接近 3:2 的图片
 */

const fs = require('fs');
const path = require('path');
const { marked } = require('marked');
const { imageSize } = require('image-size');
const { BaijiahaoAPI } = require('./baijiahao-api');
const { ToutiaoAPI } = require('./toutiao-api');
const { WechatAPI } = require('./wechat-api');
const { listArticles, updateMeta } = require('./content-manager');
const { selectCoverImage } = require('./image-library');
const env = require('./env');

const DEFAULT_IMAGE_DIR = env.imageDir();
const DEFAULT_TAIL_IMAGE = env.tailImage();

/**
 * Markdown 转 HTML（支持多平台）
 */
function mdToHtml(markdown, platform = 'baijiahao') {
  let html = marked(markdown);

  if (platform === 'toutiao') {
    html = ToutiaoAPI.cleanHtml(html);
  } else if (platform === 'wechat') {
    html = WechatAPI.cleanHtml(html);
  } else {
    html = BaijiahaoAPI.cleanHtml(html);
  }

  // 删除文章大标题（# 标题）
  html = html.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '');

  if (platform === 'toutiao') {
    // 头条：## 章节标题 → <h1 class="pgc-h-forward-slash">
    html = html.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (match, content) => {
      return `<h1 spellcheck="false" class="pgc-h-forward-slash">${content.trim()}</h1>`;
    });

    html = html.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (match, content) => {
      return `<h1 spellcheck="false" class="pgc-h-forward-slash">${content.trim()}</h1>`;
    });
  } else if (platform === 'wechat') {
    // 微信公众号：标题保持 h2/h3，图片居中
    html = html.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (match, content) => {
      return `<h2 style="font-weight: bold;">${content.trim()}</h2>`;
    });
    html = html.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (match, content) => {
      return `<h3 style="font-weight: bold;">${content.trim()}</h3>`;
    });
    // 所有段落统一左对齐，避免两端对齐导致的文字间距过大
    html = html.replace(/<p>/gi, '<p style="text-align: left;">');
    html = html.replace(/<p\s+style="([^"]*)"/gi, (match, existingStyle) => {
      if (existingStyle.includes('text-align')) return match;
      return `<p style="text-align: left; ${existingStyle}"`;
    });
    // 图片居中（替换包含图片的整个 <p> 标签，避免嵌套，去除额外间距）
    html = html.replace(/<p[^>]*>(\s*<img\s+[^>]+>\s*)<\/p>/gi, '<section style="text-align: center; margin: 16px 0;">$1</section>');
  } else {
    // 百家号：## 加粗，### 转 <p>
    html = html.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (match, content) => {
      if (/<strong>/i.test(content)) return match;
      return `<h2><strong>${content.trim()}</strong></h2>`;
    });

    html = html.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (match, content) => {
      return `<p><strong>${content.trim()}</strong></p>`;
    });
  }

  html = html.replace(/(<p>\s*<\/p>\s*){2,}/g, '');

  return html;
}

/**
 * 读取文章文件（支持 txt/md，有无 front matter 都行）
 */
function readArticle(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');

  if (raw.startsWith('---')) {
    try {
      const fm = require('front-matter');
      const { attributes, body } = fm(raw);
      return { meta: attributes, body };
    } catch {}
  }

  const lines = raw.trim().split('\n');
  let title = lines[0].replace(/^#+\s*/, '').trim();
  return { meta: { title }, body: raw };
}

/**
 * 提取文章中的本地图片路径
 */
function extractImagePaths(markdown) {
  const paths = [];
  const regex = /!\[[^\]]*\]\(([^)]+)\)/g;
  let match;
  while ((match = regex.exec(markdown)) !== null) {
    const src = match[1];
    if (fs.existsSync(src)) {
      paths.push(src);
    }
  }
  return paths;
}

/**
 * 创建平台 API 实例
 */
function createAPI(platform) {
  if (platform === 'toutiao') return new ToutiaoAPI();
  if (platform === 'wechat') return new WechatAPI();
  return new BaijiahaoAPI();
}

/**
 * 核心流程：文章（已含配图）→ 尾图 → HTML → 推送/发布
 */
async function pushWithImages(articlePath, imageDir, options = {}) {
  const platform = options.platform || 'baijiahao';
  const platformName = platform === 'toutiao' ? '头条' : platform === 'wechat' ? '公众号' : '百家号';
  const api = createAPI(platform);

  // 仅在非批量模式下检查登录（批量模式已在启动时统一检查）
  if (!options._skipAuth) {
    const auth = await api.checkAuth();
    if (!auth.success) {
      console.error(`${platformName}登录状态无效，请先更新 Cookie`);
      return null;
    }
  }

  const tailImage = options.tail || DEFAULT_TAIL_IMAGE;

  // 1. 读取文章（已含 AI 插入的配图标记）
  const { meta, body } = readArticle(articlePath);
  const title = meta.title || path.basename(articlePath, path.extname(articlePath));
  const totalChars = body.replace(/\s/g, '').length;
  console.log(`\n文章: ${title}`);
  console.log(`字数: ${totalChars}`);

  let finalBody = body;

  // 2. 统计文章中的配图
  const imagePaths = extractImagePaths(body);
  console.log(`配图: ${imagePaths.length} 张`);
  imagePaths.forEach(p => console.log(`  → ${path.basename(p)}`));

  // 3. 追加尾图
  if (tailImage && fs.existsSync(tailImage)) {
    finalBody += `\n\n![尾图](${tailImage})\n`;
    console.log(`已追加尾图`);
  }

  // 4. 转 HTML
  let html = mdToHtml(finalBody, platform);

  // 5. 封面：标题角色图 > 文中最佳比例图
  let coverImages = [];
  if (options.cover && fs.existsSync(options.cover)) {
    const uploaded = await api.uploadImage(options.cover);
    if (uploaded) {
      if (platform === 'wechat') {
        coverImages.push(uploaded);
      } else {
        coverImages.push(platform === 'toutiao' ? uploaded : { src: uploaded });
      }
    }
  } else {
    const work = meta.work || '';
    const { coverPath, fromLibrary, charName } = selectCoverImage({
      title,
      imageDir,
      workFilter: work || undefined,
      articleImagePaths: imagePaths,
    });

    // 如果封面图来自图库且文中未使用，插入到第一个 ## 标题后
    if (coverPath && fromLibrary) {
      const alreadyInArticle = imagePaths.some(p => path.resolve(p) === path.resolve(coverPath));
      if (!alreadyInArticle) {
        const insertPos = finalBody.indexOf('\n', finalBody.indexOf('## '));
        if (insertPos !== -1) {
          finalBody = finalBody.slice(0, insertPos) + `\n\n![配图](${coverPath})\n` + finalBody.slice(insertPos);
          console.log(`封面图未在文中出现，已插入到正文`);
          // 重新转 HTML
          html = mdToHtml(finalBody, platform);
        }
      }
    }
    if (coverPath) {
      console.log(`封面: ${path.basename(coverPath)}`);
      const uploaded = await api.uploadImage(coverPath);
      if (uploaded) {
        if (platform === 'wechat') {
          coverImages.push(uploaded);
        } else {
          coverImages.push(platform === 'toutiao' ? uploaded : { src: uploaded });
        }
      }
    } else {
      console.log('⚠ 无合适封面图');
    }
  }

  // 6. 上传正文图片并清理无法解析的残留
  console.log(`\n上传图片到${platformName}...`);
  html = await api.processContentImages(html);
  // 移除任何未能上传的本地路径图片（避免平台拒绝）
  html = html.replace(/<img[^>]+src="(?!https?:\/\/)[^"]*"[^>]*>/gi, (match) => {
    console.log(`  ⚠ 移除未解析图片: ${match.slice(0, 80)}...`);
    return '';
  });

  // 7. 保存草稿
  console.log('保存草稿...');
  const result = await api.saveDraft(title, html, coverImages);

  if (!result.success) {
    console.log(`✗ 草稿保存失败: ${result.message}`);
    return result;
  }

  console.log(`✓ 草稿已保存 (ID: ${result.article_id})`);

  // 8. 自动发布
  if (options.publish && (platform === 'baijiahao' || platform === 'wechat')) {
    console.log('发布中...');
    let pubResult;
    if (platform === 'wechat') {
      pubResult = await api.publishArticle(result.article_id);
    } else {
      pubResult = await api.publishArticle(result.article_id, title, html, coverImages);
    }
    if (pubResult.success) {
      console.log(`✓ 已发布${pubResult.publish_url ? ': ' + pubResult.publish_url : ''}`);
      return { ...result, published: true, publish_url: pubResult.publish_url || '' };
    } else {
      console.log(`✗ 发布失败: ${pubResult.message}`);
      console.log(`  草稿链接: ${result.draft_url}`);
      return { ...result, published: false, publish_message: pubResult.message };
    }
  }

  return result;
}

module.exports = { pushWithImages, mdToHtml, extractImagePaths, DEFAULT_IMAGE_DIR, DEFAULT_TAIL_IMAGE };
