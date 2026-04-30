const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '../..');

function toPortableProjectPath(filePath) {
  return path.relative(PROJECT_ROOT, filePath).replace(/\\/g, '/');
}

function resolveProjectFile(ref) {
  if (!ref) return null;

  const raw = String(ref).trim();
  if (!raw) return null;

  if (path.isAbsolute(raw) && fs.existsSync(raw)) {
    return raw;
  }

  if (fs.existsSync(raw)) {
    return path.resolve(raw);
  }

  const rootRelative = path.join(PROJECT_ROOT, raw.replace(/^\.?\//, ''));
  if (fs.existsSync(rootRelative)) {
    return rootRelative;
  }

  const normalized = raw.replace(/\\/g, '/');
  for (const marker of ['/images/', '/archive/notion-sync/', 'images/', 'archive/notion-sync/']) {
    const idx = normalized.indexOf(marker);
    if (idx === -1) continue;
    const rel = marker.startsWith('/') ? normalized.slice(idx + 1) : normalized.slice(idx);
    const candidate = path.join(PROJECT_ROOT, rel);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function normalizeMarkdownLocalImagePaths(markdown) {
  let changed = false;

  const normalized = String(markdown || '').replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (full, alt, src) => {
    const resolved = resolveProjectFile(src);
    if (!resolved) return full;

    const portable = toPortableProjectPath(resolved);
    if (portable === src) return full;
    changed = true;
    return `![${alt}](${portable})`;
  });

  return { markdown: normalized, changed };
}

module.exports = {
  PROJECT_ROOT,
  toPortableProjectPath,
  resolveProjectFile,
  normalizeMarkdownLocalImagePaths,
};
