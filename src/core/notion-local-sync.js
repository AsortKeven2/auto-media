const fs = require('fs');
const path = require('path');

const { fetchNotionPage } = require('./notion-fetcher');
const { insertImages } = require('./article-generator');
const { DEFAULT_IMAGE_DIR } = require('./batch-publish');
const { normalizeMarkdownLocalImagePaths } = require('./local-file-utils');

const REPO_ROOT_DIR = path.join(__dirname, '../..');
const BJH_SYNC_STATE_FILE = path.join(__dirname, '../..', 'bjh-sync-state.json');
const LEGACY_BJH_SYNC_STATE_FILE = path.join(__dirname, '../..', '.bjh-sync-state.json');
const LOCAL_SYNC_ROOT_DIR = path.join(__dirname, '../..', 'archive', 'notion-sync');

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

function toPortableLocalFilePath(filePath) {
  return path.relative(REPO_ROOT_DIR, filePath);
}

function resolveStoredLocalFile(entry) {
  if (!entry || !entry.work) return null;

  const candidates = [];
  const raw = entry.local_file;
  if (raw) {
    if (path.isAbsolute(raw)) {
      candidates.push(raw);
      candidates.push(path.join(getWorkSyncDir(entry.work), path.basename(raw)));
    } else {
      candidates.push(path.join(REPO_ROOT_DIR, raw));
      candidates.push(path.join(getWorkSyncDir(entry.work), path.basename(raw)));
    }
  }

  if (entry.notion_page_id && entry.title) {
    candidates.push(buildLocalMarkdownPath(entry.work, entry.notion_page_id, entry.title));
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function normalizeStateEntries(state) {
  let changed = false;

  for (const entry of Object.values(state)) {
    if (!entry || !entry.work) continue;
    const resolved = resolveStoredLocalFile(entry);
    if (!resolved) continue;

    const portable = toPortableLocalFilePath(resolved);
    if (entry.local_file !== portable) {
      entry.local_file = portable;
      changed = true;
    }
  }

  return { state, changed };
}

function loadBjhSyncState() {
  const resolved = resolveBjhSyncStateFile();
  const normalized = normalizeStateEntries(resolved.data || {});
  if (normalized.changed) {
    fs.writeFileSync(resolved.file, JSON.stringify(normalized.state, null, 2), 'utf-8');
  }
  return normalized.state;
}

function saveBjhSyncState(state) {
  const { file } = resolveBjhSyncStateFile();
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8');
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
  const raw = fs.readFileSync(filePath, 'utf-8');
  const normalized = normalizeMarkdownLocalImagePaths(raw);
  if (normalized.changed) {
    fs.writeFileSync(filePath, normalized.markdown, 'utf-8');
  }
  return normalized.markdown;
}

function createStateEntry({ existing, pageId, title, workName, localFile, accountName }) {
  const nextStatus = existing?.status === 'published' ? 'published' : 'synced';
  const entry = {
    ...(existing || {}),
    title,
    work: workName,
    notion_page_id: pageId,
    notion_page_url: buildNotionPageUrl(pageId),
    local_file: toPortableLocalFilePath(localFile),
    synced_at: new Date().toISOString(),
    status: nextStatus,
  };

  if (accountName) {
    entry.account = accountName;
  }

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
  accountName,
}) {
  const existing = state?.[pageId];
  const resolvedExistingLocalFile = resolveStoredLocalFile(existing);
  if (resolvedExistingLocalFile) {
    return {
      pageId,
      title: existing.title || pageTitle,
      markdown: readLocalMarkdown(resolvedExistingLocalFile),
      localFile: resolvedExistingLocalFile,
      imageStats: { matched: [], missing: [] },
      reused: true,
      stateEntry: createStateEntry({
        existing,
        pageId,
        title: existing.title || pageTitle,
        workName,
        localFile: resolvedExistingLocalFile,
        accountName,
      }),
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

  markdown = normalizeMarkdownLocalImagePaths(markdown).markdown;

  const localFile = buildLocalMarkdownPath(workName, pageId, title);
  const oldFile = resolveStoredLocalFile(existing);
  if (oldFile && oldFile !== localFile) {
    try { fs.unlinkSync(oldFile); } catch {}
  }
  fs.writeFileSync(localFile, markdown, 'utf-8');

  return {
    pageId,
    title,
    markdown,
    localFile,
    imageStats,
    reused: false,
    stateEntry: createStateEntry({ existing, pageId, title, workName, localFile, accountName }),
  };
}

module.exports = {
  loadBjhSyncState,
  saveBjhSyncState,
  ensureLocalMarkdownSynced,
};
