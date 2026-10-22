/**
 * Markdown 文章处理工具。
 * AI 输出的图片标记可能混用半角/全角或不同类型的括号，先在这里统一。
 */

const ALT_OPEN_CHARS = new Set(['[', '【', '(', '（']);
const ALT_CLOSE_CHARS = new Set([']', '】', ')', '）']);
const DEST_OPEN_CHARS = new Set(['(', '（', '[', '【']);
const DEST_CLOSE_CHARS = new Set([')', '）', ']', '】']);

/**
 * 解析从 start 开始的图片标记。允许 !/！、括号类型和左右括号混用。
 * @returns {{start:number,end:number,alt:string,ref:string,raw:string}|null}
 */
function parseImageMarkerAt(markdown, start) {
  const text = String(markdown || '');
  let cursor = start;
  if (text[cursor] === '!' || text[cursor] === '！') {
    cursor += 1;
  } else {
    return null;
  }

  if (!ALT_OPEN_CHARS.has(text[cursor])) return null;
  const altStart = cursor + 1;
  let altEnd = altStart;
  while (altEnd < text.length && !ALT_CLOSE_CHARS.has(text[altEnd])) altEnd += 1;
  if (altEnd >= text.length) return null;

  cursor = altEnd + 1;
  while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t')) cursor += 1;
  if (!DEST_OPEN_CHARS.has(text[cursor])) return null;

  const refStart = cursor + 1;
  const stack = [text[cursor]];
  cursor = refStart;
  while (cursor < text.length) {
    const char = text[cursor];
    if (DEST_OPEN_CHARS.has(char)) {
      stack.push(char);
    } else if (DEST_CLOSE_CHARS.has(char)) {
      stack.pop();
      if (!stack.length) {
        return {
          start,
          end: cursor + 1,
          alt: text.slice(altStart, altEnd).trim(),
          ref: text.slice(refStart, cursor).trim(),
          raw: text.slice(start, cursor + 1),
        };
      }
    }
    cursor += 1;
  }

  return null;
}

function replaceImageMarkers(markdown, replacer) {
  const text = String(markdown || '');
  let result = '';
  let cursor = 0;

  while (cursor < text.length) {
    const asciiBang = text.indexOf('!', cursor);
    const fullwidthBang = text.indexOf('！', cursor);
    const bang = asciiBang === -1
      ? fullwidthBang
      : fullwidthBang === -1 ? asciiBang : Math.min(asciiBang, fullwidthBang);
    if (bang === -1) {
      result += text.slice(cursor);
      break;
    }

    result += text.slice(cursor, bang);
    const marker = parseImageMarkerAt(text, bang);
    if (!marker) {
      result += text[bang];
      cursor = bang + 1;
      continue;
    }

    result += replacer(marker);
    cursor = marker.end;
  }

  return result;
}

function normalizeImageMarkers(markdown) {
  return replaceImageMarkers(markdown, marker => `![${marker.alt}](${marker.ref})`);
}

function removeImageMarkers(markdown) {
  return replaceImageMarkers(markdown, () => '');
}

function isListLine(line) {
  return /^\s*(?:[-*+]\s+|\d+[.)、]\s*)/.test(line);
}

function isBlockLine(line) {
  return /^\s*(?:#{1,6}\s|!\s*[\[【(（])/.test(line);
}

/**
 * 补齐 AI 输出中被省略的 Markdown 段落空行，避免多个自然段被 marked 合并成一个 <p>。
 * 已有空行和列表结构保持不变；超长单行正文按句末标点拆成适中段落。
 */
function normalizeMarkdownParagraphs(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const expanded = [];

  for (const line of lines) {
    if (!line.trim() || isBlockLine(line) || isListLine(line) || line.length <= 420) {
      expanded.push(line);
      continue;
    }

    const sentences = line.match(/[^。！？!?；;]+[。！？!?；;]?/g) || [line];
    let paragraph = '';
    for (const sentence of sentences) {
      paragraph += sentence;
      if (paragraph.length >= 180 || paragraph.length + sentence.length >= 360) {
        expanded.push(paragraph.trim());
        paragraph = '';
      }
    }
    if (paragraph.trim()) expanded.push(paragraph.trim());
  }

  const result = [];
  for (const line of expanded) {
    const current = line.trim();
    if (!current) {
      if (result.length && result[result.length - 1] !== '') result.push('');
      continue;
    }

    const previous = result[result.length - 1];
    if (previous && !isListLine(previous) && !isListLine(current)) result.push('');
    result.push(line);
  }

  return result.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// 武侠百晓通每段两三句、五十五到七十字，几乎不超过一百字
const PARAGRAPH_SOFT_MAX = 75;
const PARAGRAPH_HARD_MAX = 100;
const PARAGRAPH_MIN_TO_BREAK = 45;
const SENTENCE_PATTERN = /[^。！？!?]+(?:[。！？!?]+[”’」』）)]*)?/g;
const CJK = '\\u4e00-\\u9fff，。！？；：“”‘’、（）《》…';
const SPACE_BETWEEN_CJK = new RegExp(`([${CJK}])[ \\t\\u3000]+(?=[${CJK}])`, 'g');

function visibleLength(text) {
  return String(text || '').replace(/\s/g, '').length;
}

/** 引号、括号都已经配对，说明停在这里不会把一句引语或括注切成两段 */
function isBalanced(text) {
  const count = ch => text.split(ch).length - 1;
  return count('“') === count('”') && count('（') === count('）') && count('「') === count('」');
}

function splitParagraphLine(line) {
  const sentences = line.match(SENTENCE_PATTERN) || [line];
  const groups = [];
  let current = '';
  for (const sentence of sentences) {
    const next = current + sentence;
    const tooLong = visibleLength(next) > PARAGRAPH_HARD_MAX
      || (visibleLength(current) >= PARAGRAPH_MIN_TO_BREAK && visibleLength(next) > PARAGRAPH_SOFT_MAX);
    if (current && tooLong && isBalanced(current)) {
      groups.push(current);
      current = sentence;
    } else {
      current = next;
    }
  }
  if (current) groups.push(current);
  // 切出来的最后一小截太短，并回上一段
  const last = groups[groups.length - 1];
  if (groups.length > 1 && visibleLength(last) < 20 && visibleLength(groups[groups.length - 2] + last) <= PARAGRAPH_HARD_MAX) {
    groups.pop();
    groups[groups.length - 1] += last;
  }
  return groups.map(group => group.trim()).filter(Boolean);
}

/**
 * 按武侠百晓通的段落规矩整理正文：超过一百字的段落在句末标点处切开，每段两三句；
 * 不在引号、括号中间切，标题、配图、列表、“（原文）”段不动；只加换行、去掉中文之间多余的空格，不改字
 */
function splitLongParagraphs(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const output = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || isBlockLine(trimmed) || isListLine(trimmed) || /^>/.test(trimmed) || /^[（(]原文[）)]/.test(trimmed)) {
      output.push(line);
      continue;
    }
    const cleaned = trimmed.replace(SPACE_BETWEEN_CJK, '$1');
    if (visibleLength(cleaned) <= PARAGRAPH_HARD_MAX) {
      output.push(cleaned);
      continue;
    }
    output.push(splitParagraphLine(cleaned).join('\n\n'));
  }
  return output.join('\n').replace(/\n{3,}/g, '\n\n');
}

const IMAGE_ONLY_LINE = /^\s*!\[[^\]]*\]\([^\n]*\)\s*$/;

function isTextParagraphLine(line) {
  const trimmed = line.trim();
  return Boolean(trimmed) && !/^#{1,6}\s/.test(trimmed) && !IMAGE_ONLY_LINE.test(trimmed);
}

/** 统计正文配图数量，尾图不计入 */
function countInlineImages(markdown) {
  let count = 0;
  replaceImageMarkers(markdown, marker => {
    if (marker.alt !== '尾图') count += 1;
    return marker.raw;
  });
  return count;
}

/**
 * 封面图补进正文时的插入位置：有 ## 小标题时放在第一个小标题后；
 * 没有小标题时放在第二个正文段落之后，避免紧贴在文章标题下面。
 * @returns {number} 插入位置（字符下标），找不到合适位置返回 -1
 */
function findInlineCoverInsertPosition(markdown) {
  const text = String(markdown || '');
  const heading = text.match(/^##\s.*$/m);
  if (heading) return heading.index + heading[0].length;

  let offset = 0;
  let seen = 0;
  for (const line of text.split('\n')) {
    offset += line.length + 1;
    if (!isTextParagraphLine(line)) continue;
    seen += 1;
    if (seen === 2) return Math.min(offset - 1, text.length);
  }
  return -1;
}

/**
 * 按版式规则整理正文配图：总数封顶、开头和结尾留白、两图之间保持间隔。
 * 超出上限时在合格的配图里均匀挑选，避免图片全挤在前半篇。
 * @param {string} markdown 已统一过图片标记的 Markdown
 * @param {{maxImages?:number, skipHead?:number, skipTail?:number, minGap?:number}} [options]
 *   skipHead/skipTail 为开头、结尾不放图的正文段落数，minGap 为两图之间至少间隔的正文段落数
 * @returns {{markdown:string, kept:number, removed:number}}
 */
function arrangeInlineImages(markdown, options = {}) {
  const { maxImages = 5, skipHead = 2, skipTail = 3, minGap = 3 } = options;

  // 夹在正文里的图片标记先拆成独立段落，便于按段落计位置
  const lines = [];
  for (const line of normalizeImageMarkers(markdown).split('\n')) {
    if (IMAGE_ONLY_LINE.test(line) || !line.includes('![')) {
      lines.push(line);
      continue;
    }
    const markers = [];
    const textPart = replaceImageMarkers(line, marker => {
      markers.push(marker.raw);
      return '';
    }).trim();
    if (textPart) lines.push(textPart);
    markers.forEach(raw => lines.push('', raw, ''));
  }

  const totalText = lines.filter(isTextParagraphLine).length;
  const images = [];
  let textBefore = 0;
  lines.forEach((line, index) => {
    if (isTextParagraphLine(line)) {
      textBefore += 1;
    } else if (IMAGE_ONLY_LINE.test(line)) {
      images.push({ index, textBefore, textAfter: totalText - textBefore, ref: line.trim() });
    }
  });

  const seenRefs = new Set();
  let eligible = images.filter(image => {
    if (image.textBefore < skipHead || image.textAfter < skipTail) return false;
    if (seenRefs.has(image.ref)) return false;
    seenRefs.add(image.ref);
    return true;
  });

  if (eligible.length > maxImages) {
    const picked = new Set();
    for (let i = 0; i < maxImages; i++) {
      picked.add(Math.round((i * (eligible.length - 1)) / Math.max(1, maxImages - 1)));
    }
    eligible = eligible.filter((_, i) => picked.has(i));
  }

  const keep = new Set();
  let lastKept = null;
  for (const image of eligible) {
    if (lastKept !== null && image.textBefore - lastKept < minGap) continue;
    keep.add(image.index);
    lastKept = image.textBefore;
  }

  const result = lines
    .filter((line, index) => !IMAGE_ONLY_LINE.test(line) || keep.has(index))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { markdown: result, kept: keep.size, removed: images.length - keep.size };
}

/**
 * 移除正文中的英文字母。图片目标保留，否则会破坏本地素材路径或远程地址。
 * 常见的 VS 先转成中文，避免删除后改变标题语义。
 */
function removeEnglishFromArticle(markdown) {
  const normalized = normalizeImageMarkers(markdown);
  const sanitize = value => value.replace(/V\s*\.?\s*S\s*\.?/gi, '对战').replace(/[A-Za-z]/g, '');
  let result = '';
  let cursor = 0;
  while (cursor < normalized.length) {
    const asciiBang = normalized.indexOf('!', cursor);
    const fullwidthBang = normalized.indexOf('！', cursor);
    const bang = asciiBang === -1
      ? fullwidthBang
      : fullwidthBang === -1 ? asciiBang : Math.min(asciiBang, fullwidthBang);
    if (bang === -1) {
      result += sanitize(normalized.slice(cursor));
      break;
    }
    result += sanitize(normalized.slice(cursor, bang));
    const marker = parseImageMarkerAt(normalized, bang);
    if (!marker) {
      result += sanitize(normalized[bang]);
      cursor = bang + 1;
      continue;
    }
    const alt = sanitize(marker.alt);
    result += `![${alt}](${marker.ref})`;
    cursor = marker.end;
  }
  return result;
}

module.exports = {
  parseImageMarkerAt,
  replaceImageMarkers,
  normalizeImageMarkers,
  removeImageMarkers,
  normalizeMarkdownParagraphs,
  splitLongParagraphs,
  removeEnglishFromArticle,
  countInlineImages,
  findInlineCoverInsertPosition,
  arrangeInlineImages,
};
