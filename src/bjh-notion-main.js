#!/usr/bin/env node
/**
 * 百家号本地 Markdown 发布 CLI
 * sync:  从 Notion 同步到本地 Markdown（带配图）
 * publish: 从本地 Markdown 读取并发布到百家号
 */

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');

const { BaijiahaoAPI } = require('./baijiahao-api');
const { mdToHtml, extractImagePaths, DEFAULT_IMAGE_DIR, DEFAULT_TAIL_IMAGE } = require('./batch-publish');
const { selectCoverImage } = require('./image-library');
const {
  loadBjhSyncState,
  saveBjhSyncState,
  getBjhSyncStateFile,
  readLocalMarkdown,
  syncNotionWorkToLocal,
} = require('./notion-local-sync');

const PUBLISH_CONFIG_PATH = path.join(__dirname, '..', 'publish_config.json');

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
  return config ? ((config.baijiahao || {}).works || {}) : {};
}

function getWorkPublishCount(workConfig) {
  const count = parseInt(workConfig?.count, 10);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function resolveWorksForSync(work, allConfigs) {
  if (work) {
    const config = allConfigs[work];
    if (!config) {
      console.error(`作品 "${work}" 未在 publish_config.json 的 baijiahao.works 中配置`);
      console.log(`可用作品: ${Object.keys(allConfigs).join('、')}`);
      return null;
    }
    if (!config.notionUrl) {
      console.error(`作品 "${work}" 未配置 notionUrl`);
      return null;
    }
    return [{ name: work, config }];
  }

  const works = Object.entries(allConfigs)
    .filter(([, config]) => !!config.notionUrl)
    .map(([name, config]) => ({ name, config }));

  if (!works.length) {
    console.error('publish_config.json 的 baijiahao.works 中没有配置 notionUrl 的作品');
    return null;
  }
  return works;
}

function resolveWorksForPublish(work, allConfigs) {
  if (work) {
    const config = allConfigs[work];
    if (!config) {
      console.error(`作品 "${work}" 未在 publish_config.json 的 baijiahao.works 中配置`);
      console.log(`可用作品: ${Object.keys(allConfigs).join('、')}`);
      return null;
    }
    const count = getWorkPublishCount(config);
    if (count <= 0) {
      console.log(`作品 "${work}" 的 count 为 ${count}，无需发布`);
      return null;
    }
    return [{ name: work, config, count }];
  }

  const works = Object.entries(allConfigs)
    .map(([name, config]) => ({ name, config, count: getWorkPublishCount(config) }))
    .filter(item => item.count > 0);

  if (!works.length) {
    console.error('publish_config.json 的 baijiahao.works 中没有 count > 0 的作品');
    return null;
  }
  return works;
}

function insertCoverIntoMarkdown(markdown, coverPath) {
  const firstHeadingPos = markdown.indexOf('## ');
  if (firstHeadingPos === -1) return markdown;

  const insertPos = markdown.indexOf('\n', firstHeadingPos);
  if (insertPos === -1) return markdown;

  return markdown.slice(0, insertPos) + `\n\n![配图](${coverPath})\n` + markdown.slice(insertPos);
}

function buildPendingEntries(state, workName, limit) {
  return Object.entries(state)
    .filter(([, entry]) => entry.work === workName)
    .filter(([, entry]) => entry.status === 'synced' || entry.status === 'publish_failed')
    .filter(([, entry]) => entry.local_file && fs.existsSync(entry.local_file))
    .sort((a, b) => {
      const aTime = new Date(a[1].synced_at || 0).getTime();
      const bTime = new Date(b[1].synced_at || 0).getTime();
      return aTime - bTime;
    })
    .slice(0, limit);
}

function buildStatusSummary(state, workName) {
  const entries = Object.values(state).filter(entry => entry.work === workName);
  const published = entries.filter(entry => entry.status === 'published').length;
  const failed = entries.filter(entry => entry.status === 'publish_failed').length;
  const synced = entries.filter(entry => entry.status === 'synced').length;
  const missing = entries.filter(entry => entry.local_file && !fs.existsSync(entry.local_file)).length;

  return {
    total: entries.length,
    published,
    synced,
    failed,
    missing,
    pending: synced + failed,
  };
}

function countPublishableEntries(state, workName) {
  return Object.values(state)
    .filter(entry => entry.work === workName)
    .filter(entry => entry.status === 'synced' || entry.status === 'publish_failed')
    .filter(entry => entry.local_file && fs.existsSync(entry.local_file)).length;
}

async function buildPublishPayload(api, entry, workName, workConfig, opts) {
  const imageDir = path.resolve(opts.images);
  let finalMarkdown = readLocalMarkdown(entry.local_file);

  const tailImage = opts.tail ? path.resolve(opts.tail) : DEFAULT_TAIL_IMAGE;
  if (tailImage && fs.existsSync(tailImage)) {
    finalMarkdown += `\n\n![尾图](${tailImage})\n`;
  }

  let imagePaths = extractImagePaths(finalMarkdown);
  let coverImages = [];
  const coverResult = selectCoverImage({
    title: entry.title,
    imageDir,
    workFilter: workName,
    articleImagePaths: imagePaths,
  });

  if (coverResult.coverPath) {
    if (coverResult.fromLibrary) {
      const alreadyInArticle = imagePaths.some(p => path.resolve(p) === path.resolve(coverResult.coverPath));
      if (!alreadyInArticle) {
        finalMarkdown = insertCoverIntoMarkdown(finalMarkdown, coverResult.coverPath);
        imagePaths = extractImagePaths(finalMarkdown);
        console.log('  封面图未在文中出现，已临时插入到正文');
      }
      console.log(`  封面（标题角色）: ${path.basename(coverResult.coverPath)}`);
    } else {
      console.log(`  封面（文中配图）: ${path.basename(coverResult.coverPath)}`);
    }

    const uploaded = await api.uploadImage(coverResult.coverPath);
    if (uploaded) {
      coverImages.push({ src: uploaded });
    }
  } else {
    console.log('  ⚠ 无合适封面图');
  }

  let html = mdToHtml(finalMarkdown, 'baijiahao');
  console.log('  上传正文图片...');
  html = await api.processContentImages(html);
  html = html.replace(/<img[^>]+src="(?!https?:\/\/)[^"]*"[^>]*>/gi, () => '');

  return { html, coverImages };
}

async function publishOneEntry(api, pageId, entry, workName, workConfig, opts, state) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  ${entry.title}`);
  console.log('─'.repeat(50));

  if (!entry.local_file || !fs.existsSync(entry.local_file)) {
    state[pageId] = {
      ...entry,
      status: 'publish_failed',
      last_error: '本地 Markdown 文件不存在',
    };
    saveBjhSyncState(state);
    console.error('  ✗ 本地 Markdown 文件不存在');
    return false;
  }

  try {
    const { html, coverImages } = await buildPublishPayload(api, entry, workName, workConfig, opts);

    console.log('  保存草稿...');
    const draftResult = await api.saveDraft(entry.title, html, coverImages);
    if (!draftResult.success) {
      state[pageId] = {
        ...entry,
        status: 'publish_failed',
        last_error: draftResult.message,
      };
      saveBjhSyncState(state);
      console.error(`  ✗ 草稿保存失败: ${draftResult.message}`);
      return false;
    }

    console.log(`  ✓ 草稿已保存 (ID: ${draftResult.article_id})`);
    console.log('  立即发布...');
    const pubResult = await api.publishArticle(draftResult.article_id, entry.title, html, coverImages);

    if (!pubResult.success) {
      state[pageId] = {
        ...entry,
        article_id: draftResult.article_id,
        draft_url: draftResult.draft_url,
        status: 'publish_failed',
        last_error: pubResult.message,
      };
      saveBjhSyncState(state);
      console.error(`  ✗ 发布失败: ${pubResult.message}`);
      return false;
    }

    state[pageId] = {
      ...entry,
      article_id: draftResult.article_id,
      draft_url: draftResult.draft_url,
      publish_url: pubResult.publish_url || '',
      published_at: new Date().toISOString(),
      status: 'published',
    };
    delete state[pageId].last_error;
    saveBjhSyncState(state);

    console.log(`  ✓ 发布成功: ${pubResult.publish_url || ''}`);
    return true;
  } catch (e) {
    state[pageId] = {
      ...entry,
      status: 'publish_failed',
      last_error: e.message,
    };
    saveBjhSyncState(state);
    console.error(`  ✗ 发布异常: ${e.message}`);
    return false;
  }
}

async function runSync(work, opts) {
  const allConfigs = loadAllWorkConfigs();
  const worksToSync = resolveWorksForSync(work, allConfigs);
  if (!worksToSync) return;

  let totalSuccess = 0;
  let totalFail = 0;

  for (const { name: workName, config: workConfig } of worksToSync) {
    const result = await syncNotionWorkToLocal(workName, workConfig, opts);
    totalSuccess += result.success;
    totalFail += result.fail;
  }

  if (worksToSync.length > 1) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  本地同步完成: 成功 ${totalSuccess} 篇 | 失败 ${totalFail} 篇`);
    console.log('='.repeat(60));
  }
}

async function runPublish(work, opts) {
  const allConfigs = loadAllWorkConfigs();
  const worksToPublish = resolveWorksForPublish(work, allConfigs);
  if (!worksToPublish) return;

  const api = new BaijiahaoAPI();
  const auth = await api.checkAuth();
  if (!auth.success) {
    console.error('百家号未登录，请先运行: node src/main.js login "<cookie>"');
    return;
  }

  const state = loadBjhSyncState();
  const intervalMs = parseInt(opts.interval || '15', 10) * 1000;
  let processed = 0;
  let totalSuccess = 0;
  let totalFail = 0;

  console.log('='.repeat(60));
  console.log('  百家号从本地 Markdown 发布');
  console.log('='.repeat(60));
  console.log(`  状态文件: ${getBjhSyncStateFile()}`);
  worksToPublish.forEach(item => {
    console.log(`  ${item.name}: ${item.count} 篇/次`);
  });
  console.log(`  间隔: ${opts.interval} 秒`);
  console.log('='.repeat(60));

  for (const { name: workName, config: workConfig, count } of worksToPublish) {
    const publishableCount = countPublishableEntries(state, workName);
    const pendingEntries = buildPendingEntries(state, workName, count);

    console.log(`\n${'='.repeat(50)}`);
    console.log(`  作品: ${workName}`);
    console.log('='.repeat(50));
    console.log(`  可发布记录: ${publishableCount} 篇`);
    console.log(`  本轮待发布: ${pendingEntries.length} 篇`);

    if (!pendingEntries.length) continue;

    for (let i = 0; i < pendingEntries.length; i++) {
      if (processed > 0) {
        console.log(`  等待 ${opts.interval} 秒...`);
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }

      const [pageId, entry] = pendingEntries[i];
      const success = await publishOneEntry(api, pageId, entry, workName, workConfig, opts, state);
      if (success) totalSuccess++;
      else totalFail++;
      processed++;
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('  本轮发布完成');
  console.log('='.repeat(60));
  console.log(`  成功: ${totalSuccess} 篇 | 失败: ${totalFail} 篇`);
}

async function runStatus(work) {
  const allConfigs = loadAllWorkConfigs();
  const works = work
    ? (() => {
        const config = allConfigs[work];
        if (!config) {
          console.error(`作品 "${work}" 未在 publish_config.json 的 baijiahao.works 中配置`);
          console.log(`可用作品: ${Object.keys(allConfigs).join('、')}`);
          return null;
        }
        return [{ name: work, config }];
      })()
    : Object.entries(allConfigs).map(([name, config]) => ({ name, config }));

  if (!works || !works.length) {
    console.error('publish_config.json 的 baijiahao.works 中没有可统计的作品');
    return;
  }

  const state = loadBjhSyncState();
  let totalSynced = 0;
  let totalPublished = 0;
  let totalPending = 0;

  console.log('='.repeat(60));
  console.log('  百家号本地 Markdown 状态');
  console.log('='.repeat(60));

  for (const { name: workName, config: workConfig } of works) {
    const count = getWorkPublishCount(workConfig);
    const summary = buildStatusSummary(state, workName);
    const days = count > 0 && summary.pending > 0 ? Math.ceil(summary.pending / count) : 0;

    totalSynced += summary.total;
    totalPublished += summary.published;
    totalPending += summary.pending;

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  ${workName}`);
    console.log('─'.repeat(50));
    console.log(`  本地已同步: ${summary.total}`);
    console.log(`  已发布: ${summary.published}`);
    console.log(`  待发布: ${summary.synced}`);
    console.log(`  发布失败待重试: ${summary.failed}`);
    if (summary.missing > 0) console.log(`  本地文件缺失: ${summary.missing}`);
    console.log(`  当前 count: ${count}`);
    console.log(`  还能发: ${days} 天`);
  }

  if (works.length > 1) {
    console.log(`\n${'='.repeat(60)}`);
    console.log('  总计');
    console.log('='.repeat(60));
    console.log(`  本地已同步: ${totalSynced}`);
    console.log(`  已发布: ${totalPublished}`);
    console.log(`  待处理: ${totalPending}`);
  }
}

const program = new Command();
program.name('bjh-notion').description('百家号本地 Markdown 同步与发布工具').version('1.0.0');

program
  .command('sync')
  .description('从 Notion 同步到本地 Markdown（带配图）')
  .argument('[work]', '作品名称，不传则同步所有配置了 notionUrl 的作品')
  .option('-i, --images <dir>', '图片素材目录', DEFAULT_IMAGE_DIR)
  .option('--interval <seconds>', '每篇文章之间的间隔秒数', '15')
  .option('--no-auto-images', '不同步配图，直接保存原文 Markdown')
  .action(async (work, opts) => {
    await runSync(work, opts);
  });

program
  .command('publish')
  .description('读取本地 Markdown 并按各作品 count 发布到百家号')
  .argument('[work]', '作品名称，不传则处理所有 count > 0 的作品')
  .option('-i, --images <dir>', '图片素材目录', DEFAULT_IMAGE_DIR)
  .option('-t, --tail <file>', '尾图路径', DEFAULT_TAIL_IMAGE)
  .option('--interval <seconds>', '每篇文章之间的间隔秒数', '15')
  .action(async (work, opts) => {
    await runPublish(work, opts);
  });

program
  .command('status')
  .description('查看本地 Markdown 同步/发布状态')
  .argument('[work]', '作品名称，不传则统计所有配置作品')
  .action(async (work) => {
    await runStatus(work);
  });

program.parse();
