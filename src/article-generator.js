/**
 * AI 文章生成器 - DeepSeek
 * AI 根据可用图片列表，在文章中自主决定插图位置和选择
 */

const fs = require('fs');
const path = require('path');
const { callLLM } = require('./llm');
const { listImagesByGroup } = require('./image-library');
const { getCategory } = require('./categories');

const RANKING_CATEGORY = '数字盘点类';
const RANKING_SELF_CORRECTION_REGEX = /不对[，。！？、… ]|重新来|重新整理|咱们重新|哦对了|等等[，。！？、… ]|推翻重来/;

/**
 * 从标题中识别涉及的作品
 * @param {string} title 文章标题
 * @returns {Promise<string[]>} 涉及的作品列表
 */
async function detectWorksFromTitle(title) {
  const { listWorks } = require('./topic-generator');
  const allWorks = listWorks();
  if (!allWorks.length) return [];

  const prompt = `分析以下标题，判断涉及哪些作品。

可选作品：${allWorks.join('、')}

标题：${title}

要求：
- 如果标题只涉及一个作品，返回该作品
- 如果标题涉及多个作品的角色对比（如"关羽vs武松"），返回所有相关作品
- 只返回JSON数组格式，如：["三国演义"] 或 ["三国演义", "水浒传"]
- 如果无法判断，返回空数组 []`;

  try {
    const result = await callLLM(prompt, { maxTokens: 100 });
    if (!result) return [];

    const jsonMatch = result.match(/\[[\s\S]*?\]/);
    if (!jsonMatch) return [];

    const works = JSON.parse(jsonMatch[0]);
    return Array.isArray(works) ? works : [];
  } catch (e) {
    console.error(`  识别作品失败: ${e.message}`);
    return [];
  }
}

/**
 * 构建去重图片名称列表（只取当前作品，同名只取一个）
 * 如 郭襄/郭襄1/郭襄2 只显示"郭襄"
 * @param {string} imageDir 图片根目录
 * @param {string} work 作品名
 * @param {string[]} [allowedGroups] 允许的图片子目录列表，未指定则仅用 work
 */
function buildImageList(imageDir, work, allowedGroups) {
  const groups = listImagesByGroup(imageDir);
  const dirs = allowedGroups || (work ? [work] : []);
  if (!dirs.length) return '';

  const names = new Set();
  const labels = [];
  for (const dir of dirs) {
    if (!groups[dir]) continue;
    for (const f of groups[dir]) {
      const name = path.basename(f, path.extname(f));
      const base = name.replace(/\d+$/, '') || name;
      names.add(base);
    }
    labels.push(dir);
  }

  if (!names.size) return '';
  return `【${labels.join('+')}】${[...names].sort().join('、')}\n`;
}

function parseRankNumber(raw) {
  const text = String(raw || '').trim();
  if (!text) return NaN;
  if (/^\d+$/.test(text)) return parseInt(text, 10);

  const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (text === '十') return 10;
  if (text.includes('十')) {
    const [tenPart, onePart] = text.split('十');
    const tens = tenPart ? digits[tenPart] : 1;
    const ones = onePart ? digits[onePart] : 0;
    if (typeof tens === 'number' && typeof ones === 'number') {
      return tens * 10 + ones;
    }
  }

  return typeof digits[text] === 'number' ? digits[text] : NaN;
}

function normalizeRankingHeadings(article) {
  return article.replace(
    /^\s*\*\*第([一二三四五六七八九十百零两\d]+)名[：:]\s*(.+?)\*\*\s*$/gm,
    '## 第$1名：$2'
  );
}

function extractRankedName(titleText) {
  const text = String(titleText || '')
    .trim()
    .replace(/^【[^】]+】\s*/, '');

  if (!text) return '';

  const match = text.match(/^(.+?)(?:——|———|--| - |- |：|:|（|\(|，|,|。|\s|$)/);
  return (match ? match[1] : text).trim();
}

function extractRankingItems(article) {
  const items = [];
  const lines = article.split(/\r?\n/);

  lines.forEach((line, idx) => {
    const match = line.trim().match(/^##\s*第([一二三四五六七八九十百零两\d]+)名[：:]\s*(.+)$/);
    if (!match) return;

    items.push({
      rank: parseRankNumber(match[1]),
      rawRank: match[1],
      name: extractRankedName(match[2]),
      line: idx + 1,
    });
  });

  return items;
}

function buildDuplicateList(values, formatter = v => v) {
  const counts = new Map();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }

  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([value]) => formatter(value));
}

function validateRankingArticle(article) {
  const normalizedArticle = normalizeRankingHeadings(article);
  const items = extractRankingItems(normalizedArticle);
  const errors = [];

  if (RANKING_SELF_CORRECTION_REGEX.test(normalizedArticle)) {
    errors.push('文中出现了“不对 / 哦对了 / 重新来”等自我纠正痕迹');
  }

  if (items.length < 3) {
    errors.push(`只识别到 ${items.length} 个规范排名小标题，必须统一使用“## 第X名：角色——点评”`);
  }

  if (items.some(item => !Number.isFinite(item.rank))) {
    errors.push('存在无法识别的名次写法，必须明确写成“第X名”');
  }

  const duplicateRanks = buildDuplicateList(
    items.map(item => item.rank).filter(rank => Number.isFinite(rank)),
    rank => `第${rank}名`
  );
  if (duplicateRanks.length) {
    errors.push(`名次重复：${duplicateRanks.join('、')}`);
  }

  const duplicateNames = buildDuplicateList(items.map(item => item.name).filter(Boolean));
  if (duplicateNames.length) {
    errors.push(`角色重复上榜：${duplicateNames.join('、')}`);
  }

  if (items.length >= 2) {
    const firstGap = items[1].rank - items[0].rank;
    const step = firstGap === 1 ? 1 : firstGap === -1 ? -1 : 0;

    if (!step) {
      errors.push('名次顺序不连续，必须按相邻名次依次展开');
    } else {
      for (let i = 1; i < items.length; i++) {
        if (items[i].rank !== items[i - 1].rank + step) {
          errors.push('名次顺序不连续，必须按相邻名次依次展开');
          break;
        }
      }
    }
  }

  return {
    article: normalizedArticle,
    items,
    valid: errors.length === 0,
    errors,
  };
}

function buildPrompt(topic, outline, work, imageList, category, opts = {}) {
  const catDef = category ? getCategory(category) : null;
  const wordCount = opts.wordCount || (catDef && catDef.maxWords);

  let writingRequirements = catDef
    ? catDef.articlePrompt
    : `要求：
- 字数 {wordCount}
- 不要全是书面语、文学风，不要AI腔，像跟读者聊天而不是写论文
- 段落要有节奏感，大多数段落 150-280 字，过渡设问段可短些，禁止超过 350 字的大段
- 围绕标题疑问拆解，多结合影视名场面展开，描述具体场景要有画面感
- 全文至少 5 处与读者对话：如"你想想""说白了""其实啊""换做是你"
- 只引用影视/原著真实情节和对话，不确定的不要写
- 禁止使用"不难发现""显而易见""综上所述""值得注意的是"等AI套话
- 禁止使用[1][2]等引用标注
- 结尾用开放性问题收束，邀请读者讨论`;

  // 统一替换字数占位符
  writingRequirements = writingRequirements.replace(/\{wordCount\}/g, wordCount);

  // 字数较高时，放宽段落和章节约束（避免与字数要求矛盾）
  if (wordCount) {
    const min = parseInt(wordCount.match(/\d+/)?.[0] || '0', 10);
    if (min >= 2500) {
      writingRequirements = writingRequirements
        .replace(/150-280 字/g, '200-400 字')
        .replace(/禁止超过 350 字的大段/g, '禁止超过 500 字的大段')
        .replace(/核心分析段可以到 300 字左右/g, '核心分析段可以到 450 字左右')
        .replace(/4-6 个递进的小疑问/g, '6-8 个递进的小疑问')
        .replace(/4-6 个章节/g, '6-8 个章节');
    }
  }

  // 有大纲时附上大纲，无大纲时让 AI 自由发挥
  let outlineSection = '';
  if (outline && outline.sections && outline.sections.length) {
    const outlineText = outline.sections.map(s =>
      `${s.heading}：${s.points.join('；')}`
    ).join('\n');
    outlineSection = `\n大纲（仅供参考，不要机械按章节写）：\n${outlineText}\n`;
  }

  const topArticlesHint = opts.topArticlesHint
    ? `\n【参考：热文标题/特征】\n${opts.topArticlesHint}\n在写作时适当借鉴其中的标题风格、选题角度和读者兴趣点，但不要生硬模仿。\n`
    : '';

  return `根据以下选题，写一篇百家号文章。

选题：${topic}
作品：${work}
类别：${category || '自由'}
${outlineSection}
可用配图：
${imageList}

${writingRequirements}
${topArticlesHint}
- 每 300 字左右插入一张配图，格式：![配图](名称)，如 ![配图](郭襄)
- 名称必须从上面的可用配图列表中原样选取（如"郭襄""周瑜""孙悟空"），严禁使用场景描述（如"白衣渡江""水淹七军"），找不到匹配角色宁可不插图
- 配图选择必须与当前段落讨论的角色相关，不要随便插一个不相关的角色图
- 只输出最终定稿，严禁输出任何思考过程、自我纠正、犹豫、重写（如"不对""哦对了""等等""重新来""重新整理""咱们重新"等）。如果写到一半发现前面有问题，直接从头输出正确版本，不要保留错误版本和修改痕迹
- 最后一个章节不插图
- 开头方式要多样化，不要每篇都用"看了这么多年XXX"或"有没有人跟我一样"这种固定句式，可以灵活使用：直接抛出疑问、描写具体场景、引用名场面、对比反差、读者共鸣等多种开头方式

输出 Markdown 格式，# 大标题，## 小标题（禁止用 **粗体** 代替 ## 标题），不要输出额外说明。`;
}

/**
 * 根据 AI 输出的名称，在本地图片库中查找匹配文件
 * @param {string} article AI 输出的文章
 * @param {string} imageDir 图片根目录
 * @param {string} work 作品名
 * @param {string[]} [allowedGroups] 允许搜索的图片子目录列表，未指定则仅用 work
 * @returns {{ article, matched: [...], missing: [...] }}
 */
function resolveImageNames(article, imageDir, work, allowedGroups) {
  const groups = listImagesByGroup(imageDir);

  // 收集可用图片：只搜索指定的目录
  const dirs = allowedGroups || (work ? [work] : Object.keys(groups));
  const allFiles = [];
  for (const dir of dirs) {
    if (groups[dir]) {
      for (const f of groups[dir]) allFiles.push(path.join(imageDir, f));
    }
  }

  const usedImages = new Set();
  const matched = [];
  const missing = [];

  // 找到所有 ![xxx](yyy) 标记，用字符串查找而非复杂正则
  let result = '';
  let cursor = 0;
  while (cursor < article.length) {
    const imgStart = article.indexOf('![', cursor);
    if (imgStart === -1) {
      result += article.slice(cursor);
      break;
    }
    result += article.slice(cursor, imgStart);

    const altEnd = article.indexOf('](', imgStart);
    if (altEnd === -1) {
      result += article.slice(imgStart);
      break;
    }
    const alt = article.slice(imgStart + 2, altEnd);

    // 从 ]( 后面找配对的 )，支持括号嵌套
    let depth = 1;
    let i = altEnd + 2;
    while (i < article.length && depth > 0) {
      if (article[i] === '(') depth++;
      else if (article[i] === ')') depth--;
      i++;
    }
    if (depth !== 0) {
      result += article.slice(imgStart);
      break;
    }
    const ref = article.slice(altEnd + 2, i - 1);
    cursor = i;

    // 已经是本地绝对路径或 URL，保留原样
    if ((ref.startsWith('/') && fs.existsSync(ref)) || ref.startsWith('http')) {
      result += `![${alt}](${ref})`;
      continue;
    }

    // 用 includes 在文件名中查找匹配
    let name = ref;
    if (name.includes('/')) name = path.basename(name);
    name = name.replace(/\.(jpe?g|png|gif|webp)$/i, '');

    const candidates = allFiles.filter(f => {
      const fileName = path.basename(f, path.extname(f));
      return fileName.includes(name);
    });

    if (!candidates.length) {
      console.log(`  ⚠ 配图「${ref}」无匹配图片，已移除`);
      missing.push(ref);
      continue;
    }

    const available = candidates.filter(p => !usedImages.has(p));
    const pool = available.length > 0 ? available : candidates;
    const picked = pool[Math.floor(Math.random() * pool.length)];
    usedImages.add(picked);
    matched.push({ name: ref, file: path.basename(picked) });
    console.log(`  ✓ 配图「${ref}」→ ${path.basename(picked)}`);
    result += `![${alt}](${picked})`;
  }

  return { article: result, matched, missing };
}

/**
 * 强制移除最后一个章节中的所有配图
 * 因为系统会自动追加尾图，末尾不能有配图
 */
function stripLastSectionImages(article) {
  const headingRegex = /^## /gm;
  let lastHeadingIndex = -1;
  let match;
  while ((match = headingRegex.exec(article)) !== null) {
    lastHeadingIndex = match.index;
  }
  if (lastHeadingIndex === -1) return article;

  const before = article.slice(0, lastHeadingIndex);
  const lastSection = article.slice(lastHeadingIndex);
  const cleaned = lastSection.replace(/!\[[^\]]*\]\([^)]*(?:\([^)]*\)[^)]*)*\)\s*/g, '');
  return before + cleaned;
}

/**
 * 生成文章（AI 自主决定配图）
 */
async function generateArticle(topic, outline, work, characters, imageDir, category, relatedWorks, opts = {}) {
  const catDef = category ? getCategory(category) : null;
  const maxTokens = opts.maxTokens || (catDef ? catDef.maxTokens : 10000);

  // 如果有 relatedWorks，使用它作为图片目录列表；否则只用 work
  const allowedGroups = relatedWorks && relatedWorks.length > 0 ? relatedWorks : (work ? [work] : []);
  const imageList = imageDir ? buildImageList(imageDir, work, allowedGroups) : '';
  const basePrompt = buildPrompt(topic, outline, work, imageList, category, opts);
  const maxAttempts = category === RANKING_CATEGORY ? 3 : 1;

  let article = '';
  let lastValidationErrors = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const retryFeedback = lastValidationErrors.length
      ? `\n\n【上次输出不合格，必须从头重写】\n${lastValidationErrors.map(msg => `- ${msg}`).join('\n')}\n- 名次只能出现一次，角色只能出现一次，严禁重复排名、跳排名、临时改排名\n- 所有排名项都必须写成规范小标题：## 第X名：角色——一句话点评\n- 不要沿用上一版的问题结构，直接输出修正后的完整定稿`
      : '';

    article = await callLLM(basePrompt + retryFeedback, { maxTokens });

    if (!article) {
      throw new Error('文章生成失败，请检查 DOUBAO_API_KEY');
    }

    if (category !== RANKING_CATEGORY) break;

    const validation = validateRankingArticle(article);
    article = validation.article;

    if (validation.valid) {
      break;
    }

    lastValidationErrors = validation.errors;
    if (attempt < maxAttempts) {
      console.warn(`  ⚠ 数字盘点类结构校验失败，第${attempt}次重试：${validation.errors.join('；')}`);
      continue;
    }

    throw new Error(`数字盘点类结构校验失败：${validation.errors.join('；')}`);
  }

  let imageStats = { matched: [], missing: [] };

  if (imageDir) {
    // 修正 AI 常见畸形写法：中文括号、全角符号等
    article = article
      .replace(/!\[([^\]】]*)】\(/g, '![$1](')   // ![配图】( → ![配图](
      .replace(/！\[/g, '![')                      // ！[ → ![
      .replace(/\]\（/g, '](')                     // ]（ → ](
      .replace(/）/g, ')')                          // ） → ) (仅图片标记附近)
    ;
    const result = resolveImageNames(article, imageDir, work, allowedGroups);
    article = result.article;
    imageStats = { matched: result.matched, missing: result.missing };
  }

  article = stripLastSectionImages(article);

  return { article, imageStats };
}

/**
 * 为已有文章内容让 AI 插入配图（用于微信等外部来源文章）
 * @param {string} markdown 原始文章 Markdown
 * @param {string} imageDir 图片根目录
 * @param {string} work 作品名
 * @param {string[]} [relatedWorks] 涉及的多个作品（用于跨作品文章）
 * @returns {{ article, imageStats }}
 */
async function insertImages(markdown, imageDir, work, relatedWorks) {
  const allowedGroups = relatedWorks && relatedWorks.length > 0 ? relatedWorks : (work ? [work] : []);
  const imageList = buildImageList(imageDir, work, allowedGroups);
  if (!imageList) return { article: markdown, imageStats: { matched: [], missing: [] } };

  const prompt = `以下是一篇已写好的文章，请为它插入配图。

可用配图：
${imageList}

要求：
- 保持原文内容完全不变，只在合适位置插入配图标记
- 每 300 字左右插入一张配图，格式：![配图](名称)，如 ![配图](孙悟空)
- 名称必须从上面的可用配图列表中原样选取，选择与上下文最相关的角色
- 严禁使用场景描述（如"白衣渡江""水淹七军"），找不到匹配角色宁可不插图
- 最后一个章节不插图
- 配图标记必须单独成段，前后各空一行，不要和文字段落放在一起
- 直接输出完整文章，不要加任何说明

原文：
${markdown}`;

  const result = await callLLM(prompt, { maxTokens: 6000 });
  if (!result) {
    console.error('  AI 配图失败，使用原文');
    return { article: markdown, imageStats: { matched: [], missing: [] } };
  }

  let article = result;

  // 修正 AI 常见畸形写法
  article = article
    .replace(/!\[([^\]】]*)】\(/g, '![$1](')
    .replace(/！\[/g, '![')
    .replace(/\]\（/g, '](')
    .replace(/）/g, ')');

  const resolved = resolveImageNames(article, imageDir, work, allowedGroups);
  article = stripLastSectionImages(resolved.article);

  return { article, imageStats: { matched: resolved.matched, missing: resolved.missing } };
}

module.exports = {
  generateArticle,
  insertImages,
  buildImageList,
  resolveImageNames,
  stripLastSectionImages,
  detectWorksFromTitle,
  normalizeRankingHeadings,
  validateRankingArticle,
};
