/**
 * Notion 公开页面内容抓取
 * 通过 Notion 内部 API 获取公开分享页面的内容，转换为 Markdown
 */

const axios = require('axios');

const client = axios.create({
  headers: {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  },
  timeout: 30000,
});

/**
 * 从 Notion URL 提取 Page ID（UUID 格式）
 * 支持格式:
 *   https://www.notion.so/workspace/Title-abc123...
 *   https://notion.site/Title-abc123...
 *   https://www.notion.so/abc123...
 */
function extractPageId(url) {
  const cleaned = url.split('?')[0].split('#')[0];
  const parts = cleaned.split('/');
  const last = parts[parts.length - 1];

  // 提取末尾的 32 位 hex（Notion page ID）
  const match = last.match(/([0-9a-f]{32})$/i) || last.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (!match) {
    throw new Error(`无法从 URL 中提取 Notion Page ID: ${url}`);
  }

  let id = match[1].replace(/-/g, '');
  // 转为 UUID 格式
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

/**
 * 解析 Notion 富文本格式 → 纯文本/Markdown
 * Notion 格式: [["text", [["b"], ["i"], ["a", "url"]]], ["plain text"]]
 */
function parseRichText(richTextArr) {
  if (!richTextArr || !Array.isArray(richTextArr)) return '';

  return richTextArr.map(segment => {
    if (!Array.isArray(segment)) return '';
    const text = segment[0] || '';
    const decorations = segment[1] || [];

    let result = text;
    for (const dec of decorations) {
      if (!Array.isArray(dec)) continue;
      switch (dec[0]) {
        case 'b': result = `**${result}**`; break;
        case 'i': result = `*${result}*`; break;
        case 's': result = `~~${result}~~`; break;
        case 'c': result = `\`${result}\``; break;
        case 'a': result = `[${result}](${dec[1]})`; break;
        // 颜色、高亮等忽略
      }
    }
    return result;
  }).join('');
}

/**
 * 将 Notion 块列表转为 Markdown
 */
function blocksToMarkdown(blockIds, allBlocks, depth = 0) {
  if (!blockIds || !blockIds.length) return '';

  const lines = [];
  let numberedIdx = 0;

  for (const blockId of blockIds) {
    const block = allBlocks[blockId]?.value;
    if (!block) continue;

    const text = parseRichText(block.properties?.title);
    const children = block.content || [];
    const indent = '  '.repeat(depth);

    switch (block.type) {
      case 'text':
        if (text) {
          lines.push(`${indent}${text}`);
          lines.push('');  // 段落间空行，确保 Markdown 解析为独立 <p>
        } else {
          lines.push('');
        }
        numberedIdx = 0;
        break;

      case 'header':
        lines.push(`\n# ${text}`);
        numberedIdx = 0;
        break;

      case 'sub_header':
        lines.push(`\n## ${text}`);
        numberedIdx = 0;
        break;

      case 'sub_sub_header':
        lines.push(`\n### ${text}`);
        numberedIdx = 0;
        break;

      case 'bulleted_list':
        lines.push(`${indent}- ${text}`);
        break;

      case 'numbered_list':
        numberedIdx++;
        lines.push(`${indent}${numberedIdx}. ${text}`);
        break;

      case 'quote':
        if (text) {
          text.split('\n').forEach(line => lines.push(`${indent}> ${line}`));
        }
        numberedIdx = 0;
        break;

      case 'code': {
        const lang = block.properties?.language?.[0]?.[0] || '';
        lines.push(`\n\`\`\`${lang}`);
        lines.push(text);
        lines.push('```\n');
        numberedIdx = 0;
        break;
      }

      case 'divider':
        lines.push('\n---\n');
        numberedIdx = 0;
        break;

      case 'image': {
        const src = block.properties?.source?.[0]?.[0]
          || block.format?.display_source
          || '';
        if (src) {
          const caption = parseRichText(block.properties?.caption) || '';
          lines.push(`\n![${caption}](${src})\n`);
        }
        numberedIdx = 0;
        break;
      }

      case 'callout': {
        const icon = block.format?.page_icon || '';
        lines.push(`\n> ${icon} ${text}\n`);
        numberedIdx = 0;
        break;
      }

      case 'to_do': {
        const checked = block.properties?.checked?.[0]?.[0] === 'Yes';
        lines.push(`${indent}- [${checked ? 'x' : ' '}] ${text}`);
        break;
      }

      case 'toggle':
        lines.push(`\n**${text}**\n`);
        numberedIdx = 0;
        break;

      case 'column_list':
      case 'column':
        // 多栏布局：直接展平子内容
        break;

      case 'table_of_contents':
      case 'breadcrumb':
      case 'equation':
        // 跳过这些特殊块
        break;

      default:
        if (text) lines.push(`${indent}${text}`);
        break;
    }

    // 递归处理子块
    if (children.length && block.type !== 'code') {
      const childMd = blocksToMarkdown(children, allBlocks, depth + (block.type === 'bulleted_list' || block.type === 'numbered_list' ? 1 : 0));
      if (childMd) lines.push(childMd);
    }
  }

  return lines.join('\n');
}

/**
 * 获取 Notion 公开页面内容
 * @param {string} notionUrl Notion 公开分享链接
 * @returns {{ title: string, markdown: string, images: string[] }}
 */
async function fetchNotionPage(notionUrl) {
  const pageId = extractPageId(notionUrl);
  console.log(`Notion Page ID: ${pageId}`);

  // 获取页面数据
  const { data } = await client.post('https://www.notion.so/api/v3/loadPageChunk', {
    pageId,
    limit: 200,
    cursor: { stack: [] },
    chunkNumber: 0,
    verticalColumns: false,
  });

  if (!data.recordMap?.block) {
    throw new Error('无法获取 Notion 页面内容，请确认链接已公开分享');
  }

  const blocks = data.recordMap.block;
  const pageBlock = blocks[pageId]?.value;
  if (!pageBlock) {
    throw new Error('页面块不存在，请检查 URL 是否正确');
  }

  // 提取标题
  const title = parseRichText(pageBlock.properties?.title) || '未命名';

  // 转换为 Markdown
  const contentBlockIds = pageBlock.content || [];
  const markdown = blocksToMarkdown(contentBlockIds, blocks);

  // 收集所有 Notion 图片 URL
  const images = [];
  for (const id of Object.keys(blocks)) {
    const b = blocks[id]?.value;
    if (b?.type === 'image') {
      const src = b.properties?.source?.[0]?.[0] || b.format?.display_source || '';
      if (src) images.push(src);
    }
  }

  console.log(`  标题: ${title}`);
  console.log(`  内容块: ${contentBlockIds.length} 个`);
  console.log(`  Notion 图片: ${images.length} 张`);

  return { pageId, title, markdown: markdown.trim(), images };
}

/**
 * 获取 Notion 目录页的所有子页面列表（支持分页加载）
 * @param {string} notionUrl Notion 目录页公开分享链接
 * @returns {Promise<{ id: string, title: string }[]>} 子页面列表（按页面中出现的顺序）
 */
async function fetchNotionDirectory(notionUrl) {
  const pageId = extractPageId(notionUrl);
  console.log(`Notion 目录页 ID: ${pageId}`);

  // 分页加载所有块数据
  const allBlocks = {};
  let cursor = { stack: [] };
  let chunkNumber = 0;

  while (true) {
    const { data } = await client.post('https://www.notion.so/api/v3/loadPageChunk', {
      pageId,
      limit: 100,
      cursor,
      chunkNumber,
      verticalColumns: false,
    });

    if (!data.recordMap?.block) {
      if (chunkNumber === 0) {
        throw new Error('无法获取 Notion 目录页内容，请确认链接已公开分享');
      }
      break;
    }

    const blocks = data.recordMap.block;
    for (const [id, val] of Object.entries(blocks)) {
      allBlocks[id] = val;
    }

    // 检查是否还有更多数据
    if (!data.cursor || JSON.stringify(data.cursor) === JSON.stringify({ stack: [] })) {
      break;
    }
    cursor = data.cursor;
    chunkNumber++;
  }

  const pageBlock = allBlocks[pageId]?.value;
  if (!pageBlock) {
    throw new Error('目录页块不存在，请检查 URL 是否正确');
  }

  const dirTitle = parseRichText(pageBlock.properties?.title) || '未命名目录';
  const contentBlockIds = pageBlock.content || [];

  const childPages = [];
  for (const blockId of contentBlockIds) {
    const block = allBlocks[blockId]?.value;
    if (!block || block.type !== 'page') continue;

    const title = parseRichText(block.properties?.title) || '未命名';
    childPages.push({ id: blockId, title });
  }

  console.log(`目录: ${dirTitle}`);
  console.log(`子页面: ${childPages.length} 篇`);
  childPages.forEach((p, i) => console.log(`  ${i + 1}. ${p.title}`));

  return childPages;
}

module.exports = { fetchNotionPage, fetchNotionDirectory, extractPageId };
