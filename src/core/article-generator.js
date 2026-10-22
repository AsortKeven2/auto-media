/**
 * AI 文章生成器 - DeepSeek
 * AI 根据可用图片列表，在文章中自主决定插图位置和选择
 */

const fs = require('fs');
const path = require('path');
const { callLLM, withThinking } = require('./llm');
const { listImagesByGroup } = require('./image-library');
const { getCategory, getCategorySkeleton, buildNovelArticlePrompt } = require('./categories');
const { toPortableProjectPath, normalizeMarkdownLocalImagePaths } = require('./local-file-utils');
const {
  normalizeImageMarkers,
  normalizeMarkdownParagraphs,
  splitLongParagraphs,
  removeImageMarkers,
  removeEnglishFromArticle,
  arrangeInlineImages,
} = require('./markdown-utils');
const { lintArticleStyle, stripRemovableFillers } = require('./style-lint');

const RANKING_CATEGORIES = new Set(['高手排名类', '人物榜单类']);
const ARTICLE_PROCESS_LEAK_REGEX = /哦\s*[，,、]?\s*不对(?:[，,。！？!?：:\s]|$)|(?:^|[\n。！？!?])\s*不对(?:[，,。！？!?：:]|$)|哦\s*对了|重新来|重新整理|咱们重新|推翻重来|可用配图|配图列表|图片列表|素材列表|素材库|上面的配图|不在[^。！？!?\n]{0,24}(?:配图|图片)/;
// 公版名著允许标注“（原文）”；金庸、古龙等作品模型记不准原句，只允许转述
const QUOTABLE_WORKS = new Set(['三国演义', '水浒传', '西游记']);
// 1000 多字的文章，正文配图 5 张就够了
const MAX_INLINE_IMAGES = 5;
// 核验出问题后自动修改的轮数上限，超过后直接删除仍被点名的句子
const MAX_FACT_FIX_ROUNDS = 2;
// 两轮后剩余问题不超过这个数就删句发布；超过说明这篇大面积失实，判为不合格
const MAX_ISSUES_TO_DELETE = 5;
// 百家号核验放宽：只查和原著明确矛盾的硬伤，两轮后硬伤不超过这个数就删句发布
const LENIENT_MAX_ISSUES_TO_DELETE = 8;

// 开头、结尾写法按武侠百晓通的实际比例抽取：开头约三成是“《书名》中，……”，其次是推翻大众印象、
// “小时候没看懂，长大后才看透”；结尾多是一句定性断语或落在一个具体判断上，约一成用反问，基本不留互动
const OPENING_STYLES = [
  { key: 'book', text: '以“《书名》中，”起笔，用一两段复述一段人人都知道的原著情节，紧接着用“那么问题来了”把它劈开', weight: 3 },
  { key: 'impression', text: '先摆出大多数人的印象或一种流行说法（“很多人都以为……”“一提起……大家都会想到……”），再用一个“可”字翻过来', weight: 3 },
  { key: 'cognitive', text: '从读书理解上的转变起笔（小时候只看懂了表面，长大后才看透），只写理解上的变化，不编具体的生活经历', weight: 1 },
  { key: 'question', text: '第一段就抛出标题里的那个疑问，第二段马上给出一个反常识的答案，再回头摆证据', weight: 1 },
];
const ENDING_STYLES = [
  { key: 'verdict', text: '最后用一句冷、狠、短的定性断语收住，给全文下一个判决，句号结束，不加任何互动', weight: 4 },
  { key: 'plain', text: '最后一段落在一个具体的判断上，比如这个人最终的下场或性格上的那个毛病，用一两句平实的话收住，不总结、不升华、不加互动', weight: 5 },
  { key: 'question', text: '最后一段用一个带情绪的反问收住，只问一个', weight: 1 },
];

const BAIJIAHAO_LEGACY_STYLE_GUIDE = `
【核心风格：像老朋友聊天，不像写论文】
你的角色是一个看了很多遍影视剧、也熟读原著的老粉丝，正在跟同好聊天分享自己的分析，不是在写学术论文或公众号鸡汤。

【开头要有吸引力，但不要套模板】
- 开头第一句就要让人想读下去，方式不限，每篇都要不一样
- 可以从疑问、场景、反差、共鸣、悬念、争议等任意角度切入，自由发挥
- 绝对禁止用"在XX的世界里""XX是一部经典""众所周知"这类空洞开头
- 禁止每篇都用相同句式开头，如"看了这么多年XXX""有没有人跟我一样""你有没有想过"

【段落节奏——有松有紧，别堆大段】
- 大多数段落控制在 150-280 字，核心分析段可以到 300 字左右
- 过渡段、设问段可以短一些（100-150 字），用来调节节奏
- 绝对禁止出现超过 350 字的大段，如果分析内容多就拆段
- 段与段之间用口语过渡，如"说到这儿，就得提一个细节了""再换个角度看"

【论据必须"落地"——引用具体影视或原著场景】
- 分析任何观点，必须引用至少一个具体影视或原著场景作为证据
- 描述场景要有画面感：谁说了什么话、做了什么动作、表情如何
- 用"你们记不记得XX那个名场面""剧里有个细节""原著里写过"引出场景
- 严禁空洞分析，如"他是一个复杂的人物"——必须跟上"复杂在哪？哪段能看出来？"

【互动感——让读者参与思考】
- 全文至少 5 处直接跟读者对话：
  "你想想""你们有没有想过""换做是你""说白了""其实啊""咱们再琢磨琢磨"
- 每个大段落结尾可以抛一个小问题，引导读者代入思考
- 避免单向输出，要像在跟读者辩论、聊天

【语气词用法——自然不刻意】
- 可以用的：说白了、其实啊、你想想、说实在的、换做是你、这就有意思了、咱们、唠唠、掰扯掰扯
- 禁止用的：让我们一起来看看吧、接下来我将为大家分析、综上所述、总而言之、不难发现、显而易见
- 语气词不要每段都用同一个，要自然交替

【结尾——不要"总结陈词"，要"留个话题"】
- 最后一段不要写成论文总结（禁止"综上所述""总而言之"）
- 用一个开放性问题收尾，邀请读者讨论，如"最后想问你们一句：要是当年XX……你们觉得会怎样？"
- 或者用一个感性的收束，如"这大概就是XX最让人唏嘘的地方吧"

【绝对禁止的AI腔】
- 禁止使用：不难发现、显而易见、值得注意的是、由此可见、综上所述、总而言之、毋庸置疑
- 禁止使用：让我们来看看、接下来分析、首先...其次...最后...、一方面...另一方面
- 禁止使用：在XX的背后、深层次的、多维度的、全方位的
- 禁止使用[1][2]等引用标注
- 禁止使用emoji和表情符号
- 严禁输出思考过程、自我纠正或重写痕迹（如"不对""哦对了""等等，咱们重新""重新来"），只输出最终定稿
`;

const BAIJIAHAO_LEGACY_CATEGORY_NOTES = {
  '高手排名类': `【武力排名类专属要求】
- 字数 {wordCount}，大纲仅供参考
- 每个排名项必须用 ## 小标题开头，格式如：## 第十名：角色——一句话战力判断。禁止用 **粗体** 代替 ## 标题
- 排名必须提前规划完整并严格连续推进：十人榜只能从第十名写到第一名，五人榜只能从第五名写到第一名，严禁重复名次、跳名次、临时改名次
- 评判标准要固定：正面对战表现、击败过谁、输给谁、是否有偷袭/受伤/环境因素、战斗稳定性
- 不要只报名次，每一名都必须引用具体打斗场景、对手实力和战斗结果
- 可以承认争议，但要给出清楚理由，不能把"名气大"直接当成"武功高"
- 结尾留一个争议位，引导读者讨论谁该上榜或谁排名低了`,
  '人物榜单类': `【数字盘点类专属要求】
- 字数 {wordCount}，大纲仅供参考
- 每个盘点项必须用 ## 小标题开头，格式如：## 第十名：文鸯——单骑退雄兵的跑酷小将，副标题要包含排名、角色名和一句话点评。禁止用 **粗体** 代替 ## 标题
- 名次必须提前一次性规划完整并严格连续推进：十人榜就只能依次出现一次“第十名”到“第一名”，五人榜就只能依次出现一次“第五名”到“第一名”，严禁重复名次、跳名次、临时改名次
- 以唠嗑式语气盘点，先给出排名结论，再结合影视/原著打斗或剧情片段佐证
- 每个盘点项不要干巴巴罗列，要加入个人主观感受，如"这段打斗看得我都着急""说实在的，这个排名可能有人不服"
- 每介绍 2-3 个角色/法宝后穿插一句过渡语，避免同类句式重复（禁止每个都用"排在第X位的是……"）
- 盘点中间可以穿插一个"争议点"，如"这个排名可能很多人不同意，咱们来掰扯掰扯"
- 结尾留一个小话题引导评论，如"你觉得这个排名合理吗？要是让你排，谁该排第一？"
- 每个角色只能出现一次，严禁同一角色先排第四又排第一，或用同一角色占据多个排名位
- 写之前先把十个角色想好再动笔，不要写到一半推翻重来。严禁在文中出现"不对""重新来""哦对了""等等"等自我纠正痕迹，只输出最终定稿`,
  '动机揭秘类': `【疑问解读类专属要求】
- 字数 {wordCount}，大纲仅供参考，不要机械地按大纲章节编号写
- 围绕标题的核心疑问，拆成 4-6 个递进的小疑问，每个小疑问用一段展开
- 每个小疑问必须引用至少一个影视或原著名场面作为证据，描述要有画面感
- 分析链条：表面认知 → 提出疑问 → 引用场景证据 → 给出新解读 → 抛出下一个疑问
- 不要胡乱推测，所有分析必须能在影视剧或原著中找到对应情节支撑
- 结尾回到标题的核心问题，给出你的答案，但要留有讨论空间`,
  '实力解析类': `【实力判定类专属要求】
- 字数 {wordCount}，大纲仅供参考
- 开头先把问题问准：到底是在比武艺、战绩、临场发挥，还是特定场景下能不能做到
- 正文必须先定标准，再拿具体场景验证，不能凭印象说"很强""很弱"
- 至少拆四个维度：代表战绩、对手质量、败绩原因、状态/地形/兵器变量
- 如果涉及两人对比，不要写成纯单挑爽文，要判断两人是否同档、谁更稳定、谁更吃场景
- 结尾要给明确答案，但保留一个变量给读者讨论`,
  '认知反转类': `【反差揭秘类专属要求】
- 字数 {wordCount}，大纲仅供参考
- 每个反差点的结构：先说大家的固有印象 → 再说"可你仔细看剧里这段" → 给出颠覆性的新理解
- 反差点必须基于影视或原著情节合理推导，不强行制造颠覆观点，每个结论都有对应片段支撑
- 用"原来不是我们想的那样""其实这段能看出""你可能从没注意到"等引导式表述
- 语言亲切不刻意标新立异，加入个人感悟但不矫情
- 结尾呼应标题，强化反差观点，留下让读者回味的空间`,
  '人物揭秘类': `【人物弧光类专属要求】
- 字数 {wordCount}，大纲仅供参考
- 开头先抓住角色身上最反常、最让人心疼或最容易误解的一点，不要从人物生平流水账写起
- 正文按"早期状态 → 关键选择 → 外部压力 → 性格变化 → 最终结局"推进，但不要机械写成小传
- 每个转折必须落到一个具体剧情场景：一次对话、一次出手、一次沉默、一次退让都可以
- 既要解释角色为什么会变，也要写出他/她当时可能承受的处境，让读者能代入
- 禁止空泛评价"复杂""立体""成长"，必须说明复杂在哪里、哪一段能看出来
- 结尾不要简单定罪或洗白，留一个关于命运选择的问题给读者讨论`,
  '身世关系类': `【原著考据类专属要求】
- 字数 {wordCount}，大纲仅供参考
- 开头先摆出一个流传很广但容易混淆的问题，让读者知道要考证什么
- 正文区分清楚：原著怎么写、影视怎么改、民间传说怎么传、合理结论是什么
- 每个判断必须引用具体文本情节或影视桥段，不能用"据说""大概"糊过去
- 语气要像老粉掰扯资料，不要写成百科词条；重点是帮读者理清误区
- 结尾给出清楚答案，并提示还有哪个相近说法容易被混淆`,
  '作者揭秘类': `【原著考据类专属要求】
- 字数 {wordCount}，大纲仅供参考
- 开头先摆出一个流传很广但容易混淆的问题，让读者知道要考证什么
- 正文区分清楚：原著怎么写、影视怎么改、民间传说怎么传、合理结论是什么
- 每个判断必须引用具体文本情节或影视桥段，不能用"据说""大概"糊过去
- 语气要像老粉掰扯资料，不要写成百科词条；重点是帮读者理清误区
- 结尾给出清楚答案，并提示还有哪个相近说法容易被混淆`,
  '后续结局类': `【结局命运类专属要求】
- 字数 {wordCount}，大纲仅供参考
- 不要写成流水账死亡名单，每个结局都要解释"为什么会走到这一步"
- 每一节必须落到具体剧情：一次选择、一次失算、一次站队、一次战败或一次被抛弃
- 要写出命运感，但不能鸡汤化；重点是人物处境、性格短板、阵营代价和时代压力
- 如果是群体结局，必须找出共同原因，而不是每个人孤立介绍
- 结尾留一个问题：如果当时换一种选择，命运有没有可能改写`,
};

const BAIJIAHAO_LEGACY_CATEGORY_MAP = {
  '高手排名类': '武力排名类',
  '人物榜单类': '数字盘点类',
  '动机揭秘类': '疑问解读类',
  '实力解析类': '实力判定类',
  '认知反转类': '反差揭秘类',
  '人物揭秘类': '人物弧光类',
  '身世关系类': '原著考据类',
  '作者揭秘类': '原著考据类',
  '后续结局类': '结局命运类',
};

function validateArticleOutput(article) {
  const text = String(article || '');
  const errors = [];
  if (ARTICLE_PROCESS_LEAK_REGEX.test(text)) {
    errors.push('文中出现了自我纠正或配图列表等写作过程文字');
  }
  return { valid: errors.length === 0, errors };
}

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
    // 只输出作品名，用不着思考
    const result = await callLLM(prompt, { maxTokens: 100, thinking: false });
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

// 选题都只围绕一部作品，直接用选题自带的关联作品（去重）
async function resolveArticleRelatedWorks(topic, work, category, relatedWorks) {
  return Array.isArray(relatedWorks)
    ? [...new Set(relatedWorks.filter(Boolean))]
    : [];
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

function validateRankingArticle(article, options = {}) {
  const normalizedArticle = normalizeRankingHeadings(article);
  const items = extractRankingItems(normalizedArticle);
  const errors = [];

  errors.push(...validateArticleOutput(normalizedArticle).errors);

  if (items.length < 3) {
    const format = options.legacy
      ? '## 第X名：角色——一句话点评'
      : '## 第X名：名字';
    errors.push(`只识别到 ${items.length} 个规范排名小标题，必须统一使用“${format}”`);
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

/** 按权重抽取本篇的开头、结尾写法；类别指定了写法（如认知反转类固定从读书认知的转变起笔）就用指定的 */
function pickWritingStyle(kind, fixedKey = null) {
  const options = kind === 'opening' ? OPENING_STYLES : ENDING_STYLES;
  const fixed = fixedKey && options.find(option => option.key === fixedKey);
  if (fixed) return fixed.text;
  const total = options.reduce((sum, option) => sum + option.weight, 0);
  let roll = Math.random() * total;
  for (const option of options) {
    roll -= option.weight;
    if (roll < 0) return option.text;
  }
  return options[options.length - 1].text;
}

function isQuotableWorks(works) {
  const list = (works || []).filter(Boolean);
  return list.length > 0 && list.every(work => QUOTABLE_WORKS.has(work));
}

function buildQuotePolicy(works) {
  return isQuotableWorks(works)
    ? '- 情节以转述为主，人物关键台词有把握才用引号。全篇最多一处“（原文）”：单独成段，以“（原文）”开头，必须是你逐字记得的原句，引完紧跟一段解读，说清这话表面是什么意思、实际是什么意思；没把握就不要引，改用转述。'
    : '- 不要写“（原文）”，也不要大段引用书中原句；情节用自己的话转述，人物的关键台词有把握才用引号包住，全篇不超过三句，记不准就不加引号，改成转述。';
}

function buildLayoutRules(skeleton) {
  if (skeleton === '榜单型') {
    return {
      heading: '排名项用“## 第X名：名字”作小标题（禁止用 **粗体** 代替），除此之外不要其他小标题',
      images: '配图放在对应排名项的小标题下面，用这一项人物的图；挑 4-5 个排名项配图，不必每项都配',
    };
  }
  if (skeleton === '清单型') {
    return {
      heading: '每一项用“## 1、名字”作小标题（禁止用 **粗体** 代替），除此之外不要其他小标题',
      images: '配图放在对应项目的小标题下面，用这一项人物的图；挑 4-5 项配图，不必每项都配',
    };
  }
  return {
    heading: '正文不要使用任何小标题，用段落自然推进',
    images: '配图均匀分布，大约每隔 5-6 段放一张，放在提到该人物的段落后面',
  };
}

function buildOutlineSection(outline) {
  if (!outline || !outline.sections || !outline.sections.length) return '';
  const outlineText = outline.sections.map(s =>
    `${s.heading}：${s.points.join('；')}`
  ).join('\n');
  return `\n大纲（仅供参考，不要机械按章节写）：\n${outlineText}\n`;
}

function buildFactsSection(facts) {
  if (!facts || !facts.length) return '';
  return `
【可用事实】（只能用下面这些事实作论据，不要引入清单以外的情节、台词和数字；动机和利益的推论可以用笔者的口吻大胆下判断，但不能把推出来的东西写成书里发生过的事）
${facts.map((fact, index) => `${index + 1}. ${fact}`).join('\n')}
`;
}

function buildTopArticlesHint(opts) {
  return opts.topArticlesHint
    ? `\n【参考：热文标题/特征】\n${opts.topArticlesHint}\n在写作时适当借鉴其中的标题风格、选题角度和读者兴趣点，但不要生硬模仿。\n`
    : '';
}

/**
 * 构建写作提示词
 * @param {object} opts wordCount、platform、topArticlesHint，以及
 *   quoteWorks（涉及作品，决定能否标注原文）、openingStyle/endingStyle（本篇开头结尾写法）
 */
/**
 * 百家号旧版写作提示词。
 * 公众号在后续版本增加了事实清单、文风质检和固定开头/结尾风格，
 * 这些规则只属于公众号，百家号继续沿用原来的短文章提示词。
 */
function buildBaijiahaoPrompt(topic, outline, work, imageList, category, opts = {}) {
  const wordCount = opts.wordCount || '1500-2000';
  const oldCategory = BAIJIAHAO_LEGACY_CATEGORY_MAP[category] || null;
  const categoryNotes = BAIJIAHAO_LEGACY_CATEGORY_NOTES[category];
  let writingRequirements = categoryNotes
    ? `${BAIJIAHAO_LEGACY_STYLE_GUIDE}\n\n${categoryNotes}`
    : `要求：
- 字数 {wordCount}
- 不要全是书面语、文学风，不要AI腔，像跟读者聊天而不是写论文
- 段落要有节奏感，大多数段落 150-280 字，过渡设问段可短些，禁止超过 350 字的大段
- 每个自然段必须单独占一行，段落之间空一行；不要把多个自然段连成一段
- 围绕标题疑问拆解，多结合影视名场面展开，描述具体场景要有画面感
- 全文至少 5 处与读者对话：如"你想想""说白了""其实啊""换做是你"
- 只引用影视/原著真实情节和对话，不确定的不要写
- 禁止使用"不难发现""显而易见""综上所述""值得注意的是"等AI套话
- 禁止使用[1][2]等引用标注
- 全文只能使用中文、中文标点和数字，禁止出现任何英文字母、英文单词或英文缩写（图片路径除外）
- 结尾用开放性问题收束，邀请读者讨论`;

  writingRequirements = writingRequirements.replace(/\{wordCount\}/g, wordCount);
  const minWordCount = parseInt(wordCount.match(/\d+/)?.[0] || '0', 10);
  if (minWordCount >= 2500) {
    writingRequirements = writingRequirements
      .replace(/150-280 字/g, '200-400 字')
      .replace(/禁止超过 350 字的大段/g, '禁止超过 500 字的大段')
      .replace(/核心分析段可以到 300 字左右/g, '核心分析段可以到 450 字左右')
      .replace(/4-6 个递进的小疑问/g, '6-8 个递进的小疑问')
      .replace(/4-6 个章节/g, '6-8 个章节');
  }

  let outlineSection = '';
  if (outline && outline.sections && outline.sections.length) {
    const outlineText = outline.sections.map(s => `${s.heading}：${s.points.join('；')}`).join('\n');
    outlineSection = `\n大纲（仅供参考，不要机械按章节写）：\n${outlineText}\n`;
  }

  const topArticlesHint = opts.topArticlesHint
    ? `\n【参考：热文标题/特征】\n${opts.topArticlesHint}\n在写作时适当借鉴其中的标题风格、选题角度和读者兴趣点，但不要生硬模仿。\n`
    : '';

  return `根据以下选题，写一篇百家号文章。

选题：${topic}
作品：${work}
类别：${oldCategory || category || '自由'}
${outlineSection}
可用配图：
${imageList}

${writingRequirements}
${topArticlesHint}
- 每 300 字左右插入一张配图，格式：![配图](名称)，如 ![配图](郭襄)
- 名称必须从上面的可用配图列表中原样选取（如"郭襄""周瑜""孙悟空"），严禁使用场景描述（如"白衣渡江""水淹七军"），找不到匹配角色宁可不插图
- 配图选择必须与当前段落讨论的角色相关，不要随便插一个不相关的角色图
- 最后一个章节不插图
- 正文严禁提及可用配图列表、图片列表、素材库、图片选择过程或任何写作过程
- 正文和标题禁止出现任何英文字母、英文单词或英文缩写；例如 VS、AI、OK 等都要改成中文
- 只输出最终定稿，严禁输出任何思考过程、自我纠正、犹豫、重写（如"不对""哦对了""等等""重新来""重新整理""咱们重新"等）。如果写到一半发现前面有问题，直接从头输出正确版本，不要保留错误版本和修改痕迹
- 开头方式要多样化，不要每篇都用"看了这么多年XXX"或"有没有人跟我一样"这种固定句式，可以灵活使用：直接抛出疑问、描写具体场景、引用名场面、对比反差、读者共鸣等多种开头方式

输出 Markdown 格式，# 大标题，## 小标题（禁止用 **粗体** 代替 ## 标题），不要输出额外说明。`;
}

function buildPrompt(topic, outline, work, imageList, category, opts = {}) {
  const catDef = category ? getCategory(category) : null;
  const wordCount = opts.wordCount || (catDef && catDef.maxWords) || '1500-2500';
  const skeleton = getCategorySkeleton(category) || '判定型';
  const writingRequirements = catDef
    ? catDef.articlePrompt
    : buildNovelArticlePrompt('判定型', ['围绕标题的核心问题展开，抛出问题后尽早亮出答案，后面用情节证明。']);
  const quoteWorks = opts.quoteWorks && opts.quoteWorks.length ? opts.quoteWorks : [work].filter(Boolean);
  const layout = buildLayoutRules(skeleton);
  const openingStyle = opts.openingStyle || pickWritingStyle('opening', catDef && catDef.opening);
  const endingStyle = opts.endingStyle || pickWritingStyle('ending');
  const platformLabel = opts.platform === 'wechat' ? '微信公众号' : '百家号';

  const imageBlock = imageList
    ? `可用配图：
${imageList}
- 全文插入 4-5 张配图，每张图单独成段，格式：![配图](名称)，如 ![配图](郭襄)
- ${layout.images}
- 名称必须从上面的可用配图列表中原样选取（如"郭襄""周瑜""孙悟空"），严禁使用场景描述（如"白衣渡江""水淹七军"），找不到匹配角色宁可不插图
- 配图必须和所在段落讨论的人物相关，不要随便插一个不相关的角色图
- 开头前两段和最后三段不放图`
    : '正文不插图，不要输出任何配图标记。';

  return `根据以下选题，写一篇${platformLabel}文章。

选题：${topic}
作品：${quoteWorks.join('、') || '自由'}
类别：${category || '自由'}
字数：纯正文 ${wordCount} 字，写够就收，不要为了凑字数加总结和空话
${buildOutlineSection(outline)}
${writingRequirements}
${buildFactsSection(opts.facts)}
【引用原文】
${buildQuotePolicy(quoteWorks)}
${buildTopArticlesHint(opts)}
【本篇写法】（照做即可，不要把这两条要求本身写进文章）
- 开头写法：${openingStyle}
- 结尾写法：${endingStyle}

【配图】
${imageBlock}

【写完自查，不合格的地方改好再输出（自查过程不要写出来）】
- 有一个反常识的结论，并且落在至少一处原著情节上
- 没有书里没有的台词和情节，没把推论写成书里发生过的事
- 用的是利益和性格归因，没站到“受害者完全无辜”的道德立场
- 每段两三句，没有景物描写、抒情、排比和“也许”“我觉得”
- 结尾没有“点赞、关注、收藏”

【输出】
- 第一行写 # ${topic}，标题原样保留，不要改写
- ${layout.heading}
- 正文严禁提及可用配图列表、图片列表、素材库、图片选择过程或任何写作过程
- 正文和标题禁止出现任何英文字母、英文单词或英文缩写；例如 VS、AI、OK 等都要改成中文
- 只输出最终定稿，严禁输出任何思考过程、自我纠正、犹豫、重写（如"不对""哦对了""等等""重新来""重新整理""咱们重新"等）。如果写到一半发现前面有问题，直接从头输出正确版本，不要保留错误版本和修改痕迹
- 不要输出任何说明`;
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
  // 先把 AI 混用的半角/全角括号统一成标准 Markdown 图片标记。
  article = normalizeImageMarkers(article);
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
      const portableRef = ref.startsWith('http') ? ref : toPortableProjectPath(ref);
      result += `![${alt}](${portableRef})`;
      continue;
    }

    // 用 includes 在文件名中查找匹配
    let name = ref;
    if (name.includes('/')) name = path.basename(name);
    name = name.replace(/\.(jpe?g|png|gif|webp)$/i, '');

    // 先找同名图（允许带数字后缀，如 令狐冲2），找不到再按包含匹配，避免“令狐冲”配到“令狐冲师娘”
    const baseNameOf = f => path.basename(f, path.extname(f));
    const exactCandidates = allFiles.filter(f => baseNameOf(f).replace(/\d+$/, '') === name);
    const candidates = exactCandidates.length
      ? exactCandidates
      : allFiles.filter(f => baseNameOf(f).includes(name));

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
    result += `![${alt}](${toPortableProjectPath(picked)})`;
  }

  const normalized = normalizeMarkdownLocalImagePaths(result);
  return { article: normalized.markdown, matched, missing };
}

/**
 * 按版式规则整理正文配图（总数封顶、开头结尾留白、两图保持间隔），
 * 并让配图统计只保留最终留在文中的图片
 */
function arrangeArticleImages(article, imageStats, maxImages = MAX_INLINE_IMAGES) {
  const arranged = arrangeInlineImages(article, { maxImages });
  if (arranged.removed > 0) {
    console.log(`  配图版式：保留 ${arranged.kept} 张，移除 ${arranged.removed} 张（超出上限或位置不合适）`);
  }
  const matched = (imageStats.matched || []).filter(item => arranged.markdown.includes(item.file));
  return { article: arranged.markdown, imageStats: { ...imageStats, matched } };
}

function stripLastSectionImages(article) {
  article = normalizeImageMarkers(article);
  const headingRegex = /^## /gm;
  let lastHeadingIndex = -1;
  let match;
  while ((match = headingRegex.exec(article)) !== null) lastHeadingIndex = match.index;
  if (lastHeadingIndex === -1) return article;

  const before = article.slice(0, lastHeadingIndex);
  const lastSection = article.slice(lastHeadingIndex);
  const cleaned = lastSection.replace(/!\[[^\]]*\]\([^)]+\)\s*/g, '');
  return before + cleaned;
}

/**
 * 写作前先让模型列出本篇要用的原著事实并自评把握程度，只保留“确定”的；
 * 边写边编的细节大多出在自由发挥时，先把事实定下来能明显减少编造
 */
async function collectArticleFacts(topic, works, category) {
  const prompt = `为下面这个选题，列出写文章要用到的原著事实。

选题：${topic}
作品：${works.join('、') || '自由'}
类别：${category || '自由'}

要求：
- 只列书里确实写了的情节、人物关系、战绩和结局，每条一句话；标题涉及续书、后传或影视改编时，也可以列它们的情节，但要写明出处
- 每条标注把握程度："确定"表示你清楚记得书里这样写，"不确定"表示记不清，或者可能是影视剧、网文的说法
- 不要写推测、评价和细节描写，不要为了凑数编造
- 列 8-15 条

输出严格 JSON 数组：[{"fact":"……","sure":"确定"}]`;

  try {
    const raw = await callLLM(prompt, { maxTokens: 2000 });
    const match = raw && raw.match(/\[[\s\S]*\]/);
    const items = match ? JSON.parse(match[0]) : [];
    const facts = items
      .filter(item => item && item.fact && item.sure === '确定')
      .map(item => String(item.fact).trim())
      .slice(0, 15);
    console.log(`  事实清单：${facts.length} 条确定，${items.length - facts.length} 条不确定已剔除`);
    return facts;
  } catch (e) {
    console.warn(`  ⚠ 事实清单生成失败，按无清单写作：${e.message}`);
    return [];
  }
}

function buildFactsReference(facts) {
  return facts && facts.length
    ? `\n写作前整理的原著事实，可作核对参考：\n${facts.map((fact, index) => `${index + 1}. ${fact}`).join('\n')}\n`
    : '';
}

/**
 * 逐句核验：找出和原著不符、找不到依据的句子，返回问题清单；核验本身失败时返回 null
 */
async function verifyArticleClaims(article, { works, facts, lenient = false }) {
  const bookNames = `《${works.join('》《') || '原著'}》`;
  const criteria = lenient
    ? `你是熟读${bookNames}的审稿编辑。请核验下面这篇文章，只找出和原著明确矛盾的硬伤：
- 写错的人物关系、辈分、身份、师承，武功或兵器归属（比如把甲的事安到乙身上、把两个人当成一个人）
- 写错的关键情节：某件事是谁做的、事情的结果、人物的生死结局、事件的先后顺序
- 把不同作品、续书、网文、影视剧的情节当成这本书的
- 用引号标成原话、但书里明显没有的台词
- 和下面事实清单矛盾的
不算问题：为了写得生动补的动作、表情、场景细节；记不准但不离谱的数字；书里没明写但说得通的推论；作者的观点、评价、排名、比较和类比；文风和措辞。拿不准的不要列，只列你确定是错的。`
    : `你是熟读${bookNames}的审稿编辑。请逐句核验下面这篇文章，找出和原著不符或在原著里找不到依据的内容：
- 书里没有的情节、台词、动作、表情和场景细节
- 书里找不到或记不准的具体数字（回合数、招数、年数、人数、距离）
- 写错的人物关系、辈分、身份、武功或兵器归属
- 把不同作品、不同时期的情节，或续书、网文、影视剧的内容当成原著的
- 和下面事实清单矛盾的
不算问题：作者的观点、评价、排名和比较；对人物动机、利益、性格的分析和推论（只要依据的情节书里有）；拿别的人物或现代处境做的类比（类比里提到的情节本身也要属实）；文风和措辞。只列你有把握判断为不符或没有依据的句子，不要把书里确有的主线情节当成问题。`;
  const prompt = `${criteria}
${buildFactsReference(facts)}
输出严格 JSON 数组，没有问题就输出 []：
[{"quote":"从文章里原样摘出有问题的那一句","problem":"哪里不对","fix":"删除，或改成书里确有的说法"}]

文章：
${article}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // 逐句核验开思考会把上万 token 全耗在思考里、一个字不输出（实测低档也一样），核验不开思考
      const raw = await callLLM(prompt, { maxTokens: 3000, thinking: false });
      const match = raw && raw.match(/\[[\s\S]*\]/);
      if (!match) throw new Error('没有返回 JSON');
      return JSON.parse(match[0])
        .filter(item => item && typeof item.quote === 'string' && item.quote.trim())
        .map(item => ({
          quote: item.quote.trim(),
          problem: String(item.problem || '').trim(),
          fix: String(item.fix || '删除').trim(),
        }));
    } catch (e) {
      console.warn(`  ⚠ 核验结果解析失败（第 ${attempt} 次）：${e.message}`);
    }
  }
  return null;
}

function buildClaimRevisionPrompt(article, issues, category) {
  const keepItems = RANKING_CATEGORIES.has(category) || getCategorySkeleton(category) === '清单型'
    ? '\n- 榜单、清单的每一项和小标题都不能删；某一项的内容拿不准，就改成书里确有的一两句概括'
    : '';
  return `下面这篇文章经审稿编辑核验，发现以下内容与原著不符或没有依据。请逐条修改：
${issues.map((issue, index) => `${index + 1}. 原句：${issue.quote}\n   问题：${issue.problem}\n   处理：${issue.fix}`).join('\n')}

要求：
- 只改上面这些句子，其余内容、观点、结构、段落格式、小标题和配图标记 ![配图](名称) 保持不变
- 只能删掉，或换成书里确有的说法；不要新增情节、台词和数字
- 某段改完没有内容了就整段删掉${keepItems}
- 用文章原来的口吻，不要照抄事实清单原句
- 只输出修改后的完整 Markdown 定稿，不要输出说明

原稿：
${article}`;
}

/** 按问题清单定向修改；改坏了（结构不全、字数骤减）返回 null */
async function reviseFlaggedClaims(article, issues, { category, maxTokens }) {
  const revised = await callLLM(buildClaimRevisionPrompt(article, issues, category), { maxTokens });
  if (!revised || !validateArticleOutput(revised).valid) return null;

  let candidate = revised;
  if (RANKING_CATEGORIES.has(category)) {
    const ranking = validateRankingArticle(candidate);
    if (!ranking.valid) return null;
    candidate = ranking.article;
  }

  const before = countArticleTextCharacters(article);
  const after = countArticleTextCharacters(candidate);
  if (before && (after < before * 0.5 || after > before * 1.15)) return null;
  return candidate;
}

/** 修改后仍被点名的句子直接删掉，保证带问题的内容不会发出去；小标题和配图不动 */
function removeFlaggedSentences(article, issues) {
  const quotes = issues.map(issue => issue.quote.replace(/\s/g, '')).filter(quote => quote.length >= 6);
  let removed = 0;
  const lines = article.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}\s/.test(trimmed) || /^!\[/.test(trimmed)) return line;
    const sentences = trimmed.match(/[^。！？!?]+(?:[。！？!?]+[”」』）)]*)?/g) || [trimmed];
    const kept = sentences.filter(sentence => {
      const compact = sentence.replace(/\s/g, '');
      const hit = quotes.some(quote => compact.includes(quote) || (compact.length >= 6 && quote.includes(compact)));
      if (hit) removed += 1;
      return !hit;
    });
    return kept.join('').trim();
  });
  return { article: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), removed };
}

/** 核验修改后字数掉到下限的 90% 以下时，只从事实清单里补回，补回的内容会在下一轮再核验 */
async function regrowIfTooShort(article, category, opts, facts, maxTokens) {
  const range = opts.enforceWordCount === true ? parseWordCountRange(opts.wordCount) : null;
  if (!range) return article;
  const count = countArticleTextCharacters(article);
  if (count >= Math.floor(range.min * 0.9)) return article;
  console.log(`  核验修改后只剩 ${count} 字，按事实清单补回`);
  try {
    return await enforceArticleWordCount(article, category, { ...opts, facts }, maxTokens);
  } catch (e) {
    console.warn(`  ⚠ 补字数失败，保留核验后的版本：${e.message}`);
    return article;
  }
}

/**
 * 最后一道核验：逐句核验 → 按问题清单修改 → 再核验，最多改两轮；
 * 两轮后仍有少量问题就删掉这几句，问题太多则判为不合格（抛错，由调用方换选题重写）。
 * 百家号放宽：只查和原著明确矛盾的硬伤，删句的上限也放宽；公众号照旧逐句严查
 */
async function finalFactCheck(article, { category, works, facts, opts, maxTokens }) {
  const lenient = opts?.platform === 'baijiahao';
  const maxIssuesToDelete = lenient ? LENIENT_MAX_ISSUES_TO_DELETE : MAX_ISSUES_TO_DELETE;
  let current = article;
  for (let round = 1; round <= MAX_FACT_FIX_ROUNDS + 1; round++) {
    const issues = await verifyArticleClaims(current, { works, facts, lenient });
    if (issues === null) {
      console.warn('  ⚠ 核验未返回可用结果，保留当前稿');
      return current;
    }
    if (!issues.length) {
      console.log(round === 1 ? '  核验：未发现问题' : `  核验：修改 ${round - 1} 轮后通过`);
      return current;
    }
    if (round > MAX_FACT_FIX_ROUNDS) {
      if (issues.length > maxIssuesToDelete) {
        throw new Error(`核验未通过：自动修改 ${MAX_FACT_FIX_ROUNDS} 轮后仍有 ${issues.length} 处与原著不符或没有依据`);
      }
      const cleaned = removeFlaggedSentences(current, issues);
      console.warn(`  ⚠ 核验：修改 ${MAX_FACT_FIX_ROUNDS} 轮后仍有 ${issues.length} 处问题，已直接删除 ${cleaned.removed} 句`);
      return cleaned.article;
    }

    console.log(`  核验第 ${round} 轮：发现 ${issues.length} 处问题，自动修改`);
    issues.slice(0, 6).forEach(issue => console.log(`    - ${issue.quote.slice(0, 36)}（${issue.problem.slice(0, 30)}）`));
    const revised = await reviseFlaggedClaims(current, issues, { category, maxTokens });
    if (revised) {
      current = await regrowIfTooShort(revised, category, opts, facts, maxTokens);
    } else {
      console.warn('  ⚠ 核验修改结果不可用，下一轮重新核验');
    }
  }
  return current;
}

function buildStyleRevisionPrompt(article, issues) {
  return `下面这篇文章有几处写法问题。请只改这些问题，其余内容、观点、事实、段落顺序和 Markdown 格式保持不变，纯正文字数基本不变。

需要修改：
${issues.map(issue => `- ${issue.message}`).join('\n')}

修改时注意：
- 每段两三句、五十五到七十字左右，最长不超过一百字，超长的段落按意思拆开
- 删掉或改写聊天口头禅，不要换成别的口头禅
- 配图标记 ![配图](名称) 原样保留，不要增删
- 不要新增书里没有的情节、台词和数字
- 不要加入写作说明、自我纠正或修改痕迹
- 只输出修改后的完整 Markdown 定稿

原稿：
${article}`;
}

/**
 * 文风质检：命中 AI 写作痕迹时做一次定向修改，修改稿更好才采用；
 * 最后再删掉句首残留的口头禅
 */
async function polishArticleStyle(article, { category, quoteWorks, instructionPhrases, maxTokens }) {
  const skeleton = getCategorySkeleton(category);
  const lintOptions = {
    allowQuote: isQuotableWorks(quoteWorks),
    allowHeadings: skeleton === '榜单型' || skeleton === '清单型',
    instructionPhrases,
  };
  const lint = lintArticleStyle(article, lintOptions);
  if (lint.passed) {
    console.log(`  文风检查：通过（平均段长 ${lint.metrics.avgParagraph} 字，最长 ${lint.metrics.maxParagraph} 字）`);
    return article;
  }

  console.log(`  文风检查：${lint.issues.length} 项问题，定向修改中`);
  lint.issues.forEach(issue => console.log(`    - ${issue.message}`));

  let best = article;
  let bestIssues = lint.issues.length;
  const revised = await callLLM(buildStyleRevisionPrompt(article, lint.issues), { maxTokens });
  if (revised && validateArticleOutput(revised).valid) {
    let candidate = revised;
    let structureOk = true;
    if (RANKING_CATEGORIES.has(category)) {
      const ranking = validateRankingArticle(candidate);
      candidate = ranking.article;
      structureOk = ranking.valid;
    }
    const before = countArticleTextCharacters(article);
    const after = countArticleTextCharacters(candidate);
    const lengthOk = before === 0 || Math.abs(after - before) / before <= 0.15;
    const candidateIssues = lintArticleStyle(candidate, lintOptions).issues.length;
    if (structureOk && lengthOk && candidateIssues < bestIssues) {
      best = candidate;
      bestIssues = candidateIssues;
    }
  }

  best = stripRemovableFillers(best);
  const finalLint = lintArticleStyle(best, lintOptions);
  if (finalLint.passed) {
    console.log(`  文风检查：修改后通过（平均段长 ${finalLint.metrics.avgParagraph} 字）`);
  } else {
    console.warn(`  ⚠ 文风检查：仍有 ${finalLint.issues.length} 项问题：${finalLint.issues.map(issue => issue.type).join('、')}`);
  }
  return best;
}

function countArticleTextCharacters(markdown) {
  return removeImageMarkers(normalizeImageMarkers(String(markdown || '')))
    .replace(/\s/g, '')
    .replace(/[#*\-\[\]()]/g, '')
    .length;
}

function parseWordCountRange(wordCount) {
  const values = String(wordCount || '').match(/\d+/g)?.map(Number) || [];
  if (values.length < 2 || values.some(value => !Number.isFinite(value))) return null;
  return { min: Math.min(values[0], values[1]), max: Math.max(values[0], values[1]) };
}

function getAcceptedWordCountMax(targetMax, overflowRatio = 0.3) {
  const ratio = Number.isFinite(Number(overflowRatio)) ? Math.max(0, Number(overflowRatio)) : 0.3;
  return Math.floor(targetMax * (1 + ratio));
}

async function enforceArticleWordCount(article, category, opts, maxTokens) {
  if (opts.enforceWordCount !== true) return article;

  const range = parseWordCountRange(opts.wordCount);
  if (!range) return article;
  let current = article;
  let currentCount = countArticleTextCharacters(current);
  const acceptedMax = getAcceptedWordCountMax(range.max, opts.wordCountOverflowRatio);
  if (currentCount >= range.min && currentCount <= acceptedMax) return current;

  const targetMin = range.min + Math.min(100, Math.floor((range.max - range.min) * 0.2));
  const targetMax = range.max - Math.min(150, Math.floor((range.max - range.min) * 0.3));
  const isRankingCategory = RANKING_CATEGORIES.has(category);
  const preservationRequirement = '- 保留原标题、核心观点、具体原著/影视情节和 Markdown 层级';
  const consistencyRequirement = '- 只调整篇幅，不改变人物、事件、胜负、排名和事实关系';
  let lastIssue = '';
  let lastValid = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const direction = currentCount > acceptedMax ? '压缩' : currentCount < range.min ? '补充' : '重新整理';
    const factHint = direction === '补充' && opts.facts && opts.facts.length
      ? `\n- 优先从下面这些原著事实里挑还没写到的补进去，用文章原来的口吻改写，不要照抄清单原句，也不要重复文中已经写过的内容；不要引入清单以外的情节和数字：\n${opts.facts.map((fact, index) => `  ${index + 1}. ${fact}`).join('\n')}`
      : '';
    const styleRequirement = `${direction === '补充'
        ? '- 只补书里确有的情节或硬事实（战绩、人物关系、结局），不要加总结、感想和空话'
        : '- 优先删掉重复的论证和空话，保留硬事实和结论'}${factHint}
- 保持原来的写法：每段两三句、不超过一百字，不要加入“你想想”“咱们”之类的口头禅`;
    const prompt = `请把下面这篇文章${direction}到纯正文 ${targetMin}-${targetMax} 字。

当前纯正文字数：${currentCount} 字
类别：${category}

要求：
${preservationRequirement}
${consistencyRequirement}
${styleRequirement}
- 保留必要的人物配图标记，配图名称不得改成场景描述
- 保持 Markdown 段落格式：每个自然段单独占一行，段落之间空一行
- 如果是榜单，排名数量、顺序、角色必须与原稿一致，每个角色只能上榜一次
- 不要加入写作说明、字数说明、自我纠正或修改痕迹
- 不要提及可用配图、配图列表、素材库或图片选择过程
- 只输出修改后的完整 Markdown 定稿
${lastIssue ? `- 上次调整仍有问题：${lastIssue}` : ''}

原稿：
${current}`;

    const rewritten = await callLLM(prompt, { maxTokens });
    if (!rewritten) {
      lastIssue = 'AI 返回为空';
      continue;
    }

    current = rewritten;
    const outputValidation = validateArticleOutput(current);
    if (!outputValidation.valid) {
      lastIssue = outputValidation.errors.join('；');
      currentCount = countArticleTextCharacters(current);
      continue;
    }
    if (isRankingCategory) {
      const validation = validateRankingArticle(current);
      current = validation.article;
      if (!validation.valid) {
        lastIssue = validation.errors.join('；');
        currentCount = countArticleTextCharacters(current);
        continue;
      }
    }

    currentCount = countArticleTextCharacters(current);
    if (currentCount >= range.min && currentCount <= acceptedMax) return current;
    lastValid = { article: current, count: currentCount };
    lastIssue = `纯正文字数仍为 ${currentCount}，目标 ${range.min}-${range.max}，最多允许 ${acceptedMax}`;
  }

  // 事实核查删掉编造内容后可能略短；只差一点（不低于下限的 90%）时保留，不让整篇作废
  const acceptedMin = Math.floor(range.min * 0.9);
  const fallback = [lastValid, { article, count: countArticleTextCharacters(article) }]
    .filter(Boolean)
    .find(item => item.count >= acceptedMin && item.count <= acceptedMax);
  if (fallback) {
    console.warn(`  ⚠ 字数略低于目标：纯正文 ${fallback.count} 字（目标 ${range.min}-${range.max}），已保留`);
    return fallback.article;
  }

  throw new Error(
    `文章字数校验失败：纯正文 ${currentCount} 字，目标 ${range.min}-${range.max} 字，最多允许 ${acceptedMax} 字`
  );
}

/**
 * 生成文章（AI 自主决定配图）。
 * 整个过程（认作品、事实清单、成文、核验、文风和字数修改）走 WorkBuddy 时开低档思考，少编原著细节
 */
function generateArticle(...args) {
  const opts = args[7] || {};
  if (opts.platform === 'baijiahao') return writeArticle(...args);
  return withThinking('low', () => writeArticle(...args));
}

async function writeArticle(topic, outline, work, characters, imageDir, category, relatedWorks, opts = {}) {
  const catDef = category ? getCategory(category) : null;
  const maxTokens = opts.maxTokens || (catDef ? catDef.maxTokens : 10000);

  // 账号或作品指定了配图目录就用指定的，否则按关联作品取图
  const detectedRelatedWorks = await resolveArticleRelatedWorks(topic, work, category, relatedWorks);
  const effectiveRelatedWorks = detectedRelatedWorks.length ? detectedRelatedWorks : (work ? [work] : []);
  const explicitImageGroups = Array.isArray(opts.imageGroups) && opts.imageGroups.length ? opts.imageGroups : null;
  const allowedGroups = explicitImageGroups || effectiveRelatedWorks;
  const imageList = imageDir ? buildImageList(imageDir, work, allowedGroups) : '';
  const isWechatPlatform = opts.platform === 'wechat';
  const factCheck = isWechatPlatform && opts.factCheck !== false;
  const writingStyle = {
    openingStyle: opts.openingStyle || pickWritingStyle('opening', catDef && catDef.opening),
    endingStyle: opts.endingStyle || pickWritingStyle('ending'),
  };
  const facts = factCheck ? await collectArticleFacts(topic, effectiveRelatedWorks, category) : [];
  const promptBuilder = opts.platform === 'baijiahao' ? buildBaijiahaoPrompt : buildPrompt;
  const basePrompt = promptBuilder(topic, outline, work, imageList, category, {
    ...opts,
    ...writingStyle,
    facts,
    quoteWorks: effectiveRelatedWorks,
  });
  const isRankingCategory = RANKING_CATEGORIES.has(category);
  const maxAttempts = isRankingCategory ? 3 : 2;

  let article = '';
  let lastValidationErrors = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const retryFeedback = lastValidationErrors.length
      ? `\n\n【上次输出不合格，必须从头重写】\n${lastValidationErrors.map(msg => `- ${msg}`).join('\n')}\n- 只输出文章正文和 Markdown 标题，不要输出思考过程、配图列表、素材选择说明或自我纠正文字${isRankingCategory ? `\n- 名次只能出现一次，角色只能出现一次，严禁重复排名、跳排名、临时改排名\n- 所有排名项都必须写成规范小标题：${opts.platform === 'baijiahao' ? '## 第X名：角色——一句话点评' : '## 第X名：名字'}` : ''}\n- 直接输出修正后的完整定稿`
      : '';

    article = await callLLM(basePrompt + retryFeedback, { maxTokens });

    if (!article) {
      throw new Error('文章生成失败，请检查 config.json 的 doubao_api_key');
    }

    if (!isRankingCategory) {
      const validation = validateArticleOutput(article);
      if (validation.valid) break;
      lastValidationErrors = validation.errors;
      if (attempt < maxAttempts) {
        console.warn(`  ⚠ 文章输出包含过程性文字，第${attempt}次重试：${validation.errors.join('；')}`);
        continue;
      }
      throw new Error(`文章输出校验失败：${validation.errors.join('；')}`);
    }

    const validation = validateRankingArticle(article, { legacy: opts.platform === 'baijiahao' });
    article = validation.article;

    if (validation.valid) {
      break;
    }

    lastValidationErrors = validation.errors;
    if (attempt < maxAttempts) {
      console.warn(`  ⚠ ${category}结构校验失败，第${attempt}次重试：${validation.errors.join('；')}`);
      continue;
    }

    throw new Error(`${category}结构校验失败：${validation.errors.join('；')}`);
  }

  // 字数不够时只从事实清单里补
  article = await enforceArticleWordCount(article, category, { ...opts, facts }, maxTokens);

  if (isWechatPlatform) {
    // 公众号版本的段落、文风和事实核验保持独立；百家号沿用旧版一次成稿流程。
    article = splitLongParagraphs(article);
    article = await polishArticleStyle(article, {
      category,
      quoteWorks: effectiveRelatedWorks,
      instructionPhrases: [writingStyle.openingStyle, writingStyle.endingStyle],
      maxTokens,
    });

    if (factCheck) {
      article = stripRemovableFillers(await finalFactCheck(article, {
        category,
        works: effectiveRelatedWorks,
        facts,
        opts,
        maxTokens,
      }));
    }
    article = splitLongParagraphs(article);
  }

  // 图片目标仍需保留，英文清洗必须在图片解析之后执行。
  article = normalizeImageMarkers(article);

  let imageStats = { matched: [], missing: [] };

  if (imageDir) {
    const result = resolveImageNames(article, imageDir, work, allowedGroups);
    article = result.article;
    imageStats = { matched: result.matched, missing: result.missing };
  }

  if (isWechatPlatform) {
    ({ article, imageStats } = arrangeArticleImages(article, imageStats));
  } else {
    article = stripLastSectionImages(article);
  }
  article = normalizeMarkdownParagraphs(removeEnglishFromArticle(article));
  const finalValidation = validateArticleOutput(article);
  if (!finalValidation.valid) {
    throw new Error(`文章输出校验失败：${finalValidation.errors.join('；')}`);
  }

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
  if (!imageList) {
    return { article: normalizeMarkdownParagraphs(removeEnglishFromArticle(markdown)), imageStats: { matched: [], missing: [] } };
  }

  // 两千字以内配 5 张，更长的文章按每 400 字一张放宽，最多 8 张
  const maxImages = Math.min(8, Math.max(MAX_INLINE_IMAGES, Math.round(countArticleTextCharacters(markdown) / 400)));
  const prompt = `以下是一篇已写好的文章，请为它插入配图。

可用配图：
${imageList}

要求：
- 保持原文内容完全不变，只在合适位置插入配图标记
- 全文插入 ${Math.max(3, maxImages - 1)}-${maxImages} 张配图，均匀分布，格式：![配图](名称)，如 ![配图](孙悟空)
- 名称必须从上面的可用配图列表中原样选取，选择与上下文最相关的角色
- 严禁使用场景描述（如"白衣渡江""水淹七军"），找不到匹配角色宁可不插图
- 开头前两段和最后三段不插图
- 配图标记必须单独成段，前后各空一行，不要和文字段落放在一起
- 正文严禁提及可用配图列表、图片列表、素材库、图片选择过程或任何写作过程
- 正文和标题禁止出现任何英文字母、英文单词或英文缩写；例如 VS、AI、OK 等都要改成中文
- 直接输出完整文章，不要加任何说明

原文：
${markdown}`;

  const result = await callLLM(prompt, { maxTokens: 6000 });
  if (!result) {
    console.error('  AI 配图失败，使用原文');
    return { article: removeEnglishFromArticle(markdown), imageStats: { matched: [], missing: [] } };
  }

  let article = result;

  const outputValidation = validateArticleOutput(article);
  if (!outputValidation.valid) {
    console.warn(`  AI 配图结果包含过程性文字，使用原文：${outputValidation.errors.join('；')}`);
    return { article: normalizeMarkdownParagraphs(removeEnglishFromArticle(markdown)), imageStats: { matched: [], missing: [] } };
  }

  article = normalizeImageMarkers(article);

  const resolved = resolveImageNames(article, imageDir, work, allowedGroups);
  const arranged = arrangeArticleImages(resolved.article, { matched: resolved.matched, missing: resolved.missing }, maxImages);
  article = normalizeMarkdownParagraphs(removeEnglishFromArticle(arranged.article));

  return { article, imageStats: arranged.imageStats };
}

module.exports = {
  generateArticle,
  insertImages,
  buildBaijiahaoPrompt,
  buildPrompt,
  removeFlaggedSentences,
  finalFactCheck,
  verifyArticleClaims,
  getAcceptedWordCountMax,
  detectWorksFromTitle,
  resolveImageNames,
  normalizeImageMarkers,
  resolveArticleRelatedWorks,
  validateArticleOutput,
  removeEnglishFromArticle,
};
