const fs = require('fs');
const path = require('path');

const { fetchNotionPage, fetchNotionDirectory } = require('./notion-fetcher');
const { insertImages } = require('./article-generator');
const { DEFAULT_IMAGE_DIR } = require('./batch-publish');

const BJH_SYNC_STATE_FILE = path.join(__dirname, '..', 'bjh-sync-state.json');
const LEGACY_BJH_SYNC_STATE_FILE = path.join(__dirname, '..', '.bjh-sync-state.json');
const LOCAL_SYNC_ROOT_DIR = path.join(__dirname, '..', 'archive', 'notion-sync');

function readStateJson(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, data: {} };

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw.trim()) {
      throw new Error('文件为空');
    }
    return { exists: true, data: JSON.parse(raw) };
  } catch (e) {
    return { exists: true, error: e };
  }
}

function resolveBjhSyncStateFile() {
  const primary = readStateJson(BJH_SYNC_STATE_FILE);
  if (primary.exists && !primary.error) {
    return { file: BJH_SYNC_STATE_FILE, data: primary.data };
  }

  const legacy = readStateJson(LEGACY_BJH_SYNC_STATE_FILE);
  if (legacy.exists && !legacy.error) {
    try {
      fs.writeFileSync(BJH_SYNC_STATE_FILE, JSON.stringify(legacy.data, null, 2), 'utf-8');
      console.log('  已迁移百家号同步状态文件到 bjh-sync-state.json');
      return { file: BJH_SYNC_STATE_FILE, data: legacy.data };
    } catch (e) {
      console.error(`⚠ 百家号同步状态文件迁移失败: ${e.message}`);
      return { file: LEGACY_BJH_SYNC_STATE_FILE, data: legacy.data };
    }
  }

  if (primary.error) {
    console.error(`⚠ 百家号同步状态文件解析失败: ${primary.error.message}`);
  }
  if (legacy.error) {
    console.error(`⚠ 旧百家号同步状态文件解析失败: ${legacy.error.message}`);
  }

  return { file: BJH_SYNC_STATE_FILE, data: {} };
}

function sanitizeFileName(value) {
  return String(value || '')
    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9-_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'untitled';
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadBjhSyncState() {
  return resolveBjhSyncStateFile().data;
}

function saveBjhSyncState(state) {
  const { file } = resolveBjhSyncStateFile();
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8');
}

function getBjhSyncStateFile() {
  return resolveBjhSyncStateFile().file;
}

function buildNotionPageUrl(pageId) {
  return `https://www.notion.so/${String(pageId).replace(/-/g, '')}`;
}

function getWorkSyncDir(workName) {
  const dir = path.join(LOCAL_SYNC_ROOT_DIR, workName);
  ensureDir(dir);
  return dir;
}

function buildLocalMarkdownPath(workName, pageId, title) {
  const shortId = String(pageId).replace(/-/g, '').slice(0, 8);
  const safeTitle = sanitizeFileName(title);
  return path.join(getWorkSyncDir(workName), `${shortId}-${safeTitle}.md`);
}

function readLocalMarkdown(filePath) {
  return fs.readFileSync(filePath, 'utf-8');
}

function createStateEntry({ existing, pageId, title, workName, localFile }) {
  const nextStatus = existing?.status === 'published' ? 'published' : 'synced';
  const entry = {
    ...(existing || {}),
    title,
    work: workName,
    notion_page_id: pageId,
    notion_page_url: buildNotionPageUrl(pageId),
    local_file: localFile,
    synced_at: new Date().toISOString(),
    status: nextStatus,
  };

  if (nextStatus !== 'publish_failed') {
    delete entry.last_error;
  }

  return entry;
}

async function ensureLocalMarkdownSynced({
  pageId,
  pageTitle,
  workName,
  allowedGroups,
  imageDir = DEFAULT_IMAGE_DIR,
  autoImages = true,
  state,
}) {
  const existing = state?.[pageId];
  if (existing?.local_file && fs.existsSync(existing.local_file)) {
    return {
      pageId,
      title: existing.title || pageTitle,
      markdown: readLocalMarkdown(existing.local_file),
      localFile: existing.local_file,
      imageStats: { matched: [], missing: [] },
      reused: true,
      stateEntry: existing,
    };
  }

  const page = await fetchNotionPage(buildNotionPageUrl(pageId));
  const title = page.title || pageTitle || '未命名';
  let markdown = page.markdown;
  let imageStats = { matched: [], missing: [] };

  if (autoImages) {
    const result = await insertImages(markdown, path.resolve(imageDir), workName, allowedGroups);
    markdown = result.article;
    imageStats = result.imageStats;
  }

  const localFile = buildLocalMarkdownPath(workName, pageId, title);
  if (existing?.local_file && existing.local_file !== localFile && fs.existsSync(existing.local_file)) {
    try { fs.unlinkSync(existing.local_file); } catch {}
  }
  fs.writeFileSync(localFile, markdown, 'utf-8');

  return {
    pageId,
    title,
    markdown,
    localFile,
    imageStats,
    reused: false,
    stateEntry: createStateEntry({ existing, pageId, title, workName, localFile }),
  };
}

async function syncNotionWorkToLocal(workName, workConfig, opts = {}) {
  const imageDir = path.resolve(opts.images || DEFAULT_IMAGE_DIR);
  const allowedGroups = workConfig.image_dirs || [workName];
  const intervalMs = parseInt(opts.interval || '15', 10) * 1000;

  console.log(`\n${'='.repeat(50)}`);
  console.log(`  同步本地 Markdown: ${workName}`);
  console.log('='.repeat(50));

  let childPages;
  try {
    childPages = await fetchNotionDirectory(workConfig.notionUrl);
  } catch (e) {
    console.error(`获取目录页失败: ${e.message}`);
    return { success: 0, fail: 1, skipped: 0, total: 0 };
  }

  if (!childPages.length) {
    console.log('目录页中没有子页面');
    return { success: 0, fail: 0, skipped: 0, total: 0 };
  }

  const state = loadBjhSyncState();
  const skipped = [];
  const pending = [];

  for (const child of childPages) {
    const existing = state[child.id];
    if (existing?.local_file && fs.existsSync(existing.local_file)) {
      skipped.push(child);
    } else {
      pending.push(child);
    }
  }

  if (skipped.length) {
    console.log(`\n已同步到本地 ${skipped.length} 篇（跳过）`);
  }

  if (!pending.length) {
    console.log('\n没有新的 Notion 页面需要同步到本地');
    return { success: 0, fail: 0, skipped: skipped.length, total: childPages.length };
  }

  let success = 0;
  let fail = 0;

  for (let i = 0; i < pending.length; i++) {
    const child = pending[i];
    if (i > 0) {
      console.log(`等待 ${opts.interval || '15'} 秒...`);
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  [${i + 1}/${pending.length}] ${child.title}`);
    console.log('─'.repeat(50));

    try {
      const result = await ensureLocalMarkdownSynced({
        pageId: child.id,
        pageTitle: child.title,
        workName,
        allowedGroups,
        imageDir,
        autoImages: opts.autoImages !== false,
        state,
      });

      state[child.id] = result.stateEntry;
      saveBjhSyncState(state);
      success++;

      console.log(`  ✓ 已同步到本地: ${path.relative(path.join(__dirname, '..'), result.localFile)}`);
      if (result.imageStats.missing.length) {
        console.log(`  缺失: ${result.imageStats.missing.join('、')}`);
      }
    } catch (e) {
      fail++;
      console.error(`  ✗ 同步失败: ${e.message}`);
    }
  }

  return { success, fail, skipped: skipped.length, total: childPages.length };
}

module.exports = {
  BJH_SYNC_STATE_FILE,
  LOCAL_SYNC_ROOT_DIR,
  loadBjhSyncState,
  saveBjhSyncState,
  getBjhSyncStateFile,
  buildNotionPageUrl,
  buildLocalMarkdownPath,
  readLocalMarkdown,
  ensureLocalMarkdownSynced,
  syncNotionWorkToLocal,
};
