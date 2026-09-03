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
  removeEnglishFromArticle,
};
