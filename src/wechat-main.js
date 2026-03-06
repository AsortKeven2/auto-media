#!/usr/bin/env node
/**
 * 微信公众号发布工具 CLI
 * 从 Notion 目录批量获取文章 → AI 自动配图 → 保存为公众号草稿
 * 所有作品配置（notionUrl、合集ID、配图目录）统一在 wx-works.json 中管理
 */

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');

const { WechatAPI } = require('./wechat-api');
const { fetchNotionPage, fetchNotionDirectory } = require('./notion-fetcher');
const { mdToHtml, extractImagePaths, DEFAULT_IMAGE_DIR, DEFAULT_TAIL_IMAGE } = require('./batch-publish');
const { buildImageList, resolveImageNames, stripLastSectionImages } = require('./article-generator');
const { selectCoverImage } = require('./image-library');
const { callLLM } = require('./llm');

const SYNC_STATE_FILE = path.join(__dirname, '..', '.wx-sync-state.json');
const WX_OUTPUT_DIR = path.join(__dirname, '..', 'output', 'wechat');
const WX_WORKS_FILE = path.join(__dirname, '..', 'wx-works.json');

/**
 * 加载所有作品配置
 */
function loadAllWorkConfigs() {
  if (!fs.existsSync(WX_WORKS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(WX_WORKS_FILE, 'utf-8'));
  } catch { return {}; }
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
 * 归档 AI 配图后的文章 Markdown 到 output/wechat/ 目录
 */
function saveArticleArchive(title, markdown) {
  if (!fs.existsSync(WX_OUTPUT_DIR)) {
    fs.mkdirSync(WX_OUTPUT_DIR, { recursive: true });
  }
  // 清理标题中的特殊字符作为文件名
  const safeName = title.replace(/[*"/\\<>|?:]/g, '').trim();
  const filePath = path.join(WX_OUTPUT_DIR, `${safeName}.md`);
  fs.writeFileSync(filePath, markdown, 'utf-8');
  console.log(`  归档: output/wechat/${safeName}.md`);
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

  // 2. --force 模式：删除该作品已同步的草稿
  const syncState = loadSyncState();
  const childPageIds = new Set(childPages.map(p => p.id));
  if (opts.force) {
    const draftsToDelete = Object.entries(syncState)
      .filter(([pageId, s]) => childPageIds.has(pageId) && s.article_id);
    if (draftsToDelete.length) {
      console.log(`\n删除 ${workName} 已同步的 ${draftsToDelete.length} 篇草稿...`);
      for (const [pageId, draft] of draftsToDelete) {
        try {
          const del = await api.deleteDraft(draft.article_id);
          if (del.success) {
            console.log(`  ✓ 已删除: ${draft.title} (${draft.article_id})`);
            delete syncState[pageId];
          } else {
            console.log(`  ⚠ 删除失败: ${draft.title} - ${del.message}`);
          }
        } catch (e) {
          console.log(`  ⚠ 删除异常: ${draft.title} - ${e.message}`);
        }
      }
      saveSyncState(syncState);
    }
  }

  // 3. 过滤已处理的页面
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
      saveArticleArchive(title, finalMarkdown);

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
        workFilter: workConfig.work || undefined,
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

// ==================== 批量同步 ====================

program
  .command('batch')
  .description('从 Notion 批量同步文章到公众号草稿（配置读取 wx-works.json）')
  .argument('[work]', '作品名称，不传则同步所有已配置 notionUrl 的作品')
  .option('--interval <seconds>', '每篇文章之间的间隔秒数', '15')
  .option('--no-auto-images', '不自动配图')
  .option('--force', '强制重新处理所有页面（删除已同步草稿并重新同步）')
  .action(async (work, opts) => {
    const allConfigs = loadAllWorkConfigs();

    // 确定要同步的作品列表
    let worksToSync;
    if (work) {
      const config = allConfigs[work];
      if (!config) {
        console.error(`作品 "${work}" 未在 wx-works.json 中配置`);
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
        console.error('wx-works.json 中没有配置 notionUrl 的作品');
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
