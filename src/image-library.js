/**
 * 图片素材库 - 扫描素材目录 + 封面选择
 */

const fs = require('fs');
const path = require('path');
const { imageSize } = require('image-size');

const EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

/**
 * 扫描目录下所有图片，返回 [{ filePath, fileName }]
 */
function scanImages(imageDir) {
  const images = [];

  function walk(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else if (EXTS.includes(path.extname(entry.name).toLowerCase())) {
        images.push({
          filePath: path.join(dir, entry.name),
          fileName: rel,
        });
      }
    }
  }

  walk(imageDir, '');
  return images;
}

/**
 * 按子目录分组列出图片文件名（供 AI prompt 使用）
 */
function listImagesByGroup(imageDir) {
  const images = scanImages(imageDir);
  const groups = {};

  for (const img of images) {
    const parts = img.fileName.split('/');
    const group = parts.length > 1 ? parts[0] : '根目录';
    if (!groups[group]) groups[group] = [];
    groups[group].push(img.fileName);
  }

  return groups;
}

/**
 * 构建 fileName → filePath 映射
 */
function buildImageMap(imageDir) {
  const images = scanImages(imageDir);
  const map = {};
  for (const img of images) {
    map[img.fileName] = img.filePath;
  }
  return map;
}

/**
 * 通用封面选择（所有平台共用）
 *
 * 优先级：
 *   1. 标题中提到的角色 → 从图库找图（需要单独上传，如果文中没出现则需插入）
 *   2. 文中已有配图 → 选比例最接近 3:2 的
 *
 * @param {object} options
 * @param {string}   options.title               文章标题
 * @param {string}   [options.imageDir]          图片素材根目录
 * @param {string}   [options.workFilter]        限定匹配的作品子目录（如"三国演义"）
 * @param {string[]} [options.articleImagePaths]  文章正文中的配图路径列表
 * @returns {{ coverPath: string|null, fromLibrary: boolean, charName: string }}
 */
function selectCoverImage(options = {}) {
  const {
    title = '',
    imageDir,
    workFilter,
    articleImagePaths = [],
  } = options;

  const TARGET_RATIO = 3 / 2;

  // 从候选图片中选比例接近 3:2 的，在可接受范围内随机选一张
  function pickBestRatio(candidates) {
    const ACCEPTABLE_DIFF = 0.3; // 比例差在此范围内均可接受
    const scored = [];
    for (const imgPath of candidates) {
      try {
        const buf = fs.readFileSync(imgPath);
        const dim = imageSize(buf);
        if (dim.width && dim.height) {
          const diff = Math.abs(dim.width / dim.height - TARGET_RATIO);
          scored.push({ imgPath, diff });
        }
      } catch {}
    }
    if (scored.length === 0) return null;
    scored.sort((a, b) => a.diff - b.diff);
    const threshold = Math.max(scored[0].diff + ACCEPTABLE_DIFF, ACCEPTABLE_DIFF);
    const acceptable = scored.filter(s => s.diff <= threshold);
    return acceptable[Math.floor(Math.random() * acceptable.length)].imgPath;
  }

  // 第一优先：从标题中提取角色名，在图库中查找
  if (title && imageDir && fs.existsSync(imageDir)) {
    const allImgs = scanImages(imageDir);

    // 构建角色名 → 图片路径映射（按作品过滤）
    const charMap = {};
    for (const img of allImgs) {
      const parts = img.fileName.split('/');
      const work = parts.length > 1 ? parts[0] : '';
      if (workFilter && work && work !== workFilter) continue;
      const basename = path.basename(img.fileName, path.extname(img.fileName));
      const charName = basename.replace(/\d+$/, '');
      if (charName.length < 2) continue;
      if (!charMap[charName]) charMap[charName] = [];
      charMap[charName].push(img.filePath);
    }

    // 长名优先匹配标题（避免短名误匹配）
    const charNames = Object.keys(charMap).sort((a, b) => b.length - a.length);
    for (const charName of charNames) {
      if (title.includes(charName)) {
        const best = pickBestRatio(charMap[charName]);
        if (best) {
          console.log(`封面匹配标题角色「${charName}」，候选 ${charMap[charName].length} 张`);
          return { coverPath: best, fromLibrary: true, charName };
        }
      }
    }
  }

  // 第二优先：从文中已有配图中选比例最接近 3:2 的
  if (articleImagePaths.length > 0) {
    const best = pickBestRatio(articleImagePaths);
    if (best) {
      return { coverPath: best, fromLibrary: false, charName: '' };
    }
  }

  return { coverPath: null, fromLibrary: false, charName: '' };
}

module.exports = { scanImages, listImagesByGroup, buildImageMap, selectCoverImage };
