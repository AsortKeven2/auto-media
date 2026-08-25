#!/usr/bin/env node
/**
 * 百家号内容工具 CLI
 */

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');

const { generateTopics, listWorks, buildWeightedCategoryPlan } = require('../core/topic-generator');
const { generateOutline, formatOutline } = require('../core/outline-generator');
const { generateArticle, insertImages, detectWorksFromTitle } = require('../core/article-generator');
const { listArticles, updateMeta, createArticle, importArticle } = require('../core/content-manager');
const { pushWithImages, mdToHtml, extractImagePaths, excludeTailImagePaths, DEFAULT_IMAGE_DIR, DEFAULT_TAIL_IMAGE } = require('../core/batch-publish');
const { BaijiahaoAPI } = require('../core/baijiahao-api');
const { ToutiaoAPI } = require('../core/toutiao-api');
const { WechatAPI } = require('../core/wechat-api');
const { fetchNotionPage } = require('../core/notion-fetcher');
const { selectCoverImage } = require('../core/image-library');
const { CATEGORIES } = require('../core/categories');
const { loadPlatformAccounts, filterAccounts, getAccountCookie } = require('../core/account-config');
const { loadConfig, saveConfig } = require('../core/config');
const {
  PUBLISH_RECORD_DIR,
  loadOrCreateDailyRecord,
  getDailyBatchPlan,
  buildDailyBatchEntries,
  decrementDailyRecord,
  ensureDailyCategoryQuota,
  peekDailyCategoryPlan,
  consumeDailyCategoryPlan,
} = require('../core/daily-publish-record');

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
function createPlatformAPI(p, cookieStr) {
  if (p === 'toutiao') return new ToutiaoAPI(cookieStr);
  if (p === 'wechat') return new WechatAPI(cookieStr);
  return new BaijiahaoAPI(cookieStr);
}

const MISSING_IMAGES_LOG_DIR = path.join(__dirname, '../..', 'logs', 'missing-images');

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

function summarizeCategoryPlan(plan) {
  const counts = new Map();
  for (const category of plan || []) {
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => `${name} ${count}篇`)
    .join('、');
}

function buildBaijiahaoCategoryPlan(totalCount) {
  return buildWeightedCategoryPlan(totalCount, null, 'baijiahao');
}

const program = new Command();
program.name('bjh').description('百家号/头条号内容生产 + 自动发布工具').version('1.0.0');

// ==================== 登录 ====================

program
  .command('login')
  .description('设置 Cookie（从浏览器复制）')
  .argument('<cookie>', 'Cookie 字符串')
  .option('-p, --platform <name>', '平台: baijiahao / toutiao / wechat', 'baijiahao')
  .option('-a, --account <name>', '指定账号名称（多账号模式）')
  .action((cookie, opts) => {
    const cfg = loadConfig();

    if (opts.platform === 'toutiao') {
      if (!cfg.toutiao) cfg.toutiao = {};
      cfg.toutiao.cookie = cookie.trim();
      saveConfig(cfg);
      console.log('头条号 Cookie 已更新到 config.json');
      return;
    }

    // 百家号/微信：多账号模式
    const platform = opts.platform;
    if (!cfg[platform]) cfg[platform] = {};
    const accounts = cfg[platform].accounts || [];

    if (opts.account) {
      const matched = accounts.find(a => a.name === opts.account);
      if (!matched) {
        console.error(`未找到账号 "${opts.account}"，可用账号: ${accounts.map(a => a.name).join('、')}`);
        return;
      }
      matched.cookie = cookie.trim();
    } else if (accounts.length === 1) {
      accounts[0].cookie = cookie.trim();
    } else if (accounts.length > 1) {
      console.error(`有多个账号，请用 --account 指定: ${accounts.map(a => a.name).join('、')}`);
      return;
    } else {
      // 无 accounts，直接写到平台级 cookie
      cfg[platform].cookie = cookie.trim();
    }

    saveConfig(cfg);
    console.log(`${platformLabel(platform)} Cookie 已更新到 config.json`);
  });

program
  .command('check')
  .description('检查登录状态')
  .option('-p, --platform <name>', '平台: baijiahao / toutiao / wechat / all', 'all')
  .option('-a, --account <name>', '指定账号名称（多账号模式）')
  .action(async (opts) => {
    if (opts.platform === 'all' || opts.platform === 'baijiahao') {
      const accounts = filterAccounts(loadPlatformAccounts('baijiahao'), opts.account);
      if (accounts.length) {
        for (const account of accounts) {
          const prefix = account.name !== 'default' ? `[${account.name}] ` : '';
          const cookie = getAccountCookie(account);
          const bjh = new BaijiahaoAPI(cookie);
          console.log(`${prefix}百家号:`);
          await bjh.checkAuth();
        }
      } else if (!opts.account) {
        const bjh = new BaijiahaoAPI();
        await bjh.checkAuth();
      }
    }
    if (opts.platform === 'all' || opts.platform === 'toutiao') {
      const tt = new ToutiaoAPI();
      await tt.checkAuth();
    }
    if (opts.platform === 'all' || opts.platform === 'wechat') {
      const accounts = filterAccounts(loadPlatformAccounts('wechat'), opts.account);
      if (accounts.length) {
        for (const account of accounts) {
          const prefix = account.name !== 'default' ? `[${account.name}] ` : '';
          const cookie = getAccountCookie(account);
          const wx = new WechatAPI(cookie);
          console.log(`${prefix}公众号:`);
          await wx.checkAuth();
        }
      } else if (!opts.account) {
        const wx = new WechatAPI();
        await wx.checkAuth();
      }
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
  .option('--category <cat>', `指定类别（${Object.keys(CATEGORIES).join('/')}）`)
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
    const articlesDir = path.resolve(__dirname, '../..', 'archive', 'baijiahao');
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

/**
 * 加载发布配置，从 config.json 读取
 */
function loadPublishConfig() {
  try {
    const raw = loadConfig();
    console.log('  配置来源: config.json');
    return {
      works: raw.works || {},
      platforms: raw.platforms || ['baijiahao', 'toutiao', 'wechat'],
      publish: raw.publish ?? false,
      interval: raw.interval ?? 30,
      baijiahao: raw.baijiahao || {},
    };
  } catch (e) {
    console.error(`config.json 加载失败: ${e.message}`);
    return null;
  }
}

// ==================== 批量多作品 ====================

program
  .command('batch')
  .description('按 config.json 批量生成并发布')
  .option('-i, --images <dir>', '图片素材目录', DEFAULT_IMAGE_DIR)
  .option('-t, --tail <file>', '尾图路径', DEFAULT_TAIL_IMAGE)
  .option('--interval <seconds>', '每篇推送间隔秒数（覆盖配置文件）')
  .option('--publish', '自动发布（覆盖配置文件）')
  .option('--no-publish', '仅保存草稿（覆盖配置文件）')
  .option('--no-push', '仅生成文章，不推送')
  .option('-p, --platform <name>', '平台: baijiahao / toutiao / wechat / all（覆盖配置文件）')
  .option('-a, --account <name>', '指定账号名称（多账号模式，仅百家号/微信）')
  .option('--daily-record', '百家号分时发布模式：按 publish_record 记录当天剩余量')
  .option('--rounds <n>', '分时发布模式下当天发布轮次（覆盖 config.json 的 baijiahao.daily_rounds）')
  .option('--record-dir <dir>', '分时发布记录目录', PUBLISH_RECORD_DIR)
  .action(async (opts) => {
    const publishConfig = loadPublishConfig();
    if (!publishConfig) return;

    // CLI 参数覆盖配置文件
    const shouldPublish = opts.publish !== undefined ? opts.publish : publishConfig.publish;
    const intervalSec = opts.interval ? parseInt(opts.interval) : publishConfig.interval;
    const platforms = opts.platform ? parsePlatforms(opts.platform) : publishConfig.platforms;

    let dailyRecordContext = null;
    if (opts.dailyRecord) {
      if (!(platforms.length === 1 && platforms[0] === 'baijiahao')) {
        console.error('百家号分时发布模式只支持 --platform baijiahao，不会改动微信/头条逻辑');
        return;
      }
      if (opts.push !== false && !shouldPublish) {
        console.error('百家号分时发布模式需要发布文章，请在 config.json 设置 publish=true 或运行时加 --publish');
        return;
      }

      const configuredRounds = publishConfig.baijiahao.daily_rounds;
      const roundsSource = opts.rounds !== undefined ? opts.rounds : configuredRounds;
      const rounds = Math.max(1, parseInt(roundsSource, 10) || 5);
      const { record, recordPath, created, deletedOldRecords } = loadOrCreateDailyRecord(publishConfig.works, {
        recordDir: opts.recordDir,
      });
      const categoryQuota = ensureDailyCategoryQuota(recordPath, record, buildBaijiahaoCategoryPlan);
      const plan = getDailyBatchPlan(record, rounds);
      dailyRecordContext = { record, recordPath, rounds, plan, categoryQuota };

      console.log(`  发布记录: ${recordPath}${created ? '（今日首次创建）' : ''}`);
      deletedOldRecords.forEach(file => console.log(`  已删除旧发布记录: ${file}`));
      console.log(`  今日剩余: ${record.remaining_total}/${record.total} 篇`);
      console.log(`  今日分类配额: ${categoryQuota.created ? '已创建' : '已读取'}，剩余 ${categoryQuota.remaining}/${categoryQuota.total} 篇`);
      console.log(`  今日配置: ${plan.roundsTotal} 轮，基础每轮 ${plan.baseBatchSize} 篇，本轮计划 ${plan.batchSize} 篇${plan.isFinalRound ? '（发送全部剩余）' : ''}`);
    }

    const entries = dailyRecordContext
      ? buildDailyBatchEntries(dailyRecordContext.record, dailyRecordContext.plan.batchSize)
      : Object.entries(publishConfig.works).filter(([, n]) => n > 0);
    if (!entries.length) {
      console.log(dailyRecordContext ? '今日发布记录已清零，无需继续发布' : '配置中没有需要生成的作品（所有数量为0）');
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
    if (dailyRecordContext) {
      console.log(`  分时发布: 每天 ${dailyRecordContext.rounds} 轮，基础每轮 ${dailyRecordContext.plan.baseBatchSize} 篇，优先选择剩余量最多的作品`);
      console.log(`  本轮分类配额: ${summarizeCategoryPlan(peekDailyCategoryPlan(dailyRecordContext.record, totalArticles))}`);
    }
    const batchCategoryQueue = dailyRecordContext ? null : buildBaijiahaoCategoryPlan(totalArticles);
    if (!dailyRecordContext) {
      console.log(`  全批分类配额: ${summarizeCategoryPlan(batchCategoryQueue)}`);
    }
    console.log('='.repeat(60));

    // 检查平台登录 + 收集各平台账号的 API 实例
    const platformAPIs = {}; // { platform: [{ api, account }] }
    if (opts.push !== false) {
      for (const p of platforms) {
        if (p === 'toutiao') {
          const api = createPlatformAPI(p);
          const auth = await api.checkAuth();
          if (!auth.success) {
            console.error(`\n${platformLabel(p)}登录状态无效，请先更新 Cookie`);
            return;
          }
          platformAPIs[p] = [{ api, account: null }];
        } else {
          // 百家号/微信：多账号
          const accounts = filterAccounts(loadPlatformAccounts(p), opts.account);
          if (!accounts.length) {
            console.error(`\n${platformLabel(p)}没有可用的账号配置`);
            return;
          }
          platformAPIs[p] = [];
          for (const account of accounts) {
            const prefix = account.name !== 'default' ? `[${account.name}] ` : '';
            const cookie = getAccountCookie(account);
            const api = createPlatformAPI(p, cookie);
            const auth = await api.checkAuth();
            if (!auth.success) {
              console.error(`\n${prefix}${platformLabel(p)}登录状态无效，请先更新 config.json 中该账号的 cookie`);
              return;
            }
            platformAPIs[p].push({ api, account });
          }
        }
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

      const categoryPlan = dailyRecordContext
        ? peekDailyCategoryPlan(dailyRecordContext.record, count)
        : batchCategoryQueue.slice(0, count);
      if (categoryPlan.length) {
        console.log(`  分类配额: ${summarizeCategoryPlan(categoryPlan)}`);
      }

      // 为该作品生成选题（不足时重试一次补齐）
      let topics = await generateTopics(count, work, 'baijiahao', null, null, categoryPlan);
      if (topics.length < count && topics.length > 0) {
        console.log(`  选题不足 ${topics.length}/${count}，补充生成中...`);
        const extraCategoryPlan = dailyRecordContext
          ? peekDailyCategoryPlan(dailyRecordContext.record, count).slice(topics.length)
          : categoryPlan.slice(topics.length);
        const extra = await generateTopics(count - topics.length, work, 'baijiahao', null, null, extraCategoryPlan);
        topics = topics.concat(extra);
      }
      if (!topics.length) {
        console.error(`  ${work}: 选题生成失败`);
        continue;
      }
      if (dailyRecordContext) {
        const remainingCategories = consumeDailyCategoryPlan(dailyRecordContext.recordPath, dailyRecordContext.record, topics.length);
        console.log(`  分类配额已扣减: ${topics.length} 篇，今日分类剩余 ${remainingCategories} 篇`);
      } else {
        batchCategoryQueue.splice(0, topics.length);
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
            { wordCount: '1500-2000', maxTokens: 4000 }
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

        // 推送到各平台（多账号：每个账号都推送）
        let anySuccess = false;
        const urls = [];
        for (const p of platforms) {
          const apiEntries = platformAPIs[p] || [];
          for (const { account: pAccount } of apiEntries) {
            const pName = platformLabel(p);
            const prefix = pAccount && pAccount.name !== 'default' ? `[${pAccount.name}] ` : '';
            console.log(`  >>> 推送到${prefix}${pName}...`);
            try {
              const cookie = pAccount ? getAccountCookie(pAccount) : undefined;
              const result = await pushWithImages(filePath, imageDir, {
                tail: opts.tail,
                minImages: 7,
                publish: (p === 'baijiahao' || p === 'wechat') ? shouldPublish : false,
                platform: p,
                cookieStr: cookie,
                _skipAuth: true,
              });
              const publishRequired = shouldPublish && (p === 'baijiahao' || p === 'wechat');
              const pushSucceeded = result && result.success && (!publishRequired || result.published === true);
              if (pushSucceeded) {
                anySuccess = true;
                urls.push(`${prefix}${pName}: ${result.publish_url || result.draft_url}`);
              } else if (result && result.success && publishRequired) {
                console.error(`  ${prefix}${pName}发布未成功，不计入本次成功`);
              }
            } catch (e) {
              console.error(`  ${prefix}${pName}推送失败: ${e.message}`);
            }
          }
        }

        if (anySuccess) {
          successCount++;
          updateMeta(filePath, {
            status: shouldPublish ? 'published' : 'draft_saved',
            published_at: new Date().toISOString(),
          });

          if (dailyRecordContext && shouldPublish && opts.push !== false) {
            const remain = decrementDailyRecord(
              dailyRecordContext.recordPath,
              dailyRecordContext.record,
              work
            );
            console.log(`  发布记录已更新: ${work} 剩余 ${remain} 篇，今日总剩余 ${dailyRecordContext.record.remaining_total} 篇`);
          }
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
  .option('-a, --account <name>', '指定账号名称（多账号模式）')
  .action(async (opts) => {
    const imageDir = path.resolve(opts.images);
    const interval = parseInt(opts.interval) * 1000;
    const platforms = parsePlatforms(opts.platform);
    const platformNames = platforms.map(platformLabel).join(' + ');

    // 检查所有平台登录状态 + 收集 API 实例
    const platformAPIs = {};
    for (const p of platforms) {
      if (p === 'toutiao') {
        const api = createPlatformAPI(p);
        const auth = await api.checkAuth();
        if (!auth.success) {
          console.error(`${platformLabel(p)}登录状态无效，请先更新 Cookie`);
          return;
        }
        platformAPIs[p] = [{ api, account: null }];
      } else {
        const accounts = filterAccounts(loadPlatformAccounts(p), opts.account);
        if (!accounts.length) {
          console.error(`${platformLabel(p)}没有可用的账号配置`);
          return;
        }
        platformAPIs[p] = [];
        for (const account of accounts) {
          const prefix = account.name !== 'default' ? `[${account.name}] ` : '';
          const cookie = getAccountCookie(account);
          const api = createPlatformAPI(p, cookie);
          const auth = await api.checkAuth();
          if (!auth.success) {
            console.error(`${prefix}${platformLabel(p)}登录状态无效，请先更新 Cookie`);
            return;
          }
          platformAPIs[p].push({ api, account });
        }
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
        const apiEntries = platformAPIs[p] || [];
        for (const { account: pAccount } of apiEntries) {
          const pName = platformLabel(p);
          const prefix = pAccount && pAccount.name !== 'default' ? `[${pAccount.name}] ` : '';
          console.log(`>>> 推送到${prefix}${pName}...`);
          try {
            const cookie = pAccount ? getAccountCookie(pAccount) : undefined;
            const result = await pushWithImages(articles[i].filePath, imageDir, {
              tail: opts.tail,
              minImages: 7,
              publish: (p === 'baijiahao' || p === 'wechat') ? !!opts.publish : false,
              platform: p,
              cookieStr: cookie,
              _skipAuth: true,
            });

            if (result && result.success) {
              anySuccess = true;
            }
          } catch (e) {
            console.error(`${prefix}${pName}推送失败: ${e.message}`);
          }
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
    const imagePaths = excludeTailImagePaths(extractImagePaths(finalMarkdown), tailImage);
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
