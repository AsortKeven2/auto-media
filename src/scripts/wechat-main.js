#!/usr/bin/env node
/**
 * 微信公众号发布工具 CLI
 * 从 Notion 目录批量获取文章 → AI 自动配图 → 保存为公众号草稿
 * 所有作品配置统一在 config.json 的 wechat 字段中管理
 */

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');

const { WechatAPI } = require('../core/wechat-api');
const { fetchNotionDirectory } = require('../core/notion-fetcher');
const { mdToHtml, extractImagePaths, excludeTailImagePaths, DEFAULT_IMAGE_DIR, DEFAULT_TAIL_IMAGE } = require('../core/batch-publish');
const { generateArticle } = require('../core/article-generator');
const { selectCoverImage } = require('../core/image-library');
const { generateTopics, buildWeightedCategoryPlan } = require('../core/topic-generator');
const { ensureLocalMarkdownSynced, loadBjhSyncState, saveBjhSyncState } = require('../core/notion-local-sync');
const { loadPlatformAccounts, filterAccounts, getAccountCookie } = require('../core/account-config');
const { loadConfig, saveConfig } = require('../core/config');

const SYNC_STATE_FILE = path.join(__dirname, '../..', 'wx-sync-state.json');
const LEGACY_SYNC_STATE_FILE = path.join(__dirname, '../..', '.wx-sync-state.json');
const WX_SYNC_DIR = path.join(__dirname, '../..', 'archive', 'wechat', 'sync');
const WX_GENERATED_DIR = path.join(__dirname, '../..', 'archive', 'wechat', 'generated');
/**
 * 加载所有作品配置 — 从 config.json 读取
 */
function loadPublishConfig() {
  return loadConfig();
}

function loadWechatConfig() {
  const config = loadConfig();
  return config.wechat || {};
}

function shuffleArray(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function summarizeCategoryPlan(plan) {
  const counts = new Map();
  for (const category of plan) {
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => `${name} ${count}篇`)
    .join('、');
}

function buildWechatArticleOptions(category, topArticlesHint) {
  return {
    wordCount: '2500-3000',
    maxTokens: 7000,
    topArticlesHint,
  };
}

async function tryGenerateTopicForWork({ workName, category, attempts, seenTitles }) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const overrides = category ? [category] : null;
    const batch = await generateTopics(1, workName, 'wechat', null, null, overrides);

    for (const topic of batch) {
      if (!topic || !topic.topic || seenTitles.has(topic.topic)) continue;
      seenTitles.add(topic.topic);
      return topic;
    }
  }

  return null;
}

async function generateTopicsWithRetry({ count, workName, categoryPlan, attempts = 3, fallbackWorkNames = [] }) {
  const collected = [];
  const seenTitles = new Set();

  for (let i = 0; i < count; i++) {
    const category = categoryPlan && categoryPlan.length
      ? categoryPlan[i % categoryPlan.length]
      : null;
    let topic = await tryGenerateTopicForWork({ workName, category, attempts, seenTitles });

    if (!topic) {
      const replacementWorks = shuffleArray(fallbackWorkNames.filter(name => name && name !== workName));
      for (const replacementWork of replacementWorks) {
        console.log(`  ${workName}: 连续 ${attempts} 次选题失败，改用《${replacementWork}》补位...`);
        topic = await tryGenerateTopicForWork({
          workName: replacementWork,
          category,
          attempts,
          seenTitles,
        });
        if (topic) {
          console.log(`  补位成功: 《${replacementWork}》— [${topic.category}] ${topic.topic}`);
          break;
        }
      }
    }

    if (topic) collected.push(topic);
  }

  return collected;
}


function normalizeHotArticleTitles(value) {
  if (!value) return null;

  if (typeof value === 'string') {
    const lines = value
      .split(/\r?\n/)
      .map(line => line.replace(/^[-*•\d.\s]+/, '').trim())
      .filter(Boolean);
    return lines.length ? lines : null;
  }

  if (Array.isArray(value)) {
    const titles = value
      .map(item => String(item || '').trim())
      .filter(Boolean);
    return titles.length ? titles : null;
  }

  return null;
}

function getConfiguredWechatHotArticleTitles(config, accountConfig) {
  // 优先使用账号级别的配置
  if (accountConfig && accountConfig.hot_articles_reference) {
    const accountTitles = normalizeHotArticleTitles(accountConfig.hot_articles_reference);
    if (accountTitles) return accountTitles;
  }
  if (!config || typeof config !== 'object') return null;
  const wechat = config.wechat || {};
  return normalizeHotArticleTitles(wechat.hot_articles_reference);
}

function resolveWechatSyncStateFile() {
  if (fs.existsSync(SYNC_STATE_FILE)) return SYNC_STATE_FILE;

  if (fs.existsSync(LEGACY_SYNC_STATE_FILE)) {
    try {
      fs.copyFileSync(LEGACY_SYNC_STATE_FILE, SYNC_STATE_FILE);
      console.log('  已迁移公众号同步状态文件到 wx-sync-state.json');
      return SYNC_STATE_FILE;
    } catch (e) {
      console.error(`⚠ 公众号同步状态文件迁移失败: ${e.message}`);
      return LEGACY_SYNC_STATE_FILE;
    }
  }

  return SYNC_STATE_FILE;
}

function formatWechatHotArticleTitles(titles) {
  if (!titles || !titles.length) return null;
  return titles.map((title, idx) => `${idx + 1}. ${title}`).join('\n');
}

async function resolveWechatHotArticlesHint(api, publishConfig, accountConfig) {
  const configuredTitles = getConfiguredWechatHotArticleTitles(publishConfig, accountConfig);
  if (configuredTitles) {
    console.log('\n  使用 config.json 中配置的公众号热文标题作为参考');
    console.log(`  已加载 ${configuredTitles.length} 条手动配置的热文标题`);
    return formatWechatHotArticleTitles(configuredTitles);
  }

  try {
    console.log('\n  读取公众号热文标题...');
    const wxApi = api || new WechatAPI(getAccountCookie(accountConfig));
    if (!api) await wxApi.fetchToken();
    const { byRead } = await wxApi.fetchTopArticles(10);

    const hasData = byRead.length > 0 && byRead[0].read_num > 0;
    if (!hasData) {
      console.log('  文章数据暂无（阅读均为0），跳过热文标题参考');
      return null;
    }

    console.log('  已获取热文标题');
    byRead.slice(0, 3).forEach((a, i) => {
      console.log(`    ${i + 1}. ${a.title} (阅读${a.read_num} 点赞${a.like_num})`);
    });
    return formatWechatHotArticleTitles(byRead.map(a => a.title).filter(Boolean));
  } catch (e) {
    console.error(`  热文标题读取失败（不影响生成）: ${e.message}`);
    return null;
  }
}

/**
 * 读取同步状态（Notion 页面 ID → 微信草稿信息）
 */
function loadSyncState() {
  const stateFile = resolveWechatSyncStateFile();
  if (!fs.existsSync(stateFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  } catch (e) {
    console.error(`⚠ 同步状态文件解析失败: ${e.message}`);
    return {};
  }
}

/**
 * 保存同步状态
 */
function saveSyncState(state) {
  const stateFile = resolveWechatSyncStateFile();
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf-8');
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
  const relPath = path.relative(path.join(__dirname, '../..'), outputDir);
  console.log(`  归档: ${relPath}/${safeName}.md`);
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
  .option('-a, --account <name>', '指定账号名称（多账号模式）')
  .action((cookie, opts) => {
    const cfg = loadConfig();
    if (!cfg.wechat) cfg.wechat = {};
    const accounts = cfg.wechat.accounts || [];

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
      cfg.wechat.cookie = cookie.trim();
    }

    saveConfig(cfg);
    console.log('公众号 Cookie 已更新到 config.json');
  });

// ==================== 检查登录 ====================

program
  .command('check')
  .description('检查公众号登录状态')
  .option('-a, --account <name>', '指定账号名称')
  .action(async (opts) => {
    const accounts = filterAccounts(loadPlatformAccounts('wechat'), opts.account);
    if (!accounts.length) {
      console.error('没有可用的公众号账号配置');
      return;
    }
    for (const account of accounts) {
      const prefix = account.name !== 'default' ? `[${account.name}] ` : '';
      const cookie = getAccountCookie(account);
      const api = new WechatAPI(cookie);
      console.log(`${prefix}公众号:`);
      await api.checkAuth();
    }
  });

// ==================== 同步单个作品 ====================

/**
 * 同步单个作品：从 Notion 目录获取文章 → 配图 → 保存草稿
 * @returns {{ success: number, fail: number }}
 */
async function syncOneWork(api, workName, workConfig, opts, accountConfig) {
  const imageDir = path.resolve(DEFAULT_IMAGE_DIR);
  const allowedGroups = workConfig.image_dirs || [workName];
  const interval = parseInt(opts.interval) * 1000;
  const bjhSyncState = loadBjhSyncState();
  const accountName = accountConfig ? accountConfig.name : undefined;

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

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  [${i + 1}/${pendingPages.length}] ${child.title}`);
    console.log('─'.repeat(50));

    // 限流
    if (i > 0) {
      console.log(`等待 ${opts.interval} 秒...`);
      await new Promise(r => setTimeout(r, interval));
    }

    try {
      // 获取页面内容，并同步到本地 Markdown（带配图）
      console.log('同步到本地 Markdown...');
      const syncResult = await ensureLocalMarkdownSynced({
        pageId: child.id,
        pageTitle: child.title,
        workName,
        allowedGroups,
        imageDir,
        autoImages: opts.autoImages !== false,
        state: bjhSyncState,
        accountName,
      });
      bjhSyncState[child.id] = syncResult.stateEntry;
      saveBjhSyncState(bjhSyncState);

      const title = syncResult.title;
      let finalMarkdown = syncResult.markdown;
      console.log(`  字数: ${finalMarkdown.replace(/\s/g, '').length}`);
      if (syncResult.reused) {
        console.log('  复用已同步到本地的 Markdown');
      } else if (syncResult.imageStats.missing.length) {
        console.log(`  缺失: ${syncResult.imageStats.missing.join('、')}`);
      }

      // 归档 AI 配图后的文章
      saveArticleArchive(title, finalMarkdown, WX_SYNC_DIR);

      // 尾图
      const tailImage = DEFAULT_TAIL_IMAGE;
      if (tailImage && fs.existsSync(tailImage)) {
        finalMarkdown += `\n\n![尾图](${tailImage})\n`;
      }

      // 封面：标题角色图 > 文中最佳比例图
      const imagePaths = excludeTailImagePaths(extractImagePaths(finalMarkdown), tailImage);
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

      // 转 HTML
      let html = mdToHtml(finalMarkdown, 'wechat');

      // 上传正文图片
      console.log('上传图片...');
      html = await api.processContentImages(html);
      html = html.replace(/<img[^>]+src="(?!https?:\/\/)[^"]*"[^>]*>/gi, () => '');

      // 保存草稿
      console.log('保存草稿...');
      const albumInfo = buildAlbumInfo(workConfig);
      const author = (accountConfig && accountConfig.author) || loadWechatConfig().author;
      const writerId = (accountConfig && accountConfig.writer_id) || loadWechatConfig().writer_id;
      const result = await api.saveDraft(title, html, coverUrl, { albumInfo, author, writerId });

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
          account: accountName || undefined,
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
  .option('-a, --account <name>', '指定账号名称，不传则处理所有账号')
  .option('--interval <seconds>', '每篇文章之间的间隔秒数', '15')
  .option('--rounds <n>', '执行轮次（每轮按配置生成一批文章）', '10')
  .option('--random [n]', '随机模式：从所有合集中随机抽取 n 个生成（默认 2），每轮重新抽取')
  .option('--per <count>', '随机模式下每个合集生成的文章数', '1')
  .option('--no-push', '仅生成文章，不推送到草稿箱')
  .action(async (work, opts) => {
    const accounts = filterAccounts(loadPlatformAccounts('wechat'), opts.account);
    if (!accounts.length) {
      console.error('没有可用的公众号账号配置');
      return;
    }

    for (const account of accounts) {
    const prefix = account.name !== 'default' ? `[${account.name}] ` : '';
    const allConfigs = account.works || {};
    const imageDir = path.resolve(DEFAULT_IMAGE_DIR);
    const interval = parseInt(opts.interval) * 1000;

    // 确定要生成的作品列表
    // 随机模式：从所有合集中随机抽取若干个，每轮重新抽取
    const isRandom = opts.random !== undefined;
    const randomCount = isRandom ? (opts.random === true ? 2 : parseInt(opts.random, 10)) : 0;
    const perWork = Math.max(1, parseInt(opts.per, 10) || 1);

    let fixedWorks = null;      // 非随机模式：一次性确定的作品列表
    let selectRandomWorks = null; // 随机模式：每轮调用以重新抽取
    let randomPickCount = 0;    // 随机模式：实际抽取的合集数（已按池子大小收窄）
    let randomPoolNames = [];   // 随机模式：合集池名称（用于打印）

    if (isRandom) {
      if (work) {
        console.error(`${prefix}--random 模式下不能再指定具体作品`);
        continue;
      }
      if (!Number.isInteger(randomCount) || randomCount < 1) {
        console.error(`${prefix}--random 的数量无效: ${opts.random}`);
        continue;
      }
      const pool = Object.entries(allConfigs).map(([name, config]) => ({ name, config }));
      if (!pool.length) {
        console.error(`${prefix}没有可用的合集配置`);
        continue;
      }
      randomPoolNames = pool.map(p => p.name);
      randomPickCount = Math.min(randomCount, pool.length);
      if (randomPickCount < randomCount) {
        console.log(`${prefix}配置的合集只有 ${pool.length} 个，将随机抽取全部 ${randomPickCount} 个`);
      }
      // Fisher-Yates 洗牌后取前 N 个，保证各合集被抽中的概率均匀
      selectRandomWorks = () => {
        const arr = [...pool];
        for (let i = arr.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr.slice(0, randomPickCount)
          .map(({ name, config }) => ({ name, config, count: perWork }));
      };
    } else if (work) {
      const config = allConfigs[work];
      if (!config) {
        console.error(`${prefix}作品 "${work}" 未在配置中`);
        console.log(`可用作品: ${Object.keys(allConfigs).join('、')}`);
        continue;
      }
      const count = config.count || 0;
      if (count <= 0) {
        console.log(`${prefix}作品 "${work}" 的 count 为 ${count}，无需生成`);
        continue;
      }
      fixedWorks = [{ name: work, config, count }];
    } else {
      fixedWorks = Object.entries(allConfigs)
        .filter(([, c]) => (c.count || 0) > 0)
        .map(([name, config]) => ({ name, config, count: config.count }));
      if (!fixedWorks.length) {
        console.error(`${prefix}没有 count > 0 的作品`);
        continue;
      }
    }

    const totalArticles = isRandom
      ? randomPickCount * perWork
      : fixedWorks.reduce((sum, w) => sum + w.count, 0);

    const wechatCombine = account.combine === true;
    const accountAuthor = account.author || '';
    const accountWriterId = account.writer_id || '';

    // 合并模式下校验不超过 8 篇
    const MAX_COMBINE_ARTICLES = 8;
    if (wechatCombine && totalArticles > MAX_COMBINE_ARTICLES) {
      console.error(`${prefix}合并模式下最多 ${MAX_COMBINE_ARTICLES} 篇，当前计划 ${totalArticles} 篇，请减少 count 配置`);
      continue;
    }

    const rounds = parseInt(opts.rounds) || 1;
    const globalCategoryQueue = buildWeightedCategoryPlan(totalArticles * rounds);

    console.log('='.repeat(60));
    console.log(`  ${prefix}微信公众号 - AI 直接生成`);
    console.log('='.repeat(60));
    if (isRandom) {
      console.log(`  随机抽取: ${randomPickCount} 个合集 × ${perWork} 篇（每轮重新抽取）`);
      console.log(`  合集池(${randomPoolNames.length}): ${randomPoolNames.join('、')}`);
    } else {
      fixedWorks.forEach(w => console.log(`  ${w.name}: ${w.count} 篇`));
    }
    console.log(`  合计: ${totalArticles} 篇/轮`);
    if (rounds > 1) console.log(`  轮次: ${rounds} 轮（共 ${totalArticles * rounds} 篇）`);
    console.log(`  合并: ${wechatCombine ? '多图文合并' : '逐篇独立草稿'}`);
    console.log(`  间隔: ${opts.interval} 秒`);
    console.log(`  推送: ${opts.push !== false ? '保存到草稿箱' : '仅生成不推送'}`);
    console.log('  热文参考: 已关闭');
    console.log(`  全批分类配额: ${summarizeCategoryPlan(globalCategoryQueue)}`);
    console.log('='.repeat(60));

    // 检查登录
    let api;
    if (opts.push !== false) {
      const cookie = getAccountCookie(account);
      api = new WechatAPI(cookie);
      const auth = await api.checkAuth();
      if (!auth.success) {
        console.error(`${prefix}公众号未登录，请先更新 config.json 中该账号的 cookie`);
        continue;
      }
    }

    const topArticlesHint = null;

    let grandTotalSuccess = 0;
    let grandTotalFail = 0;

    for (let round = 0; round < rounds; round++) {
    if (rounds > 1) {
      console.log(`\n${'▶'.repeat(3)} 第 ${round + 1}/${rounds} 轮`);
    }

    // 本轮要生成的作品：随机模式每轮重新抽取，否则使用固定列表
    const worksToGenerate = isRandom ? selectRandomWorks() : fixedWorks;
    const availableWorkNames = Object.keys(allConfigs).filter(name => allConfigs[name]);
    if (isRandom) {
      console.log(`  本轮随机合集: ${worksToGenerate.map(w => w.name).join('、')}`);
    }

    let globalIdx = 0;
    let totalSuccess = 0;
    let totalFail = 0;
    const allResults = [];
    const draftArticles = []; // 收集所有文章，最后合并为一个草稿

    // ── 分类配额：启动时已按全批总量生成，这里每轮只消费本轮需要的类别 ──
    const roundCategoryPlan = globalCategoryQueue.splice(0, totalArticles);
    const workSlots = [];
    for (const { name, count } of worksToGenerate) {
      for (let i = 0; i < count; i++) workSlots.push(name);
    }
    const shuffledWorkSlots = shuffleArray(workSlots);
    const categoriesByWork = {};
    const retryCategoriesByWork = {};
    for (let i = 0; i < totalArticles; i++) {
      const workName = shuffledWorkSlots[i];
      const category = roundCategoryPlan[i];
      if (!categoriesByWork[workName]) categoriesByWork[workName] = [];
      categoriesByWork[workName].push(category);
    }
    for (const { name } of worksToGenerate) {
      retryCategoriesByWork[name] = [...(categoriesByWork[name] || [])];
    }
    console.log(`\n  本轮分类配额：${summarizeCategoryPlan(roundCategoryPlan)}`);
    if (rounds > 1) {
      console.log(`  剩余分类配额：${summarizeCategoryPlan(globalCategoryQueue) || '无'}`);
    }

    for (const { name: workName, config: workConfig, count } of worksToGenerate) {
      console.log(`\n${'#'.repeat(60)}`);
      console.log(`  ${workName} — 计划 ${count} 篇`);
      console.log('#'.repeat(60));

      // 生成选题，传入该作品的全局分类配额
      const workCategoryPlan = categoriesByWork[workName] || [];
      const topics = await generateTopicsWithRetry({
        count,
        workName,
        categoryPlan: workCategoryPlan,
        attempts: 3,
        fallbackWorkNames: availableWorkNames,
      });
      if (!topics.length) {
        console.error(`  ${workName}: 选题生成失败`);
        totalFail += count;
        for (let k = 0; k < count; k++) {
          allResults.push({ work: workName, title: null, success: false, message: '选题生成失败' });
        }
        continue;
      }
      if (topics.length < count) {
        const missingCount = count - topics.length;
        console.error(`  ${workName}: 仍缺少 ${missingCount} 个选题`);
        totalFail += missingCount;
        for (let k = 0; k < missingCount; k++) {
          allResults.push({ work: workName, title: null, success: false, message: '选题生成失败' });
        }
      }
      console.log(`  生成了 ${topics.length} 个选题`);
      topics.forEach((t, i) => console.log(`    ${i + 1}. [${t.category}] ${t.topic}`));

      for (let i = 0; i < topics.length; i++) {
        globalIdx++;
        const t = topics[i];
        const actualWorkName = t.work || workName;
        const actualWorkConfig = allConfigs[actualWorkName] || workConfig;
        const workLabel = actualWorkName === workName
          ? workName
          : `${workName} → ${actualWorkName}`;
        console.log(`\n${'─'.repeat(60)}`);
        console.log(`  [${globalIdx}/${totalArticles}] ${workLabel} — ${t.topic}`);
        console.log('─'.repeat(60));

        try {
          // 1. AI 生成文章
          console.log('  AI 写作中...');
          const { article: content, imageStats } = await generateArticle(
            t.topic,
            null,
            actualWorkName,
            t.characters,
            imageDir,
            t.category,
            t.related_works,
            buildWechatArticleOptions(t.category, topArticlesHint)
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
            allResults.push({ work: actualWorkName, plannedWork: workName, title: t.topic, success: true, skipped: true });
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
          const imagePaths = excludeTailImagePaths(extractImagePaths(finalMarkdown), tailImage);
          let coverUrl = null;
          const coverResult = selectCoverImage({
            title: t.topic,
            imageDir,
            workFilter: actualWorkName,
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
          const albumInfo = buildAlbumInfo(actualWorkConfig);
          draftArticles.push({
            title: t.topic,
            content: html,
            coverUrl,
            options: { albumInfo, author: accountAuthor, writerId: accountWriterId },
            work: actualWorkName,
          });
          totalSuccess++;
          allResults.push({ work: actualWorkName, plannedWork: workName, title: t.topic, success: true });

        } catch (e) {
          totalFail++;
          console.error(`  ✗ 处理失败: ${e.message}`);
          allResults.push({ work: actualWorkName, plannedWork: workName, title: t.topic, success: false, message: e.message, _topicObj: t });
        }
      }
    }

    // ── 失败补偿：对本轮失败的文章重新生成，必要时换小说补位 ──
    const failedItems = allResults.filter(r => !r.success);
    if (failedItems.length > 0) {
      console.log(`\n${'─'.repeat(60)}`);
      console.log(`  补偿重试：${failedItems.length} 篇失败文章`);
      console.log('─'.repeat(60));

      for (const failedItem of failedItems) {
        const workName = failedItem.work;
        const workConfig = allConfigs[workName] || (worksToGenerate.find(w => w.name === workName) || {}).config;
        if (!workConfig) continue;

        console.log(`\n  ▷ 补偿 [${workName}] ${failedItem.title || '(选题失败)'}`);

        try {
          // 如果原来就是选题失败，重新生成选题
          let topic = failedItem._topicObj;
          if (!topic) {
            console.log('  重新生成选题...');
            const retryCategory = (retryCategoriesByWork[workName] && retryCategoriesByWork[workName].shift())
              || (categoriesByWork[workName] && categoriesByWork[workName][0])
              || '数字盘点类';
            const retryTopics = await generateTopicsWithRetry({
              count: 1,
              workName,
              categoryPlan: [retryCategory],
              attempts: 3,
              fallbackWorkNames: availableWorkNames,
            });
            if (!retryTopics.length) {
              console.error(`  ✗ 补偿选题仍然失败: ${workName}`);
              continue;
            }
            topic = retryTopics[0];
            const actualRetryWork = topic.work || workName;
            const retryLabel = actualRetryWork === workName ? workName : `${workName} → ${actualRetryWork}`;
            console.log(`  新选题: [${retryLabel}] [${topic.category}] ${topic.topic}`);
          }
          const actualTopicWork = topic.work || workName;
          const actualTopicConfig = allConfigs[actualTopicWork] || workConfig;

          console.log('  AI 写作中...');
          const { article: content, imageStats } = await generateArticle(
            topic.topic, null, actualTopicWork, topic.characters,
            imageDir, topic.category, topic.related_works,
            buildWechatArticleOptions(topic.category, topArticlesHint)
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
            const imagePaths = excludeTailImagePaths(extractImagePaths(finalMarkdown), tailImage);
            let coverUrl = null;
            const coverResult = selectCoverImage({
              title: topic.topic, imageDir, workFilter: actualTopicWork, articleImagePaths: imagePaths,
            });
            if (coverResult.coverPath) {
              const uploaded = await api.uploadImage(coverResult.coverPath);
              coverUrl = uploaded?.url || null;
            }
            html = await api.processContentImages(html);
            html = html.replace(/<img[^>]+src="(?!https?:\/\/)[^"]*"[^>]*>/gi, () => '');

            const albumInfo = buildAlbumInfo(actualTopicConfig);
            draftArticles.push({
              title: topic.topic, content: html, coverUrl,
              options: { albumInfo, author: accountAuthor, writerId: accountWriterId }, work: actualTopicWork,
            });
          }

          // 更新结果记录
          failedItem.success = true;
          failedItem.work = actualTopicWork;
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
    if (allResults.length > 1) {
      console.log('\n各作品统计:');
      const statWorkNames = [...new Set(allResults.map(r => r.work).filter(Boolean))];
      for (const workName of statWorkNames) {
        const workResults = allResults.filter(r => r.work === workName);
        const workSuccess = workResults.filter(r => r.success).length;
        console.log(`  ${workName}: ${workSuccess}/${workResults.length}`);
      }
    }
    if (allResults.length) {
      console.log('\n详情:');
      allResults.forEach((r, i) => {
        const icon = r.skipped ? '○' : r.success ? '✓' : '✗';
        const workLabel = r.plannedWork && r.plannedWork !== r.work
          ? `${r.plannedWork} → ${r.work}`
          : r.work;
        console.log(`  ${icon} ${i + 1}. [${workLabel}] ${r.title}`);
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
    } // end account loop
  });

// ==================== 批量同步 ====================

program
  .command('batch')
  .description('从 Notion 批量同步文章到公众号草稿')
  .argument('[work]', '作品名称，不传则同步所有已配置 notionUrl 的作品')
  .option('-a, --account <name>', '指定账号名称，不传则处理所有账号')
  .option('--interval <seconds>', '每篇文章之间的间隔秒数', '15')
  .option('--no-auto-images', '不自动配图')
  .action(async (work, opts) => {
    const accounts = filterAccounts(loadPlatformAccounts('wechat'), opts.account);
    if (!accounts.length) {
      console.error('没有可用的公众号账号配置');
      process.exitCode = 1;
      return;
    }

    let grandSuccess = 0;
    let grandFail = 0;

    for (const account of accounts) {
      const prefix = account.name !== 'default' ? `[${account.name}] ` : '';
      const allConfigs = account.works || {};

      // 确定要同步的作品列表
      let worksToSync;
      if (work) {
        const config = allConfigs[work];
        if (!config) {
          console.error(`${prefix}作品 "${work}" 未在配置中`);
          console.log(`可用作品: ${Object.keys(allConfigs).join('、')}`);
          continue;
        }
        if (!config.notionUrl) {
          console.error(`${prefix}作品 "${work}" 未配置 notionUrl`);
          continue;
        }
        worksToSync = [{ name: work, config }];
      } else {
        worksToSync = Object.entries(allConfigs)
          .filter(([, c]) => c.notionUrl)
          .map(([name, config]) => ({ name, config }));
        if (!worksToSync.length) {
          console.error(`${prefix}没有配置 notionUrl 的作品`);
          continue;
        }
        console.log(`${prefix}将同步 ${worksToSync.length} 部作品: ${worksToSync.map(w => w.name).join('、')}`);
      }

      // 检查登录
      const cookie = getAccountCookie(account);
      const api = new WechatAPI(cookie);
      const auth = await api.checkAuth();
      if (!auth.success) {
        console.error(`${prefix}公众号未登录，请先更新 config.json 中该账号的 cookie`);
        continue;
      }

      // 逐个作品同步
      let totalSuccess = 0;
      let totalFail = 0;
      for (const { name: workName, config: workConfig } of worksToSync) {
        const { success, fail } = await syncOneWork(api, workName, workConfig, opts, account);
        totalSuccess += success;
        totalFail += fail;
      }

      if (worksToSync.length > 1) {
        console.log(`\n${'='.repeat(50)}`);
        console.log(`  ${prefix}完成: 成功 ${totalSuccess} 篇 | 失败 ${totalFail} 篇`);
        console.log('='.repeat(50));
      }

      grandSuccess += totalSuccess;
      grandFail += totalFail;
    }

    if (accounts.length > 1) {
      console.log(`\n${'='.repeat(50)}`);
      console.log(`  全部账号完成: 成功 ${grandSuccess} 篇 | 失败 ${grandFail} 篇`);
      console.log('='.repeat(50));
    }

    if (grandFail > 0) {
      process.exitCode = 1;
    }
  });

// ==================== 热文排行 ====================

program
  .command('top')
  .description('查看公众号热文排行（按阅读量）')
  .option('-n, --count <n>', '显示数量', '10')
  .option('-a, --account <name>', '指定账号名称')
  .action(async (opts) => {
    const accounts = filterAccounts(loadPlatformAccounts('wechat'), opts.account);
    if (!accounts.length) {
      console.error('没有可用的公众号账号配置');
      return;
    }

    for (const account of accounts) {
      const prefix = account.name !== 'default' ? `[${account.name}] ` : '';
      const cookie = getAccountCookie(account);
      const api = new WechatAPI(cookie);
      const auth = await api.checkAuth();
      if (!auth.success) {
        console.error(`${prefix}公众号未登录`);
        continue;
      }

      const topN = parseInt(opts.count);
      console.log(`\n${prefix}拉取文章数据中...`);
      const { byRead } = await api.fetchTopArticles(topN);

      if (!byRead.length) {
        console.log(`${prefix}暂无数据`);
        continue;
      }
      console.log(`\n${prefix}阅读量 TOP ${topN}:`);
      console.log('-'.repeat(70));
      byRead.forEach((a, i) => {
        console.log(`  ${String(i + 1).padStart(2)}. ${a.title}`);
        console.log(`      阅读: ${a.read_num}  点赞: ${a.like_num}  分享: ${a.share_num}  评论: ${a.comment_num}`);
      });
    }
  });

// ==================== 列出草稿 ====================

program
  .command('list')
  .description('列出公众号草稿箱中的所有草稿')
  .option('-a, --account <name>', '指定账号名称')
  .action(async (opts) => {
    const accounts = filterAccounts(loadPlatformAccounts('wechat'), opts.account);
    if (!accounts.length) {
      console.error('没有可用的公众号账号配置');
      return;
    }

    for (const account of accounts) {
      const prefix = account.name !== 'default' ? `[${account.name}] ` : '';
      const cookie = getAccountCookie(account);
      const api = new WechatAPI(cookie);
      const auth = await api.checkAuth();
      if (!auth.success) {
        console.error(`${prefix}公众号未登录`);
        continue;
      }

      console.log(`\n${prefix}获取草稿列表...`);
      const { list, total } = await api.listDrafts();
      console.log(`${prefix}共 ${total} 篇草稿:\n`);
      list.forEach((d, i) => {
        const date = d.update_time ? new Date(d.update_time * 1000).toLocaleString('zh-CN') : '';
        console.log(`  ${i + 1}. [${d.app_id}] ${d.title}  ${date}`);
      });
    }
  });

// ==================== 清空草稿 ====================

program
  .command('clean')
  .description('删除草稿箱中所有草稿（仅清除已成功删除的同步记录）')
  .option('-a, --account <name>', '指定账号名称')
  .action(async (opts) => {
    const accounts = filterAccounts(loadPlatformAccounts('wechat'), opts.account);
    if (!accounts.length) {
      console.error('没有可用的公众号账号配置');
      return;
    }

    for (const account of accounts) {
      const prefix = account.name !== 'default' ? `[${account.name}] ` : '';
      const cookie = getAccountCookie(account);
      const api = new WechatAPI(cookie);
      const auth = await api.checkAuth();
      if (!auth.success) {
        console.error(`${prefix}公众号未登录`);
        continue;
      }

      console.log(`\n${prefix}获取草稿列表...`);
      const { list } = await api.listDrafts();
      if (!list.length) {
        console.log(`${prefix}草稿箱为空`);
        continue;
      }

      console.log(`${prefix}共 ${list.length} 篇草稿，开始删除...\n`);
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

      console.log(`\n${prefix}删除完成: ${deleted}/${list.length} | 清除同步记录: ${cleared} 条 | 保留同步记录: ${Object.keys(syncState).length} 条`);
    }
  });

// ── 本地运营面板 ──

program
  .command('server')
  .description('启动本地运营面板')
  .option('-p, --port <port>', '端口号', '7800')
  .action(async (opts) => {
    const { startServer } = require('../server/index');
    const port = parseInt(opts.port);
    await startServer(port);
    // 自动打开浏览器
    const open = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    require('child_process').exec(`${open} http://localhost:${port}`);
  });

program
  .command('cookie')
  .description('打开浏览器扫码登录，自动提取公众号 Cookie')
  .option('-a, --account <name>', '指定账号名称（多账号模式）')
  .action(async (opts) => {
    const { cliExtract } = require('../server/wechat-cookie');
    await cliExtract({ account: opts.account });
  });

program.parse();
