#!/usr/bin/env node
/**
 * 微信公众号发布工具 CLI
 * 从 Notion 目录批量获取文章 → AI 自动配图 → 保存为公众号草稿
 * 所有作品配置统一在 publish_config.json 的 wechat 字段中管理
 */

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');

const { WechatAPI } = require('./wechat-api');
const { fetchNotionPage, fetchNotionDirectory } = require('./notion-fetcher');
const { mdToHtml, extractImagePaths, DEFAULT_IMAGE_DIR, DEFAULT_TAIL_IMAGE } = require('./batch-publish');
const { buildImageList, resolveImageNames, stripLastSectionImages, generateArticle } = require('./article-generator');
const { selectCoverImage } = require('./image-library');
const { generateTopics } = require('./topic-generator');
const { callLLM } = require('./llm');

const SYNC_STATE_FILE = path.join(__dirname, '..', '.wx-sync-state.json');
const WX_SYNC_DIR = path.join(__dirname, '..', 'archive', 'wechat', 'sync');
const WX_GENERATED_DIR = path.join(__dirname, '..', 'archive', 'wechat', 'generated');
const PUBLISH_CONFIG_PATH = path.join(__dirname, '..', 'publish_config.json');

/**
 * 加载所有作品配置
 * 从 publish_config.json 的 wechat 字段读取
 */
function loadPublishConfig() {
  if (!fs.existsSync(PUBLISH_CONFIG_PATH)) {
    console.error('未找到 publish_config.json，请先创建配置文件');
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(PUBLISH_CONFIG_PATH, 'utf-8'));
  } catch (e) {
    console.error(`publish_config.json 解析失败: ${e.message}`);
    return null;
  }
}

function loadAllWorkConfigs() {
  const config = loadPublishConfig();
  return config ? (config.wechat || {}) : {};
}

/**
 * 加载单个作品配置（合集ID、配图目录等）
 */
function loadWorkConfig(work) {
  return loadAllWorkConfigs()[work] || null;
}

/**
 * 读取同步状态（Notion 页面 ID → 微信草稿信息）
 */
function loadSyncState() {
  if (!fs.existsSync(SYNC_STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(SYNC_STATE_FILE, 'utf-8'));
  } catch (e) {
    console.error(`⚠ 同步状态文件解析失败: ${e.message}`);
    return {};
  }
}

/**
 * 保存同步状态
 */
function saveSyncState(state) {
  fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * 归档 AI 配图后的文章 Markdown
 * @param {string} title 文章标题
 * @param {string} markdown 文章内容
 * @param {string} outputDir 归档目录
 */
function saveArticleArchive(title, markdown, outputDir) {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  // 清理标题中的特殊字符作为文件名
  const safeName = title.replace(/[*"/\\<>|?:]/g, '').trim();
  const filePath = path.join(outputDir, `${safeName}.md`);
  fs.writeFileSync(filePath, markdown, 'utf-8');
  const relPath = path.relative(path.join(__dirname, '..'), outputDir);
  console.log(`  归档: ${relPath}/${safeName}.md`);
}

/**
 * AI 配图：将文章和可用图片列表发给豆包，由 AI 决定插图位置和角色
 * @param {string[]} [allowedGroups] 允许的图片子目录列表
 */
async function aiInsertImages(markdown, imageDir, work, allowedGroups) {
  const imageList = buildImageList(imageDir, work, allowedGroups);
  if (!imageList) {
    console.log('  无可用配图列表');
    return markdown;
  }

  const prompt = `你是配图助手。以下是一篇已写好的文章和可用的配图人物列表。
请在文章的适当位置插入配图标记。

要求：
- 每 300 字左右插入一张配图，格式：![配图](人物名)，如 ![配图](孙悟空)
- 人物名必须从下面的可用配图列表中原样选取（如"孙悟空""周瑜""郭襄"），严禁使用场景描述（如"白衣渡江""水淹七军""大闹天宫"），找不到匹配人物宁可不插图
- 注意人物别名：二郎神=杨戬、猪八戒=天蓬元帅、沙僧=沙悟净，遇到别名请使用列表中对应的名称
- 根据上下文选择最相关的人物角色
- 最后一个章节不插图
- 保持原文内容完全不变，只添加配图标记
- 输出完整的文章（含配图标记），Markdown 格式，不要输出额外说明

可用配图：
${imageList}

文章：
${markdown}`;

  console.log('  AI 分析配图中...');
  let result = await callLLM(prompt, { maxTokens: 8000 });
  if (!result) {
    console.log('  AI 配图失败，跳过配图');
    return markdown;
  }

  // 修正 AI 常见畸形写法
  result = result
    .replace(/!\[([^\]】]*)】\(/g, '![$1](')
    .replace(/！\[/g, '![')
    .replace(/\]\（/g, '](')
    .replace(/）/g, ')');

  // 解析图片名称 → 本地路径
  const resolved = resolveImageNames(result, imageDir, work, allowedGroups);
  let article = stripLastSectionImages(resolved.article);

  console.log(`  AI 配图完成: 匹配 ${resolved.matched.length} 张, 缺失 ${resolved.missing.length} 张`);
  return article;
}

/**
 * 根据作品配置构建合集 albumInfo JSON
 */
function buildAlbumInfo(workConfig) {
  if (!workConfig || !workConfig.album_id) {
    return JSON.stringify({ appmsg_album_infos: [] });
  }
  return JSON.stringify({
    appmsg_album_infos: [{
      continous_read_on: 1,
      cover_url: '',
      id: workConfig.album_id,
      is_ban: 0,
      is_updating: 1,
      need_pay: 0,
      title: workConfig.album_title || '',
      type: 0,
    }],
  });
}

const program = new Command();
program.name('wx').description('微信公众号发布工具（Notion → 配图 → 发布）').version('1.0.0');

// ==================== 登录 ====================

program
  .command('login')
  .description('设置公众号 Cookie（从浏览器 mp.weixin.qq.com 复制）')
  .argument('<cookie>', 'Cookie 字符串')
  .action((cookie) => {
    const envPath = path.join(__dirname, '..', '.env.local');
    const raw = fs.readFileSync(envPath, 'utf-8');
    const lines = raw.split('\n');
    let replaced = false;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().startsWith('WECHAT_COOKIE=')) {
        lines[i] = `WECHAT_COOKIE=${cookie.trim()}`;
        replaced = true;
        break;
      }
    }
    if (!replaced) lines.push(`WECHAT_COOKIE=${cookie.trim()}`);
    fs.writeFileSync(envPath, lines.join('\n'), 'utf-8');
    console.log('公众号 Cookie 已更新到 .env.local');
  });

// ==================== 检查登录 ====================

program
  .command('check')
  .description('检查公众号登录状态')
  .action(async () => {
    const api = new WechatAPI();
    await api.checkAuth();
  });

// ==================== 同步单个作品 ====================

/**
 * 同步单个作品：从 Notion 目录获取文章 → 配图 → 保存草稿
 * @returns {{ success: number, fail: number }}
 */
async function syncOneWork(api, workName, workConfig, opts) {
  const imageDir = path.resolve(DEFAULT_IMAGE_DIR);
  const allowedGroups = workConfig.image_dirs || [workName];
  const interval = parseInt(opts.interval) * 1000;

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  作品: ${workName}`);
  console.log('='.repeat(50));

  // 1. 获取目录页，发现子页面
  console.log('\n获取 Notion 目录页...');
  let childPages;
  try {
    childPages = await fetchNotionDirectory(workConfig.notionUrl);
  } catch (e) {
    console.error(`获取目录页失败: ${e.message}`);
    return { success: 0, fail: 0 };
  }

  if (!childPages.length) {
    console.log('目录页中没有子页面');
    return { success: 0, fail: 0 };
  }

  // 2. 过滤已处理的页面
  const currentState = loadSyncState();
  const total = childPages.length;
  const synced = [];
  const pendingPages = [];
  for (const child of childPages) {
    if (currentState[child.id]) {
      synced.push(child);
    } else {
      pendingPages.push(child);
    }
  }
  if (synced.length) {
    console.log(`\n已同步 ${synced.length} 篇（跳过）:`);
    synced.forEach((p, i) => {
      const info = currentState[p.id];
      console.log(`  ${i + 1}. ${p.title} → 草稿 ${info.article_id}`);
    });
  }

  if (!pendingPages.length) {
    console.log('\n所有页面已同步，无需处理');
    return { success: 0, fail: 0 };
  }

  console.log(`\n  待处理: ${pendingPages.length} 篇 / 总计: ${total} 篇`);

  // 4. 逐篇处理
  const results = [];
  let successCount = 0;

  for (let i = 0; i < pendingPages.length; i++) {
    const child = pendingPages[i];
    const pageUrl = `https://www.notion.so/${child.id.replace(/-/g, '')}`;

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  [${i + 1}/${pendingPages.length}] ${child.title}`);
    console.log('─'.repeat(50));

    // 限流
    if (i > 0) {
      console.log(`等待 ${opts.interval} 秒...`);
      await new Promise(r => setTimeout(r, interval));
    }

    try {
      // 获取页面内容
      console.log('获取页面内容...');
      const page = await fetchNotionPage(pageUrl);
      const { title, markdown } = page;
      console.log(`  字数: ${markdown.replace(/\s/g, '').length}`);

      // AI 自动配图
      let finalMarkdown = markdown;
      if (opts.autoImages !== false) {
        console.log('AI 自动配图...');
        finalMarkdown = await aiInsertImages(markdown, imageDir, workName, allowedGroups);
        const origCount = (markdown.match(/!\[.*?\]\(.*?\)/g) || []).length;
        const newCount = (finalMarkdown.match(/!\[.*?\]\(.*?\)/g) || []).length;
        if (newCount > origCount) console.log(`  新增配图: ${newCount - origCount} 张`);
      }

      // 归档 AI 配图后的文章
      saveArticleArchive(title, finalMarkdown, WX_SYNC_DIR);

      // 尾图
      const tailImage = DEFAULT_TAIL_IMAGE;
      if (tailImage && fs.existsSync(tailImage)) {
        finalMarkdown += `\n\n![尾图](${tailImage})\n`;
      }

      // 转 HTML
      let html = mdToHtml(finalMarkdown, 'wechat');

      // 封面：标题角色图 > 文中最佳比例图
      const imagePaths = extractImagePaths(finalMarkdown);
      let coverUrl = null;
      const coverResult = selectCoverImage({
        title,
        imageDir: opts.images ? path.resolve(opts.images) : DEFAULT_IMAGE_DIR,
        workFilter: workName,
        articleImagePaths: imagePaths,
      });

      if (coverResult.coverPath) {
        // 如果封面图来自图库且文中未使用，插入到文中
        if (coverResult.fromLibrary) {
          const alreadyInArticle = imagePaths.some(p => path.resolve(p) === path.resolve(coverResult.coverPath));
          if (!alreadyInArticle) {
            const insertPos = finalMarkdown.indexOf('\n', finalMarkdown.indexOf('## '));
            if (insertPos !== -1) {
              finalMarkdown = finalMarkdown.slice(0, insertPos) + `\n\n![配图](${coverResult.coverPath})\n` + finalMarkdown.slice(insertPos);
              console.log(`封面图未在文中出现，已插入到正文`);
            }
          }
          console.log(`封面（标题角色）: ${path.basename(coverResult.coverPath)}`);
        } else {
          console.log(`封面（文中配图）: ${path.basename(coverResult.coverPath)}`);
        }
        const uploaded = await api.uploadImage(coverResult.coverPath);
        coverUrl = uploaded?.url || null;
      }

      // 上传正文图片
      console.log('上传图片...');
      html = await api.processContentImages(html);
      html = html.replace(/<img[^>]+src="(?!https?:\/\/)[^"]*"[^>]*>/gi, () => '');

      // 保存草稿
      console.log('保存草稿...');
      const albumInfo = buildAlbumInfo(workConfig);
      const result = await api.saveDraft(title, html, coverUrl, { albumInfo });

      if (result.success) {
        successCount++;
        console.log(`✓ 草稿已保存 (ID: ${result.article_id})`);
        results.push({ title, success: true, article_id: result.article_id, draft_url: result.draft_url });

        // 记录同步状态（每篇成功后立即保存，防止中断丢失）
        const latestState = loadSyncState();
        latestState[child.id] = {
          title,
          article_id: result.article_id,
          draft_url: result.draft_url,
          saved_at: new Date().toISOString(),
        };
        saveSyncState(latestState);
      } else {
        console.error(`✗ 草稿保存失败: ${result.message}`);
        results.push({ title, success: false, message: result.message });
      }
    } catch (e) {
      console.error(`✗ 处理失败: ${e.message}`);
      results.push({ title: child.title, success: false, message: e.message });
    }
  }

  // 5. 汇总
  const failCount = pendingPages.length - successCount;
  console.log(`\n  ${workName} 完成: 处理 ${pendingPages.length} 篇 | 成功 ${successCount} | 失败 ${failCount}`);
  results.forEach((r, i) => {
    const icon = r.success ? '✓' : '✗';
    console.log(`  ${icon} ${i + 1}. ${r.title}`);
    if (r.success) console.log(`      ${r.draft_url}`);
    else console.log(`      ${r.message}`);
  });

  return { success: successCount, fail: failCount };
}

// ==================== AI 直接生成 ====================

/**
 * AI 直接生成文章并推送到微信草稿箱
 * 读取 wechat 配置中每个作品的 count，生成对应数量的文章
 */
program
  .command('generate')
  .description('AI 直接生成文章 → 推送到公众号草稿箱（按 wechat 配置的 count）')
  .argument('[work]', '作品名称，不传则处理所有 count > 0 的作品')
  .option('--interval <seconds>', '每篇文章之间的间隔秒数', '15')
  .option('--rounds <n>', '执行轮次（每轮按配置生成一批文章）', '1')
  .option('--no-push', '仅生成文章，不推送到草稿箱')
  .action(async (work, opts) => {
    const allConfigs = loadAllWorkConfigs();
    const imageDir = path.resolve(DEFAULT_IMAGE_DIR);
    const interval = parseInt(opts.interval) * 1000;

    // 确定要生成的作品列表
    let worksToGenerate;
    if (work) {
      const config = allConfigs[work];
      if (!config) {
        console.error(`作品 "${work}" 未在 publish_config.json 的 wechat 中配置`);
        console.log(`可用作品: ${Object.keys(allConfigs).join('、')}`);
        return;
      }
      const count = config.count || 0;
      if (count <= 0) {
        console.log(`作品 "${work}" 的 count 为 ${count}，无需生成`);
        return;
      }
      worksToGenerate = [{ name: work, config, count }];
    } else {
      worksToGenerate = Object.entries(allConfigs)
        .filter(([, c]) => (c.count || 0) > 0)
        .map(([name, config]) => ({ name, config, count: config.count }));
      if (!worksToGenerate.length) {
        console.error('publish_config.json 的 wechat 中没有 count > 0 的作品');
        return;
      }
    }

    const totalArticles = worksToGenerate.reduce((sum, w) => sum + w.count, 0);

    // 读取合并配置
    const publishConfig = loadPublishConfig() || {};
    const wechatCombine = publishConfig.wechat_combine === true;

    // 合并模式下校验不超过 8 篇
    const MAX_COMBINE_ARTICLES = 8;
    if (wechatCombine && totalArticles > MAX_COMBINE_ARTICLES) {
      console.error(`合并模式下最多 ${MAX_COMBINE_ARTICLES} 篇，当前计划 ${totalArticles} 篇，请减少 count 配置`);
      return;
    }

    const rounds = parseInt(opts.rounds) || 1;

    console.log('='.repeat(60));
    console.log('  微信公众号 - AI 直接生成');
    console.log('='.repeat(60));
    worksToGenerate.forEach(w => console.log(`  ${w.name}: ${w.count} 篇`));
    console.log(`  合计: ${totalArticles} 篇/轮`);
    if (rounds > 1) console.log(`  轮次: ${rounds} 轮（共 ${totalArticles * rounds} 篇）`);
    console.log(`  合并: ${wechatCombine ? '多图文合并' : '逐篇独立草稿'}`);
    console.log(`  间隔: ${opts.interval} 秒`);
    console.log(`  推送: ${opts.push !== false ? '保存到草稿箱' : '仅生成不推送'}`);
    console.log('='.repeat(60));

    // 检查登录
    let api;
    if (opts.push !== false) {
      api = new WechatAPI();
      const auth = await api.checkAuth();
      if (!auth.success) {
        console.error('公众号未登录，请先运行: wx login "<cookie>"');
        return;
      }
    }

    // 热文分析
    let topArticlesHint = null;
    try {
      console.log('\n  分析热文数据...');
      const wxApi = api || new WechatAPI();
      if (!api) await wxApi.fetchToken();
      const { byRead } = await wxApi.fetchTopArticles(10);

      const hasData = byRead.length > 0 && byRead[0].read_num > 0;
      if (hasData) {
        const formatLine = (a, i) => `${i + 1}. 「${a.title}」 阅读:${a.read_num} 点赞:${a.like_num} 分享:${a.share_num} 评论:${a.comment_num}`;
        const analysisInput = '【阅读量最高的文章】\n' + byRead.map(formatLine).join('\n');

        console.log(`  已获取热文数据`);
        byRead.slice(0, 3).forEach((a, i) => {
          console.log(`    ${i + 1}. ${a.title} (阅读${a.read_num} 点赞${a.like_num})`);
        });

        topArticlesHint = await callLLM(
          `分析以下微信公众号已发布文章的数据：

${analysisInput}

请从以下维度分析（简洁，每点1-2句话）：
1. 高阅读量文章的标题共性（句式、用词、悬念感）
2. 低阅读量文章的标题问题在哪
3. 哪些选题方向/作品/角色更受欢迎
4. 对后续选题和写作的3条具体建议

直接输出分析，不要超过400字。`,
          { maxTokens: 600 }
        );
        if (topArticlesHint) {
          console.log('  热文分析完成');
        }
      } else {
        console.log('  文章数据暂无（阅读均为0），跳过热文分析');
      }
    } catch (e) {
      console.error(`  热文分析失败（不影响生成）: ${e.message}`);
    }

    let grandTotalSuccess = 0;
    let grandTotalFail = 0;

    for (let round = 0; round < rounds; round++) {
    if (rounds > 1) {
      console.log(`\n${'▶'.repeat(3)} 第 ${round + 1}/${rounds} 轮`);
    }

    let globalIdx = 0;
    let totalSuccess = 0;
    let totalFail = 0;
    const allResults = [];
    const draftArticles = []; // 收集所有文章，最后合并为一个草稿

    for (const { name: workName, config: workConfig, count } of worksToGenerate) {
      console.log(`\n${'#'.repeat(60)}`);
      console.log(`  ${workName} — 计划 ${count} 篇`);
      console.log('#'.repeat(60));

      // 生成选题
      const topics = await generateTopics(count, workName, 'wechat', topArticlesHint);
      if (!topics.length) {
        console.error(`  ${workName}: 选题生成失败`);
        totalFail += count;
        for (let k = 0; k < count; k++) {
          allResults.push({ work: workName, title: null, success: false, message: '选题生成失败' });
        }
        continue;
      }
      console.log(`  生成了 ${topics.length} 个选题`);
      topics.forEach((t, i) => console.log(`    ${i + 1}. [${t.category}] ${t.topic}`));

      const allowedGroups = workConfig.image_dirs || [workName];

      for (let i = 0; i < topics.length; i++) {
        globalIdx++;
        const t = topics[i];
        console.log(`\n${'─'.repeat(60)}`);
        console.log(`  [${globalIdx}/${totalArticles}] ${workName} — ${t.topic}`);
        console.log('─'.repeat(60));

        try {
          // 1. AI 生成文章
          console.log('  AI 写作中...');
          const { article: content, imageStats } = await generateArticle(
            t.topic,
            null,
            t.work,
            t.characters,
            imageDir,
            t.category,
            t.related_works,
            { wordCount: '2500-3500', maxTokens: 10000, topArticlesHint }
          );
          const wordCount = content.replace(/\s/g, '').replace(/[#*\-\[\]()]/g, '').length;
          console.log(`  生成完成: ${wordCount} 字`);
          if (imageStats.matched.length) {
            console.log(`  配图: ${imageStats.matched.length} 张匹配`);
          }
          if (imageStats.missing.length) {
            console.log(`  缺失: ${imageStats.missing.join('、')}`);
          }

          // 归档文章
          saveArticleArchive(t.topic, content, WX_GENERATED_DIR);

          if (opts.push === false) {
            console.log('  跳过推送（--no-push）');
            totalSuccess++;
            allResults.push({ work: workName, title: t.topic, success: true, skipped: true });
            continue;
          }

          // 2. 追加尾图
          let finalMarkdown = content;
          const tailImage = DEFAULT_TAIL_IMAGE;
          if (tailImage && fs.existsSync(tailImage)) {
            finalMarkdown += `\n\n![尾图](${tailImage})\n`;
          }

          // 3. 转 HTML
          let html = mdToHtml(finalMarkdown, 'wechat');

          // 4. 封面
          const imagePaths = extractImagePaths(finalMarkdown);
          let coverUrl = null;
          const coverResult = selectCoverImage({
            title: t.topic,
            imageDir,
            workFilter: workName,
            articleImagePaths: imagePaths,
          });

          if (coverResult.coverPath) {
            if (coverResult.fromLibrary) {
              console.log(`  封面（标题角色）: ${path.basename(coverResult.coverPath)}`);
            } else {
              console.log(`  封面（文中配图）: ${path.basename(coverResult.coverPath)}`);
            }
            const uploaded = await api.uploadImage(coverResult.coverPath);
            coverUrl = uploaded?.url || null;
          }

          // 5. 上传正文图片
          console.log('  上传图片...');
          html = await api.processContentImages(html);
          html = html.replace(/<img[^>]+src="(?!https?:\/\/)[^"]*"[^>]*>/gi, () => '');

          // 6. 收集到待合并列表
          const albumInfo = buildAlbumInfo(workConfig);
          draftArticles.push({
            title: t.topic,
            content: html,
            coverUrl,
            options: { albumInfo },
            work: workName,
          });
          totalSuccess++;
          allResults.push({ work: workName, title: t.topic, success: true });

        } catch (e) {
          totalFail++;
          console.error(`  ✗ 处理失败: ${e.message}`);
          allResults.push({ work: workName, title: t.topic, success: false, message: e.message, _topicObj: t });
        }
      }
    }

    // ── 失败补偿：对本轮失败的文章重新生成一次 ──
    const failedItems = allResults.filter(r => !r.success);
    if (failedItems.length > 0) {
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`  补偿重试：${failedItems.length} 篇失败文章`);
      console.log('─'.repeat(60));

      for (const failedItem of failedItems) {
        const workName = failedItem.work;
        const workEntry = worksToGenerate.find(w => w.name === workName);
        if (!workEntry) continue;
        const workConfig = workEntry.config;
        const allowedGroups = workConfig.image_dirs || [workName];

        console.log(`\n  ▷ 补偿 [${workName}] ${failedItem.title || '(选题失败)'}`);

        try {
          // 如果原来就是选题失败，重新生成选题
          let topic = failedItem._topicObj;
          if (!topic) {
            console.log('  重新生成选题...');
            const retryTopics = await generateTopics(1, workName, 'wechat', topArticlesHint);
            if (!retryTopics.length) {
              console.error(`  ✗ 补偿选题仍然失败: ${workName}`);
              continue;
            }
            topic = retryTopics[0];
            console.log(`  新选题: [${topic.category}] ${topic.topic}`);
          }

          console.log('  AI 写作中...');
          const { article: content, imageStats } = await generateArticle(
            topic.topic, null, topic.work, topic.characters,
            imageDir, topic.category, topic.related_works,
            { wordCount: '2500-3500', maxTokens: 10000, topArticlesHint }
          );
          const wordCount = content.replace(/\s/g, '').replace(/[#*\-\[\]()]/g, '').length;
          console.log(`  生成完成: ${wordCount} 字`);
          if (imageStats.matched.length) console.log(`  配图: ${imageStats.matched.length} 张匹配`);

          saveArticleArchive(topic.topic, content, WX_GENERATED_DIR);

          if (opts.push !== false) {
            let finalMarkdown = content;
            const tailImage = DEFAULT_TAIL_IMAGE;
            if (tailImage && fs.existsSync(tailImage)) {
              finalMarkdown += `\n\n![尾图](${tailImage})\n`;
            }
            let html = mdToHtml(finalMarkdown, 'wechat');
            const imagePaths = extractImagePaths(finalMarkdown);
            let coverUrl = null;
            const coverResult = selectCoverImage({
              title: topic.topic, imageDir, workFilter: workName, articleImagePaths: imagePaths,
            });
            if (coverResult.coverPath) {
              const uploaded = await api.uploadImage(coverResult.coverPath);
              coverUrl = uploaded?.url || null;
            }
            html = await api.processContentImages(html);
            html = html.replace(/<img[^>]+src="(?!https?:\/\/)[^"]*"[^>]*>/gi, () => '');

            const albumInfo = buildAlbumInfo(workConfig);
            draftArticles.push({
              title: topic.topic, content: html, coverUrl,
              options: { albumInfo }, work: workName,
            });
          }

          // 更新结果记录
          failedItem.success = true;
          failedItem.title = topic.topic;
          failedItem.message = undefined;
          totalSuccess++;
          totalFail--;
          console.log(`  ✓ 补偿成功: ${topic.topic}`);
        } catch (e) {
          console.error(`  ✗ 补偿仍然失败: ${e.message}`);
        }
      }
    }

    // 保存草稿
    if (draftArticles.length > 0 && opts.push !== false) {
      if (wechatCombine) {
        // 合并为一个多图文草稿
        console.log(`\n${'─'.repeat(60)}`);
        console.log(`  保存多图文草稿（${draftArticles.length} 篇）...`);
        console.log('─'.repeat(60));

        const result = await api.saveMultiDraft(draftArticles);
        if (result.success) {
          console.log(`  ✓ 草稿已保存 (ID: ${result.article_id})`);
          for (const r of allResults) {
            if (r.success && !r.skipped) {
              r.article_id = result.article_id;
              r.draft_url = result.draft_url;
            }
          }
        } else {
          console.error(`  ✗ 草稿保存失败: ${result.message}`);
          for (const r of allResults) {
            if (r.success && !r.skipped) {
              r.success = false;
              r.message = `草稿合并保存失败: ${result.message}`;
              totalSuccess--;
              totalFail++;
            }
          }
        }
      } else {
        // 逐篇保存独立草稿
        console.log(`\n${'─'.repeat(60)}`);
        console.log(`  逐篇保存草稿（${draftArticles.length} 篇）...`);
        console.log('─'.repeat(60));

        for (let i = 0; i < draftArticles.length; i++) {
          const da = draftArticles[i];
          if (i > 0) {
            console.log(`  等待 ${opts.interval} 秒...`);
            await new Promise(r => setTimeout(r, interval));
          }
          const result = await api.saveDraft(da.title, da.content, da.coverUrl, da.options);
          const matchResult = allResults.find(r => r.title === da.title && r.success && !r.skipped);
          if (result.success) {
            console.log(`  ✓ ${da.title} (ID: ${result.article_id})`);
            if (matchResult) {
              matchResult.article_id = result.article_id;
              matchResult.draft_url = result.draft_url;
            }
          } else {
            console.error(`  ✗ ${da.title}: ${result.message}`);
            if (matchResult) {
              matchResult.success = false;
              matchResult.message = result.message;
              totalSuccess--;
              totalFail++;
            }
          }
        }
      }
    }

    // 汇总
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  ${rounds > 1 ? `第 ${round + 1} 轮` : ''}生成完成`);
    console.log('='.repeat(60));
    console.log(`  计划: ${totalArticles} 篇 | 成功: ${totalSuccess} 篇 | 失败: ${totalFail} 篇`);
    if (worksToGenerate.length > 1) {
      console.log('\n各作品统计:');
      for (const { name: workName } of worksToGenerate) {
        const workResults = allResults.filter(r => r.work === workName);
        const workSuccess = workResults.filter(r => r.success).length;
        console.log(`  ${workName}: ${workSuccess}/${workResults.length}`);
      }
    }
    if (allResults.length) {
      console.log('\n详情:');
      allResults.forEach((r, i) => {
        const icon = r.skipped ? '○' : r.success ? '✓' : '✗';
        console.log(`  ${icon} ${i + 1}. [${r.work}] ${r.title}`);
        if (r.draft_url) console.log(`      ${r.draft_url}`);
        if (!r.success && r.message) console.log(`      ${r.message}`);
      });
    }

    grandTotalSuccess += totalSuccess;
    grandTotalFail += totalFail;
    } // end rounds loop

    if (rounds > 1) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`  全部 ${rounds} 轮完成: 成功 ${grandTotalSuccess} 篇 | 失败 ${grandTotalFail} 篇`);
      console.log('='.repeat(60));
    }
  });

// ==================== 批量同步 ====================

program
  .command('batch')
  .description('从 Notion 批量同步文章到公众号草稿')
  .argument('[work]', '作品名称，不传则同步所有已配置 notionUrl 的作品')
  .option('--interval <seconds>', '每篇文章之间的间隔秒数', '15')
  .option('--no-auto-images', '不自动配图')
  .action(async (work, opts) => {
    const allConfigs = loadAllWorkConfigs();

    // 确定要同步的作品列表
    let worksToSync;
    if (work) {
      const config = allConfigs[work];
      if (!config) {
        console.error(`作品 "${work}" 未在 publish_config.json 的 wechat 中配置`);
        console.log(`可用作品: ${Object.keys(allConfigs).join('、')}`);
        return;
      }
      if (!config.notionUrl) {
        console.error(`作品 "${work}" 未配置 notionUrl`);
        return;
      }
      worksToSync = [{ name: work, config }];
    } else {
      worksToSync = Object.entries(allConfigs)
        .filter(([, c]) => c.notionUrl)
        .map(([name, config]) => ({ name, config }));
      if (!worksToSync.length) {
        console.error('publish_config.json 的 wechat 中没有配置 notionUrl 的作品');
        return;
      }
      console.log(`将同步 ${worksToSync.length} 部作品: ${worksToSync.map(w => w.name).join('、')}`);
    }

    // 检查登录（一次性）
    const api = new WechatAPI();
    const auth = await api.checkAuth();
    if (!auth.success) {
      console.error('公众号未登录，请先运行: wx login "<cookie>"');
      return;
    }

    // 逐个作品同步
    let totalSuccess = 0;
    let totalFail = 0;
    for (const { name: workName, config: workConfig } of worksToSync) {
      const { success, fail } = await syncOneWork(api, workName, workConfig, opts);
      totalSuccess += success;
      totalFail += fail;
    }

    // 多作品时输出总汇总
    if (worksToSync.length > 1) {
      console.log(`\n${'='.repeat(50)}`);
      console.log(`  全部完成: 成功 ${totalSuccess} 篇 | 失败 ${totalFail} 篇`);
      console.log('='.repeat(50));
    }
  });

// ==================== 热文排行 ====================

program
  .command('top')
  .description('查看公众号热文排行（按阅读量）')
  .option('-n, --count <n>', '显示数量', '10')
  .action(async (opts) => {
    const api = new WechatAPI();
    const auth = await api.checkAuth();
    if (!auth.success) {
      console.error('公众号未登录');
      return;
    }

    const topN = parseInt(opts.count);
    console.log(`\n拉取文章数据中...`);
    const { byRead } = await api.fetchTopArticles(topN);

    if (!byRead.length) {
      console.log('暂无数据');
      return;
    }
    console.log(`\n阅读量 TOP ${topN}:`);
    console.log('-'.repeat(70));
    byRead.forEach((a, i) => {
      console.log(`  ${String(i + 1).padStart(2)}. ${a.title}`);
      console.log(`      阅读: ${a.read_num}  点赞: ${a.like_num}  分享: ${a.share_num}  评论: ${a.comment_num}`);
    });
  });

// ==================== 列出草稿 ====================

program
  .command('list')
  .description('列出公众号草稿箱中的所有草稿')
  .action(async () => {
    const api = new WechatAPI();
    const auth = await api.checkAuth();
    if (!auth.success) {
      console.error('公众号未登录');
      return;
    }

    console.log('\n获取草稿列表...');
    const { list, total } = await api.listDrafts();
    console.log(`共 ${total} 篇草稿:\n`);
    list.forEach((d, i) => {
      const date = d.update_time ? new Date(d.update_time * 1000).toLocaleString('zh-CN') : '';
      console.log(`  ${i + 1}. [${d.app_id}] ${d.title}  ${date}`);
    });
  });

// ==================== 清空草稿 ====================

program
  .command('clean')
  .description('删除草稿箱中所有草稿（仅清除已成功删除的同步记录）')
  .action(async () => {
    const api = new WechatAPI();
    const auth = await api.checkAuth();
    if (!auth.success) {
      console.error('公众号未登录');
      return;
    }

    console.log('\n获取草稿列表...');
    const { list } = await api.listDrafts();
    if (!list.length) {
      console.log('草稿箱为空');
      return;
    }

    console.log(`共 ${list.length} 篇草稿，开始删除...\n`);
    const syncState = loadSyncState();
    const deletedIds = new Set();
    let deleted = 0;

    for (const draft of list) {
      try {
        const result = await api.deleteDraft(draft.app_id);
        if (result.success) {
          deleted++;
          deletedIds.add(draft.app_id);
          console.log(`  ✓ 已删除: ${draft.title} (${draft.app_id})`);
        } else {
          console.log(`  ⚠ 删除失败: ${draft.title} - ${result.message}`);
        }
      } catch (e) {
        console.log(`  ⚠ 删除异常: ${draft.title} - ${e.message}`);
      }
    }

    // 仅清除已成功删除的草稿对应的同步记录
    let cleared = 0;
    for (const [pageId, info] of Object.entries(syncState)) {
      if (deletedIds.has(info.article_id)) {
        delete syncState[pageId];
        cleared++;
      }
    }
    saveSyncState(syncState);

    console.log(`\n删除完成: ${deleted}/${list.length} | 清除同步记录: ${cleared} 条 | 保留同步记录: ${Object.keys(syncState).length} 条`);
  });

program.parse();
