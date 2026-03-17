#!/usr/bin/env node
/**
 * 百家号内容工具 CLI
 */

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');

const { generateTopics, listWorks } = require('./topic-generator');
const { generateOutline, formatOutline } = require('./outline-generator');
const { generateArticle, insertImages, detectWorksFromTitle } = require('./article-generator');
const { listArticles, updateMeta, createArticle, importArticle } = require('./content-manager');
const { pushWithImages, mdToHtml, extractImagePaths, DEFAULT_IMAGE_DIR, DEFAULT_TAIL_IMAGE } = require('./batch-publish');
const { BaijiahaoAPI, saveCookie } = require('./baijiahao-api');
const { ToutiaoAPI } = require('./toutiao-api');
const { WechatAPI } = require('./wechat-api');
const { fetchNotionPage } = require('./notion-fetcher');
const { scanImages, selectCoverImage } = require('./image-library');
const { callLLM } = require('./llm');

// ==================== 缺失图片日志 ====================

/** 平台中文名 */
function platformLabel(p) {
  return { toutiao: '头条', wechat: '公众号', baijiahao: '百家号' }[p] || p;
}

/** 解析 --platform 选项为平台数组 */
function parsePlatforms(opt) {
  return opt === 'all' ? ['baijiahao', 'toutiao', 'wechat'] : [opt];
}

/** 创建平台 API 实例 */
function createPlatformAPI(p) {
  if (p === 'toutiao') return new ToutiaoAPI();
  if (p === 'wechat') return new WechatAPI();
  return new BaijiahaoAPI();
}

const MISSING_IMAGES_LOG_DIR = path.join(__dirname, '..', 'logs', 'missing-images');

/**
 * 记录缺失图片到对应作品的日志文件
 * 每个作品一个文件，方便定期审查补充图片
 */
function logMissingImages(work, topic, missingNames) {
  if (!missingNames.length) return;
  if (!fs.existsSync(MISSING_IMAGES_LOG_DIR)) {
    fs.mkdirSync(MISSING_IMAGES_LOG_DIR, { recursive: true });
  }
  const logFile = path.join(MISSING_IMAGES_LOG_DIR, `${work}.log`);
  const time = new Date().toLocaleString('zh-CN', { hour12: false });
  const lines = [
    `[${time}] ${topic}`,
    ...missingNames.map(name => `  - ${name}`),
    '',
  ];
  fs.appendFileSync(logFile, lines.join('\n'), 'utf-8');
}

const program = new Command();
program.name('bjh').description('百家号/头条号内容生产 + 自动发布工具').version('1.0.0');

// ==================== 登录 ====================

program
  .command('login')
  .description('设置 Cookie（从浏览器复制）')
  .argument('<cookie>', 'Cookie 字符串')
  .option('-p, --platform <name>', '平台: baijiahao / toutiao / wechat', 'baijiahao')
  .action((cookie, opts) => {
    const envPath = path.join(__dirname, '..', '.env.local');
    if (opts.platform === 'toutiao' || opts.platform === 'wechat') {
      const envKey = opts.platform === 'toutiao' ? 'TOUTIAO_COOKIE' : 'WECHAT_COOKIE';
      const platName = opts.platform === 'toutiao' ? '头条' : '公众号';
      const raw = fs.readFileSync(envPath, 'utf-8');
      const lines = raw.split('\n');
      let replaced = false;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().startsWith(`${envKey}=`)) {
          lines[i] = `${envKey}=${cookie.trim()}`;
          replaced = true;
          break;
        }
      }
      if (!replaced) lines.push(`${envKey}=${cookie.trim()}`);
      fs.writeFileSync(envPath, lines.join('\n'), 'utf-8');
      console.log(`${platName} Cookie 已更新到 .env.local`);
    } else {
      saveCookie(cookie);
    }
  });

program
  .command('check')
  .description('检查登录状态')
  .option('-p, --platform <name>', '平台: baijiahao / toutiao / wechat / all', 'all')
  .action(async (opts) => {
    if (opts.platform === 'all' || opts.platform === 'baijiahao') {
      const bjh = new BaijiahaoAPI();
      await bjh.checkAuth();
    }
    if (opts.platform === 'all' || opts.platform === 'toutiao') {
      const tt = new ToutiaoAPI();
      await tt.checkAuth();
    }
    if (opts.platform === 'all' || opts.platform === 'wechat') {
      const wx = new WechatAPI();
      await wx.checkAuth();
    }
  });

// ==================== 热文排行 ====================

program
  .command('top')
  .description('查看百家号热文排行（按阅读量 + 点击率分析）')
  .option('-n, --count <n>', '显示数量', '10')
  .action(async (opts) => {
    const api = new BaijiahaoAPI();
    const auth = await api.checkAuth();
    if (!auth.success) {
      console.error('未登录，请先设置 Cookie');
      return;
    }

    const topN = parseInt(opts.count);
    console.log(`\n拉取全部文章数据中...`);
    const { byClickRate, byRecLowClickRate } = await api.fetchTopArticles(topN);

    const printList = (list, label) => {
      if (!list.length) { console.log(`\n${label}: 暂无数据`); return; }
      console.log(`\n${label}:`);
      console.log('-'.repeat(70));
      list.forEach((a, i) => {
        console.log(`  ${String(i + 1).padStart(2)}. ${a.title}`);
        console.log(`      阅读: ${a.read_amount}  推荐: ${a.rec_amount}  点击率: ${a.click_rate}`);
      });
    };

    printList(byClickRate, '点击率 TOP（标题吸引力最强）');
    printList(byRecLowClickRate, '高推荐低点击率（内容好但标题/封面需优化）');
  });

// ==================== 选题 ====================

program
  .command('topics')
  .description('生成选题')
  .option('-c, --count <n>', '生成数量', '10')
  .option('-w, --work <name>', '限定作品')
  .action(async (opts) => {
    const topics = await generateTopics(parseInt(opts.count), opts.work || null);
    if (!topics.length) {
      console.log('未生成任何选题');
      return;
    }
    topics.forEach((t, i) => {
      console.log(`${i + 1}. [${t.category}] ${t.topic}`);
      console.log(`   作品: ${t.work} | 主角: ${t.main_character} | 角色: ${t.characters.join(', ')}`);
    });
    console.log(`\n共生成 ${topics.length} 个选题`);
  });

program
  .command('works')
  .description('列出所有作品')
  .action(() => {
    listWorks().forEach(w => console.log(`  ${w}`));
  });

// ==================== 大纲 ====================

program
  .command('outline')
  .description('生成文章大纲')
  .argument('<topic>', '选题标题')
  .option('-t, --type <type>', '指定类型')
  .option('--category <cat>', '指定类别（疑问解读类/细节深挖类/反差揭秘类/数字盘点类/假设对比类）')
  .action(async (topic, opts) => {
    const outline = await generateOutline(topic, opts.type || null, opts.category || null);
    console.log(formatOutline(outline));
  });

// ==================== 文章管理 ====================

program
  .command('list')
  .description('列出文章')
  .option('-s, --status <status>', '按状态筛选（draft/ready/published）')
  .action((opts) => {
    const articles = listArticles(opts.status || null);
    if (!articles.length) {
      console.log('没有文章');
      return;
    }
    articles.forEach(a => {
      const status = a.meta.status || 'unknown';
      console.log(`  [${status}] ${a.meta.title}`);
      console.log(`         ${path.basename(a.filePath)}`);
    });
    console.log(`\n共 ${articles.length} 篇`);
  });

program
  .command('set-status')
  .description('修改文章状态')
  .argument('<file>', '文章文件名（articles/ 目录下）')
  .argument('<status>', '新状态')
  .action((file, status) => {
    const articlesDir = path.resolve(__dirname, '..', 'archive', 'baijiahao');
    const filePath = path.join(articlesDir, file);
    if (!fs.existsSync(filePath)) {
      console.error(`文件不存在: ${filePath}`);
      return;
    }
    updateMeta(filePath, { status });
    console.log(`已更新: ${file} → ${status}`);
  });

program
  .command('import')
  .description('导入文章（Markdown 文件）')
  .argument('<file>', '要导入的 Markdown 文件路径')
  .action((file) => {
    const srcPath = path.resolve(file);
    if (!fs.existsSync(srcPath)) {
      console.error(`文件不存在: ${srcPath}`);
      return;
    }
    importArticle(srcPath);
  });

// ==================== 发布 ====================

program
  .command('push')
  .description('推送文章到草稿箱（自动配图 + 尾图）')
  .argument('<article>', '文章文件路径（txt/md）')
  .option('-i, --images <dir>', '图片目录路径', DEFAULT_IMAGE_DIR)
  .option('-c, --cover <file>', '指定封面图片')
  .option('-t, --tail <file>', '尾图路径', DEFAULT_TAIL_IMAGE)
  .option('-n, --min-images <n>', '最少配图数量', '7')
  .option('-p, --platform <name>', '平台: baijiahao / toutiao / wechat', 'baijiahao')
  .option('--no-cover', '不使用封面')
  .action(async (article, opts) => {
    const articlePath = path.resolve(article);
    const imageDir = path.resolve(opts.images);
    if (!fs.existsSync(articlePath)) {
      console.error(`文章不存在: ${articlePath}`);
      return;
    }
    if (!fs.existsSync(imageDir)) {
      console.error(`图片目录不存在: ${imageDir}`);
      return;
    }
    await pushWithImages(articlePath, imageDir, {
      cover: opts.cover ? path.resolve(opts.cover) : null,
      noCover: opts.cover === false,
      tail: opts.tail,
      minImages: parseInt(opts.minImages),
      platform: opts.platform,
    });
  });

// ==================== 发布配置加载 ====================

const PUBLISH_CONFIG_PATH = path.join(__dirname, '..', 'publish_config.json');

/**
 * 加载发布配置，从 publish_config.json 读取
 */
function loadPublishConfig() {
  if (!fs.existsSync(PUBLISH_CONFIG_PATH)) {
    console.error('未找到 publish_config.json，请先创建配置文件（参考 publish_config.json.example）');
    return null;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(PUBLISH_CONFIG_PATH, 'utf-8'));
    console.log('  配置来源: publish_config.json');
    return {
      works: raw.works || {},
      platforms: raw.platforms || ['baijiahao', 'toutiao', 'wechat'],
      publish: raw.publish ?? false,
      interval: raw.interval ?? 30,
    };
  } catch (e) {
    console.error(`publish_config.json 解析失败: ${e.message}`);
    return null;
  }
}

// ==================== 批量多作品 ====================

program
  .command('batch')
  .description('按 publish_config.json 批量生成并发布')
  .option('-i, --images <dir>', '图片素材目录', DEFAULT_IMAGE_DIR)
  .option('-t, --tail <file>', '尾图路径', DEFAULT_TAIL_IMAGE)
  .option('--interval <seconds>', '每篇推送间隔秒数（覆盖配置文件）')
  .option('--publish', '自动发布（覆盖配置文件）')
  .option('--no-publish', '仅保存草稿（覆盖配置文件）')
  .option('--no-push', '仅生成文章，不推送')
  .option('-p, --platform <name>', '平台: baijiahao / toutiao / wechat / all（覆盖配置文件）')
  .action(async (opts) => {
    const publishConfig = loadPublishConfig();
    if (!publishConfig) return;

    // CLI 参数覆盖配置文件
    const shouldPublish = opts.publish !== undefined ? opts.publish : publishConfig.publish;
    const intervalSec = opts.interval ? parseInt(opts.interval) : publishConfig.interval;
    const platforms = opts.platform ? parsePlatforms(opts.platform) : publishConfig.platforms;

    const entries = Object.entries(publishConfig.works).filter(([, n]) => n > 0);
    if (!entries.length) {
      console.log('配置中没有需要生成的作品（所有数量为0）');
      return;
    }

    const totalArticles = entries.reduce((sum, [, n]) => sum + n, 0);
    const interval = intervalSec * 1000;
    const imageDir = path.resolve(opts.images);
    const platformNames = platforms.map(platformLabel).join(' + ');

    console.log('='.repeat(60));
    console.log('  批量生成');
    console.log('='.repeat(60));
    entries.forEach(([work, n]) => console.log(`  ${work}: ${n} 篇`));
    console.log(`  合计: ${totalArticles} 篇`);
    console.log(`  平台: ${platformNames}`);
    console.log(`  发布: ${shouldPublish ? '自动发布' : '仅保存草稿'}`);
    console.log(`  间隔: ${intervalSec} 秒`);
    console.log(`  素材目录: ${imageDir}`);
    console.log('='.repeat(60));

    // 检查平台登录
    if (opts.push !== false) {
      for (const p of platforms) {
        const api = createPlatformAPI(p);
        const auth = await api.checkAuth();
        if (!auth.success) {
          console.error(`\n${platformLabel(p)}登录状态无效，请先更新 Cookie`);
          return;
        }
      }
    }

    // 热文分析（仅百家号平台）
    let topArticlesHint = null;
    if (platforms.includes('baijiahao')) {
      try {
        console.log('\n  分析热文数据...');
        const bjhApi = new BaijiahaoAPI();
        const { byClickRate, byRecLowClickRate } = await bjhApi.fetchTopArticles(10);

        // 判断是否有有效数据
        const hasData = byClickRate.length > 0;
        if (hasData) {
          const formatLine = (a, i) => `${i + 1}. 「${a.title}」 阅读:${a.read_amount} 推荐:${a.rec_amount} 点击率:${a.click_rate}`;

          let analysisInput = '';
          if (byClickRate.length) {
            analysisInput += '【点击率最高的文章（标题吸引力强）】\n' + byClickRate.map(formatLine).join('\n') + '\n\n';
          }
          if (byRecLowClickRate.length) {
            analysisInput += '【高推荐低点击率（平台认可内容但标题/封面不够吸引人）】\n' + byRecLowClickRate.map(formatLine).join('\n') + '\n\n';
          }

          console.log(`  已获取热文数据`);
          byClickRate.slice(0, 3).forEach((a, i) => {
            console.log(`    ${i + 1}. ${a.title} (阅读${a.read_amount} 推荐${a.rec_amount} 点击率${a.click_rate})`);
          });

          topArticlesHint = await callLLM(
            `分析以下百家号已发布文章的数据，重点关注阅读量和推荐量的关系：

${analysisInput}
说明：
- 推荐量高+阅读量高+点击率高 = 标题吸引人，内容也好，是最佳范本
- 推荐量高+阅读量低+点击率低 = 平台认可内容质量给了推荐，但标题或封面不够吸引人，用户不愿点击
- 点击率 = 阅读量/推荐量，越高说明标题越能吸引点击

请从以下维度分析（简洁，每点1-2句话）：
1. 高点击率文章的标题共性（句式、用词、悬念感）
2. 低点击率文章的标题问题在哪（对比高点击率找差距）
3. 哪些选题方向/作品/角色更受欢迎
4. 对后续选题和写作的3条具体建议（重点是如何提高点击率）

直接输出分析，不要超过400字。`,
            { maxTokens: 600 }
          );
          if (topArticlesHint) {
            console.log('  热文分析完成');
          }
        } else {
          console.log('  文章数据暂无（推荐/阅读均为0），跳过热文分析');
        }
      } catch (e) {
        console.error(`  热文分析失败（不影响生成）: ${e.message}`);
      }
    }

    let globalIdx = 0;
    let successCount = 0;
    const allResults = [];
    let lastPublishTime = 0;

    for (const [work, count] of entries) {
      console.log(`\n${'#'.repeat(60)}`);
      console.log(`  ${work} — 计划 ${count} 篇`);
      console.log('#'.repeat(60));

      // 为该作品生成选题（不足时重试一次补齐）
      let topics = await generateTopics(count, work, 'baijiahao', topArticlesHint);
      if (topics.length < count && topics.length > 0) {
        console.log(`  选题不足 ${topics.length}/${count}，补充生成中...`);
        const extra = await generateTopics(count - topics.length, work, 'baijiahao', topArticlesHint);
        topics = topics.concat(extra);
      }
      if (!topics.length) {
        console.error(`  ${work}: 选题生成失败`);
        continue;
      }
      console.log(`  生成了 ${topics.length} 个选题`);
      topics.forEach((t, i) => console.log(`    ${i + 1}. [${t.category}] ${t.topic}`));

      for (let i = 0; i < topics.length; i++) {
        globalIdx++;
        const t = topics[i];
        console.log(`\n${'='.repeat(60)}`);
        console.log(`  [${globalIdx}/${totalArticles}] ${work} — ${t.topic}`);
        console.log('='.repeat(60));

        // 生成文章（直接从选题生成，跳过大纲）
        let filePath;
        try {
          console.log('  AI 写作中...');
          const { article: content, imageStats } = await generateArticle(
            t.topic,
            null,
            t.work,
            t.characters,
            imageDir,
            t.category,
            t.related_works,
            { wordCount: '1500-2000', maxTokens: 4000, topArticlesHint }
          );
          const wordCount = content.replace(/\s/g, '').replace(/[#*\-\[\]()]/g, '').length;
          console.log(`  生成完成: ${wordCount} 字`);

          if (imageStats.matched.length) {
            console.log(`  配图: ${imageStats.matched.length} 张匹配`);
          }
          if (imageStats.missing.length) {
            console.log(`  缺失: ${imageStats.missing.join('、')}`);
            logMissingImages(t.work, t.topic, imageStats.missing);
          }

          filePath = createArticle(t.topic, content, {
            type: t.type,
            category: t.category,
            work: t.work,
            main_character: t.main_character,
            characters: t.characters,
            status: 'ready',
            tags: [t.work, t.category, ...t.characters].filter(Boolean),
            matched_images: imageStats.matched.map(m => m.file),
            missing_images: imageStats.missing,
          });
        } catch (e) {
          console.error(`  生成失败: ${e.message}`);
          allResults.push({ work, title: t.topic, success: false });
          continue;
        }

        if (opts.push === false) {
          console.log('  跳过推送（--no-push）');
          allResults.push({ work, title: path.basename(filePath), success: true, skipped: true });
          continue;
        }

        // 间隔等待
        if (lastPublishTime > 0) {
          const elapsed = Date.now() - lastPublishTime;
          if (elapsed < interval) {
            const wait = interval - elapsed;
            console.log(`\n  等待 ${Math.ceil(wait / 1000)} 秒后发布...`);
            await new Promise(r => setTimeout(r, wait));
          }
        }
        lastPublishTime = Date.now();

        // 推送到各平台
        let anySuccess = false;
        const urls = [];
        for (const p of platforms) {
          const pName = platformLabel(p);
          console.log(`  >>> 推送到${pName}...`);
          try {
            const result = await pushWithImages(filePath, imageDir, {
              tail: opts.tail,
              minImages: 7,
              publish: (p === 'baijiahao' || p === 'wechat') ? shouldPublish : false,
              platform: p,
              _skipAuth: true,
            });
            if (result && result.success) {
              anySuccess = true;
              urls.push(`${pName}: ${result.publish_url || result.draft_url}`);
            }
          } catch (e) {
            console.error(`  ${pName}推送失败: ${e.message}`);
          }
        }

        if (anySuccess) {
          successCount++;
          updateMeta(filePath, {
            status: shouldPublish ? 'published' : 'draft_saved',
            published_at: new Date().toISOString(),
          });
        }
        allResults.push({ work, title: path.basename(filePath), success: anySuccess, urls: urls.join(' | ') });
      }
    }

    // 汇总
    console.log('\n' + '='.repeat(60));
    console.log('  批量完成');
    console.log('='.repeat(60));
    console.log(`  计划: ${totalArticles} 篇 | 成功: ${successCount} 篇`);
    console.log('\n各作品统计:');
    for (const [work] of entries) {
      const workResults = allResults.filter(r => r.work === work);
      const workSuccess = workResults.filter(r => r.success).length;
      console.log(`  ${work}: ${workSuccess}/${workResults.length}`);
    }
    if (allResults.length) {
      console.log('\n详情:');
      allResults.forEach((r, i) => {
        const icon = r.skipped ? '○' : r.success ? '✓' : '✗';
        const status = r.skipped ? '未推送' : r.success ? '成功' : '失败';
        console.log(`  ${icon} ${i + 1}. [${r.work}] ${r.title} [${status}]${r.urls ? ' → ' + r.urls : ''}`);
      });
    }
  });

// ==================== 补充图片后重新推送 ====================

program
  .command('push-ready')
  .description('推送所有 ready 状态的文章')
  .option('-i, --images <dir>', '图片素材目录', DEFAULT_IMAGE_DIR)
  .option('-t, --tail <file>', '尾图路径', DEFAULT_TAIL_IMAGE)
  .option('--interval <seconds>', '每篇推送间隔秒数', '30')
  .option('--publish', '自动发布（不仅保存草稿）')
  .option('-p, --platform <name>', '平台: baijiahao / toutiao / wechat / all', 'all')
  .action(async (opts) => {
    const imageDir = path.resolve(opts.images);
    const interval = parseInt(opts.interval) * 1000;
    const platforms = parsePlatforms(opts.platform);
    const platformNames = platforms.map(platformLabel).join(' + ');

    // 检查所有平台登录状态
    for (const p of platforms) {
      const api = createPlatformAPI(p);
      const auth = await api.checkAuth();
      if (!auth.success) {
        console.error(`${platformLabel(p)}登录状态无效，请先更新 Cookie`);
        return;
      }
    }

    const articles = listArticles('ready');
    if (!articles.length) {
      console.log('没有 ready 状态的文章');
      return;
    }

    console.log(`找到 ${articles.length} 篇待推送文章（${platformNames}）\n`);
    let successCount = 0;

    for (let i = 0; i < articles.length; i++) {
      if (i > 0) {
        console.log(`\n等待 ${opts.interval} 秒...`);
        await new Promise(r => setTimeout(r, interval));
      }

      console.log(`--- 推送 ${i + 1}/${articles.length} ---`);

      let anySuccess = false;
      for (const p of platforms) {
        const pName = platformLabel(p);
        console.log(`>>> 推送到${pName}...`);
        try {
          const result = await pushWithImages(articles[i].filePath, imageDir, {
            tail: opts.tail,
            minImages: 7,
            publish: (p === 'baijiahao' || p === 'wechat') ? !!opts.publish : false,
            platform: p,
            _skipAuth: true,
          });

          if (result && result.success) {
            anySuccess = true;
          }
        } catch (e) {
          console.error(`${pName}推送失败: ${e.message}`);
        }
      }

      if (anySuccess) {
        successCount++;
        updateMeta(articles[i].filePath, {
          status: 'published',
          published_at: new Date().toISOString(),
        });
      }
    }

    console.log(`\n推送完成: ${successCount}/${articles.length} 篇成功`);
  });

// ==================== 微信公众号（独立流程：Notion → 配图 → 发布） ====================

program
  .command('wechat')
  .description('从 Notion 获取文章 → 自动配图 → 发布到微信公众号')
  .argument('<notion_url>', 'Notion 公开分享链接')
  .option('-i, --images <dir>', '图片素材目录', DEFAULT_IMAGE_DIR)
  .option('-w, --work <name>', '限定匹配作品（如"三国演义"）')
  .option('--works <names>', '多个作品，逗号分隔（如"三国演义,水浒传"，用于跨作品文章）')
  .option('-c, --cover <file>', '指定封面图片')
  .option('-t, --tail <file>', '尾图路径', DEFAULT_TAIL_IMAGE)
  .option('--publish', '自动发布（不仅保存草稿）')
  .option('--no-images', '不自动配图')
  .action(async (notionUrl, opts) => {
    const imageDir = path.resolve(opts.images);

    // 1. 检查公众号登录
    const api = new WechatAPI();
    const auth = await api.checkAuth();
    if (!auth.success) {
      console.error('公众号登录状态无效，请先运行: bjh login "<cookie>" -p wechat');
      return;
    }

    // 2. 获取 Notion 内容
    console.log('\n获取 Notion 页面内容...');
    let page;
    try {
      page = await fetchNotionPage(notionUrl);
    } catch (e) {
      console.error(`获取 Notion 内容失败: ${e.message}`);
      return;
    }

    const { title, markdown } = page;
    const wordCount = markdown.replace(/\s/g, '').length;
    console.log(`\n文章: ${title}`);
    console.log(`字数: ${wordCount}`);

    // 3. AI 自动配图（和百家号同样流程，让 AI 决定插图位置和角色）
    let finalMarkdown = markdown;
    if (opts.images !== false) {
      console.log('\nAI 配图中...');
      // 支持多作品：优先使用 --works，其次自动识别，最后使用 --work
      let relatedWorks = null;
      if (opts.works) {
        relatedWorks = opts.works.split(',').map(w => w.trim());
        console.log(`  指定作品: ${relatedWorks.join('、')}`);
      } else {
        // 自动识别标题中涉及的作品
        relatedWorks = await detectWorksFromTitle(title);
        if (relatedWorks && relatedWorks.length > 0) {
          console.log(`  识别作品: ${relatedWorks.join('、')}`);
        } else if (opts.work) {
          relatedWorks = [opts.work];
          console.log(`  使用作品: ${opts.work}`);
        }
      }
      const { article, imageStats } = await insertImages(markdown, imageDir, opts.work || null, relatedWorks);
      finalMarkdown = article;
      if (imageStats.matched.length) {
        console.log(`  配图: ${imageStats.matched.length} 张匹配`);
      }
      if (imageStats.missing.length) {
        console.log(`  缺失: ${imageStats.missing.join('、')}`);
      }
    }

    // 4. 追加尾图
    const tailImage = opts.tail || DEFAULT_TAIL_IMAGE;
    if (tailImage && fs.existsSync(tailImage)) {
      finalMarkdown += `\n\n![尾图](${tailImage})\n`;
      console.log('已追加尾图');
    }

    // 5. 转 HTML
    let html = mdToHtml(finalMarkdown, 'wechat');

    // 6. 封面：标题角色图 > 文中最佳比例图
    const imagePaths = extractImagePaths(finalMarkdown);
    let coverUrl = null;
    let coverPath = null;
    if (opts.cover && fs.existsSync(opts.cover)) {
      coverPath = path.resolve(opts.cover);
      console.log(`封面: ${path.basename(coverPath)}`);
    } else {
      const coverResult = selectCoverImage({
        title,
        imageDir,
        workFilter: opts.work || undefined,
        articleImagePaths: imagePaths,
      });

      if (coverResult.coverPath) {
        coverPath = coverResult.coverPath;
        // 如果封面图来自图库且文中未使用，插入到文中
        if (coverResult.fromLibrary) {
          const alreadyInArticle = imagePaths.some(p => path.resolve(p) === path.resolve(coverPath));
          if (!alreadyInArticle) {
            const insertPos = finalMarkdown.indexOf('\n', finalMarkdown.indexOf('## '));
            if (insertPos !== -1) {
              finalMarkdown = finalMarkdown.slice(0, insertPos) + `\n\n![配图](${coverPath})\n` + finalMarkdown.slice(insertPos);
              console.log(`封面图未在文中出现，已插入到正文`);
              html = mdToHtml(finalMarkdown, 'wechat');
            }
          }
          console.log(`封面（标题角色）: ${path.basename(coverPath)}`);
        } else {
          console.log(`封面（文中配图）: ${path.basename(coverPath)}`);
        }
      }
    }
    if (coverPath) {
      const uploaded = await api.uploadImage(coverPath);
      coverUrl = uploaded?.url || null;
    }

    // 7. 上传正文图片
    console.log('\n上传图片到公众号...');
    html = await api.processContentImages(html);
    // 清理未上传成功的本地图片
    html = html.replace(/<img[^>]+src="(?!https?:\/\/)[^"]*"[^>]*>/gi, (match) => {
      console.log(`  ⚠ 移除未解析图片: ${match.slice(0, 80)}...`);
      return '';
    });

    // 8. 保存草稿
    console.log('\n保存草稿...');
    const result = await api.saveDraft(title, html, coverUrl);
    if (!result.success) {
      console.error(`✗ 草稿保存失败: ${result.message}`);
      return;
    }
    console.log(`✓ 草稿已保存 (ID: ${result.article_id})`);
    console.log(`  草稿链接: ${result.draft_url}`);

    // 9. 自动发布
    if (opts.publish) {
      console.log('\n发布中...');
      const pubResult = await api.publishArticle(result.article_id);
      if (pubResult.success) {
        console.log('✓ 已发布');
      } else {
        console.log(`✗ 发布失败: ${pubResult.message}`);
        console.log(`  请手动到草稿箱发布: ${result.draft_url}`);
      }
    }
  });

program.parse();
