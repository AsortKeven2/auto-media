/**
 * 选题生成器 - AI 驱动
 * 按作品分组管理历史，去重由 AI 完成
 */

const fs = require('fs');
const path = require('path');
const { callLLM } = require('./llm');
const { buildCategoryPromptSection, CATEGORIES } = require('./categories');
const { getFamousCharacters, countFamousNames } = require('./famous-characters');

const DATA_DIR = path.join(__dirname, '../..', 'data');
const ARTICLES_DIR = path.join(__dirname, '../..', 'archive', 'baijiahao');
const { loadConfig } = require('./config');

const FEATURED_TITLE_PLATFORMS = new Set(['wechat', 'baijiahao']);

function normalizeCategoryWeight(name, value) {
  const weight = Number(value);
  if (!Number.isFinite(weight) || weight < 0) {
    throw new Error(`文章分类“${name}”的权重无效，请设置大于等于 0 的数字`);
  }
  return weight;
}

function getConfiguredCategoryWeights(platform = 'wechat') {
  const config = loadConfig();
  const platformConfig = config[platform];
  const configured = platformConfig && platformConfig.category_weights;
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)) {
    throw new Error(`缺少文章分类权重配置，请在 config.json 中设置 ${platform}.category_weights`);
  }

  const entries = Object.entries(configured);
  const invalidNames = entries
    .map(([name]) => name)
    .filter(name => {
      const category = CATEGORIES[name];
      return !category;
    });
  if (invalidNames.length) {
    throw new Error(`category_weights 中存在不支持的小说分类：${invalidNames.join('、')}`);
  }

  return entries.map(([name, weight]) => ({
    name,
    weight: normalizeCategoryWeight(name, weight),
  }));
}

function usesFeaturedTitleLogic(platform) {
  return FEATURED_TITLE_PLATFORMS.has(platform);
}

function isLowValueReversalTitle(title) {
  if (typeof title !== 'string') return false;
  return /(?:(?:先)?别|(?:先)?不要)(?:再|只|光|急着|忙着)*骂/.test(title.replace(/\s+/g, ''));
}

function shuffleArray(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function buildWeightedCategoryPlan(totalCount, allowedCategories = null, platform = 'wechat') {
  const count = Math.max(0, Math.floor(Number(totalCount) || 0));
  if (!count) return [];

  const normalizedNames = Array.isArray(allowedCategories)
    ? [...new Set(allowedCategories.filter(name => Boolean(CATEGORIES[name])))]
    : null;
  const selectedNames = normalizedNames && normalizedNames.length ? normalizedNames : null;
  const configuredWeights = getConfiguredCategoryWeights(platform);
  const sourceWeights = selectedNames
    ? selectedNames.map(name => {
      const configured = configuredWeights.find(item => item.name === name);
      // 显式指定类别时，即使配置权重为 0 也必须保留该类别。
      return { name, weight: configured && configured.weight > 0 ? configured.weight : 1 };
    })
    : configuredWeights.filter(item => item.weight > 0);
  if (!sourceWeights.length) {
    throw new Error(`没有启用的文章分类，请在 config.json 的 ${platform}.category_weights 中设置大于 0 的权重`);
  }
  const totalWeight = sourceWeights.reduce((sum, item) => sum + item.weight, 0);
  const weighted = sourceWeights.map(item => {
    const exact = (count * item.weight) / totalWeight;
    const base = Math.floor(exact);
    return {
      name: item.name,
      weight: item.weight,
      count: base,
      remainder: exact - base,
    };
  });

  let remaining = count - weighted.reduce((sum, item) => sum + item.count, 0);
  const ranked = [...weighted].sort((a, b) => {
    if (b.remainder !== a.remainder) return b.remainder - a.remainder;
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });

  for (let i = 0; i < remaining; i++) {
    ranked[i % ranked.length].count++;
  }

  const plan = [];
  for (const item of weighted) {
    for (let i = 0; i < item.count; i++) {
      plan.push(item.name);
    }
  }
  return shuffleArray(plan);
}

function getNormalCategories(platform) {
  if (usesFeaturedTitleLogic(platform)) {
    const configuredWeights = getConfiguredCategoryWeights(platform).filter(item => item.weight > 0);
    return configuredWeights.flatMap(item => Array.from({ length: item.weight }, () => item.name));
  }
  return Object.entries(CATEGORIES)
    .filter(([, cat]) => !cat.platforms || cat.platforms.includes(platform))
    .map(([name]) => name);
}

function buildCategoryPromptSectionForPlatform(platform) {
  if (!usesFeaturedTitleLogic(platform)) return buildCategoryPromptSection(platform);

  return getConfiguredCategoryWeights(platform)
    .filter(item => item.weight > 0)
    .map(({ name }) => {
    const cat = CATEGORIES[name];
    return `【${name}】${cat.subtitle}\n选题风格：${cat.topicStyle}`;
    }).join('\n\n');
}

// 同一进程里并发生成选题时共用一份历史：各自读旧文件再保存会互相覆盖，也看不到彼此刚生成的选题
let historyCache = null;

/**
 * 加载按作品分组的历史选题
 * 自动迁移旧格式 (flat array) → 新格式 (per-novel object)
 */
function loadPerNovelHistory() {
  if (historyCache) return historyCache;
  const historyPath = path.join(DATA_DIR, 'topics_history.json');
  let raw = {};

  if (fs.existsSync(historyPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
      if (Array.isArray(parsed)) {
        console.log('  检测到旧格式 topics_history.json，自动迁移为按作品分组...');
        raw = migrateFromFlatArray(parsed);
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(historyPath, JSON.stringify(raw, null, 2), 'utf-8');
        console.log('  迁移完成');
      } else {
        raw = parsed;
      }
    } catch {}
  }

  // 从 articles 目录补充（按 work 分组）
  if (fs.existsSync(ARTICLES_DIR)) {
    const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.md') || f.endsWith('.txt'));
    for (const f of files) {
      try {
        const content = fs.readFileSync(path.join(ARTICLES_DIR, f), 'utf-8');
        if (content.startsWith('---')) {
          const fm = require('front-matter');
          const { attributes } = fm(content);
          if (attributes.title && attributes.work) {
            if (!raw[attributes.work]) raw[attributes.work] = [];
            if (!raw[attributes.work].includes(attributes.title)) {
              raw[attributes.work].push(attributes.title);
            }
          }
        }
      } catch {}
    }
  }

  historyCache = raw;
  return raw;
}

/**
 * 旧格式迁移：flat array → per-novel object
 */
function migrateFromFlatArray(flatArray) {
  const titleToWork = {};
  if (fs.existsSync(ARTICLES_DIR)) {
    const files = fs.readdirSync(ARTICLES_DIR).filter(f => f.endsWith('.md') || f.endsWith('.txt'));
    for (const f of files) {
      try {
        const content = fs.readFileSync(path.join(ARTICLES_DIR, f), 'utf-8');
        if (content.startsWith('---')) {
          const fm = require('front-matter');
          const { attributes } = fm(content);
          if (attributes.title && attributes.work) {
            titleToWork[attributes.title] = attributes.work;
          }
        }
      } catch {}
    }
  }

  const perNovel = {};
  for (const topic of flatArray) {
    const work = titleToWork[topic] || '_未分类';
    if (!perNovel[work]) perNovel[work] = [];
    perNovel[work].push(topic);
  }
  return perNovel;
}

function saveHistory(allHistory) {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const historyPath = path.join(DATA_DIR, 'topics_history.json');

  // 先和磁盘上的最新内容合并再写，别的进程期间写进去的选题不会被覆盖掉
  let onDisk = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
    if (parsed && !Array.isArray(parsed)) onDisk = parsed;
  } catch {}
  for (const [key, titles] of Object.entries(onDisk)) {
    if (!Array.isArray(titles)) continue;
    const current = allHistory[key] || [];
    const known = new Set(current);
    const missing = titles.filter(title => !known.has(title));
    if (missing.length || !allHistory[key]) allHistory[key] = [...missing, ...current];
  }

  fs.writeFileSync(historyPath, JSON.stringify(allHistory, null, 2), 'utf-8');
}

// 标题禁用的文绉绉虚词：提示词和过滤共用这一份名单
const TITLE_BANNED_WORDS = ['藏着', '暗藏', '玄机', '死局', '执念', '深藏布局', '另有隐情'];

/** 标题的硬性规则：两个平台都不能有禁用词，公众号另有字数和一线人物要求；不合规返回原因 */
function checkTitleRules(title, category, work, isWechat) {
  const bannedWord = TITLE_BANNED_WORDS.find(word => String(title || '').includes(word));
  if (bannedWord) return `含禁用词“${bannedWord}”`;
  return isWechat ? checkWechatTitle(title, category, work) : null;
}

// 榜单、清单类标题只要点出作品名也算合格（如“射雕英雄传里的八位隐世高人”）
const LIST_TITLE_CATEGORIES = new Set(['高手排名类', '人物榜单类']);
const WORK_MARKERS = { 水浒传: ['水浒', '梁山'], 三国演义: ['三国'], 西游记: ['西游'], 西游记后传: ['西游'] };

/** 公众号标题的硬性规则：主角在一线人物名单里；不合规返回原因 */
function checkWechatTitle(title, category, work) {
  const listWithWorkName = LIST_TITLE_CATEGORIES.has(category) && mentionsWork(title, work);
  if (countFamousNames(title, work) < 1 && !listWithWorkName) return '不含一线人物';
  return null;
}

function mentionsWork(title, work) {
  const markers = [work, work.slice(0, 2), ...(WORK_MARKERS[work] || [])];
  return markers.some(marker => marker && title.includes(marker));
}

/**
 * 标题审核，分三次调用，只判定能不能用，不改标题；不能用的剔除，由生成器重新出题：
 * 1. 结合原著审：事实前提不成立的、有错别字病句的、武功名写成截短叫法的，剔除；顺带列出专有名称和其余的词
 * 2. 脱离标题查每个词在现代汉语里最常用的意思：审核时知道标题想说什么，会把“百合”自然读成“一百回合”，
 *    只有不看标题，才查得出它最常用的意思是一种花
 * 3. 带着常用意思回到标题里核对：用的不是常用意思（或者常用意思是看不懂）的词，读者扫一眼就会读岔，剔除
 * 语言问题交给审核统一判断，不在代码里逐个打补丁；被剔除的标题仍留在历史里，避免再生成。
 * 百家号放宽（lenient）：事实前提只刷和原著明确矛盾的，不做第二、三步的读岔核对
 */
async function reviewTopics(topics, { lenient = false } = {}) {
  if (!topics.length) return topics;

  const rejected = new Map();
  try {
    const verdicts = await requestJsonArray(buildTitleReviewPrompt(topics, lenient), Math.max(3000, topics.length * 500));
    if (!verdicts) {
      console.warn('  ⚠ 标题审核没有返回可用结果，保留原选题');
      return topics;
    }

    const wordsByTopic = new Map();
    for (const verdict of verdicts) {
      const topic = topics[Number(verdict.index) - 1];
      if (!topic || rejected.has(topic)) continue;
      if (verdict.facts_ok === false) {
        rejected.set(topic, `前提不成立：${verdict.basis || ''}`);
        continue;
      }
      if (verdict.wording_ok === false) {
        rejected.set(topic, `措辞有问题：${verdict.wording_issue || ''}`);
        continue;
      }
      // “降龙”可能是降龙罗汉，名称不能由代码改；武功名写成截短叫法的整条剔除
      const truncated = findShortNames(topic.topic, verdict.names);
      if (truncated.length) {
        rejected.set(topic, `武功名写成了截短叫法：${truncated.map(([short, full]) => `${short}（${full}）`).join('、')}`);
        continue;
      }
      wordsByTopic.set(topic, { words: verdict.words, names: verdict.names });
    }

    if (!lenient) {
      const misread = await findMisusedWords(wordsByTopic);
      misread.forEach((words, topic) => {
        rejected.set(topic, `读者会读岔：${words.map(w => `${w.word}（${w.common}）`).join('、')}`);
      });
    }
  } catch (e) {
    console.warn(`  ⚠ 标题审核失败，未审完的选题保留原样：${e.message}`);
  }

  rejected.forEach((reason, topic) => console.warn(`  剔除选题: ${topic.topic}（${reason}）`));
  return topics.filter(t => !rejected.has(t));
}

function buildTitleReviewPrompt(topics, lenient = false) {
  const factRules = lenient
    ? `一、事实前提：标题里当作事实写进去的部分，有没有和原著明确矛盾
- 判断和观点（排名、谁更强、最会什么、“唯一”“最”这类论断、算不算某个档次）是文章要论证的内容，不算事实问题
- 标题后半句吸引人点开的说法（你看他某时说了什么、答案早摆明了、书里早写了），只要涉及的人物和情节书里有，就不算问题
- 只有和原著明确矛盾才算不成立：人物关系、身份辈分、武功或兵器归属写错，或者编了和原著冲突的事件（活着的人写成死了、没发生的交手写成发生过、把续书或网文设定当成原著）
- 拿不准的、只是书里没有明写的，都算成立
- 带假设的标题（如果……会怎样、打得过吗）本身是假设，只核查其中涉及的人物和已有情节
- 人名、武功名写了错别字不算事实问题，算措辞问题`
    : `一、事实前提：标题里当作事实陈述的部分在原著里是否成立
- 标题里的判断和观点（排名、谁更强、最会什么、算不算某个档次、是不是被低估）是文章要论证的内容，不需要原著明说，不要因此判不成立
- 只核查当作事实写进标题的部分：人物关系、身份辈分、武功或兵器归属、发生过的事件、人数
- 这些事实部分有一处和原著不符，就算不成立；虚构战场场景、把续书或网文设定当成原著，也算不成立
- 带假设的标题（如果……会怎样、打得过吗）本身是假设，只核查其中涉及的人物、武功和已有情节是否属实
- 人名、武功名写了错别字不算事实问题，算措辞问题`;
  return `下面是几个古典小说、武侠小说的文章选题标题，请逐个审核两件事。

${factRules}

二、措辞：标题是给普通读者在手机上一眼扫过的，不能让人读岔或看不懂
- 专有名称（人名、称号、官职、地名、门派、武功、兵器）逐个写进 names
- 错别字（包括人名、武功名写错）、病句、语义含混、读不通的，算措辞有问题，在 wording_issue 里写清哪里有问题；没问题就留空

${topics.map((t, i) => `${i + 1}. ${t.topic}（涉及：${(t.related_works && t.related_works.length ? t.related_works : [t.work]).join('、')}）`).join('\n')}

输出严格 JSON 数组（字符串里引用词语用中文引号“”，不要用英文双引号），每项先写依据再下结论：
- names：标题里的专有名称逐个写 [标题里的写法, 完整名称, 类型]，完整名称写读者最熟悉的通行全称（书里有多种叫法的取最常用的），写的就是完整名称的两项相同；类型写人名、地名、门派、称号、武功、兵器、法宝之一
- words：把标题里专有名称以外的词全部拆出来（数字连同后面的量词算一个词；“有多”“谁的”“能不能”这类现代常用的虚词、疑问说法不用列），后面会单独复核
[{"index":1,"basis":"事实部分及原著依据","facts_ok":true,"names":[["写法","完整名称","类型"]],"words":["词"],"wording_issue":"","wording_ok":true}]`;
}

const TITLE_PUNCTUATION = /[，,。！？?：:；;、（）()“”"《》\s]/;

/** 把第一步列出的专有名称整理成 [标题里的写法, 完整名称, 类型] */
function parseNamePairs(names) {
  return (Array.isArray(names) ? names : [])
    .map(entry => (Array.isArray(entry) ? entry : String(entry || '').split('→')).map(value => String(value || '').trim()))
    .filter(([written, full]) => written && full);
}

/** 写法是完整名称的缩略：开头的字相同，其余字按顺序出现在完整名称里（如“降龙”之于“降龙十八掌”） */
function isShortFormOf(short, full) {
  if (full.length <= short.length || short[0] !== full[0]) return false;
  let position = 0;
  for (const char of short) {
    position = full.indexOf(char, position);
    if (position === -1) return false;
    position += 1;
  }
  return true;
}

/**
 * 标题里截短的武功名：返回 [[截短写法, 完整名称]]。只认武功（如把降龙十八掌写成“降龙”），
 * 人名、地名、门派、兵器等不算（“梁山”人人都懂）；换种叫法（如“二郎神”）也不算截短
 */
function findShortNames(title, names) {
  return parseNamePairs(names)
    .filter(([written, full, type]) => type === '武功' && isShortFormOf(written, full)
      && title.includes(written) && !title.includes(full) && !TITLE_PUNCTUATION.test(full));
}

/** 第一步列出的专有名称（已由第一步和名称补全处理）和一线人物名单不参与用词核对，免得被“改”成别的名字 */
function collectProtectedNames(topic, names) {
  const { characters, factions } = getFamousCharacters(topic.work);
  const protectedNames = new Set([...characters, ...factions]);
  for (const [written, full] of parseNamePairs(names)) {
    protectedNames.add(written);
    protectedNames.add(full);
  }
  return protectedNames;
}

/** 第二、三步：查每个词脱离标题时最常用的意思，再回到标题里核对；返回 Map(选题 → 读岔的词 [{word, common}]) */
async function findMisusedWords(wordsByTopic) {
  const listed = new Map();
  const protectedByTopic = new Map();
  wordsByTopic.forEach(({ words, names }, topic) => {
    const protectedNames = collectProtectedNames(topic, names);
    protectedByTopic.set(topic, protectedNames);
    const usable = (Array.isArray(words) ? words : [])
      .map(word => String(word || '').trim())
      // 单字的意思全靠上下文；写全了的专有名称不用查
      .filter(word => word.length >= 2 && !TITLE_PUNCTUATION.test(word) && !protectedNames.has(word) && topic.topic.includes(word));
    if (usable.length) listed.set(topic, [...new Set(usable)]);
  });

  const result = new Map();
  if (!listed.size) return result;

  const allWords = [...new Set([...listed.values()].flat())];
  const lookup = await requestJsonArray(`下面每一行是一个词。请只看这个词本身，没有任何上下文，写出它在现代汉语里最常用的意思（按词典和日常用法）；现代汉语里不这么说、一般人看不懂的，写“看不懂”。

${allWords.map((word, i) => `${i + 1}. ${word}`).join('\n')}

输出严格 JSON 数组：[{"index":1,"common":"最常用的意思"}]`, Math.max(2000, allWords.length * 60));
  if (!lookup) {
    console.warn('  ⚠ 标题用词复核没有返回可用结果，跳过');
    return result;
  }
  const common = new Map();
  for (const item of lookup) {
    const word = allWords[Number(item.index) - 1];
    if (word && item.common) common.set(word, String(item.common).trim());
  }

  const entries = [...listed]
    .map(([topic, words]) => [topic, words.filter(word => common.has(word))])
    .filter(([, words]) => words.length);
  if (!entries.length) return result;

  const checks = await requestJsonArray(`下面每个文章标题后面，列出了其中一些词在现代汉语里最常用的意思。请对每个词做这个检查：假设读者只知道这个常用意思，把它代进标题去理解，能不能理解成标题想表达的意思？
- 能理解对就没问题，包括常见的比喻、引申用法，以及意思大体对、读者不会误会的
- 理解错、理解成另一回事，或者常用意思是“看不懂”，就是读者会读岔的词
- 人名、称号、官职、地名、门派、武功、兵器等专有名称不用检查
读岔的词原样写进 misread，没有就写空数组。

${entries.map(([topic, words], i) => `${i + 1}. ${topic.topic}
   ${words.map(word => `${word}：${common.get(word)}`).join('；')}`).join('\n')}

输出严格 JSON 数组：[{"index":1,"misread":["词"]}]`, Math.max(2000, entries.length * 150));
  if (!checks) {
    console.warn('  ⚠ 标题用词核对没有返回可用结果，跳过');
    return result;
  }

  for (const check of checks) {
    const entry = entries[Number(check.index) - 1];
    if (!entry || !Array.isArray(check.misread)) continue;
    const [topic] = entry;
    const protectedNames = protectedByTopic.get(topic);
    const words = check.misread
      .map(word => String(word || '').trim())
      .filter(word => word && !protectedNames.has(word) && topic.topic.includes(word))
      .map(word => ({ word, common: common.get(word) || '' }));
    if (words.length) result.set(topic, words);
  }
  return result;
}

/** 调用 AI 并解析 JSON 数组；输出不完整或格式不对时重试，最多三次 */
async function requestJsonArray(prompt, maxTokens) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw = await callLLM(prompt, { maxTokens });
    const match = raw && raw.match(/\[[\s\S]*\]/);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // 格式不对，重试
    }
  }
  return null;
}

/**
 * 调用 AI 生成选题（按作品独立历史 + 分类别生成）
 */
async function generateTopics(count = 10, workFilter = null, platform = 'baijiahao', categoryOverrides = null) {
  const works = listWorks();
  const allHistory = loadPerNovelHistory();
  const normalizedOverrides = Array.isArray(categoryOverrides)
    ? categoryOverrides.filter(name => Boolean(CATEGORIES[name]))
    : null;
  let allWorks = works;
  if (workFilter) {
    allWorks = works.filter(w => w === workFilter);
  } else {
    // 没指定作品时只从在写的书里挑（config.json 的 works 数量大于 0）
    const counts = loadConfig().works || {};
    allWorks = works.filter(w => Number(counts[w]) > 0);
  }

  if (!allWorks.length) {
    console.error(`未找到作品: ${workFilter}`);
    return [];
  }

  const work = allWorks[Math.floor(Math.random() * allWorks.length)];
  const historyKey = work;

  // 只取当前作品最近 50 条历史用于去重
  const novelHistory = (allHistory[historyKey] || []).slice(-50);
  const historyText = novelHistory.length
    ? '\n已有选题（请勿重复或相似）：\n' + novelHistory.map(t => `- ${t}`).join('\n')
    : '';

  const platformLabel = platform === 'wechat' ? '微信公众号' : '百家号/头条号';
  const isWechat = platform === 'wechat';
  const categoryText = buildCategoryPromptSectionForPlatform(platform);

  const normalCount = count;

  // 本地随机分配类别。微信/百家号支持外部传入全局分类配额，避免每本小说各自洗牌
  let assignedCategories = [];
  if (normalizedOverrides && normalizedOverrides.length >= normalCount) {
    assignedCategories = normalizedOverrides.slice(0, normalCount);
  } else {
    const categoryNames = getNormalCategories(platform);
    if (normalCount > 0 && !categoryNames.length) {
      throw new Error(`没有启用的文章分类，请在 config.json 的 ${platform}.category_weights 中设置大于 0 的权重`);
    }
    let shuffled = shuffleArray(categoryNames);
    for (let i = 0; i < normalCount; i++) {
      if (!shuffled.length) shuffled = shuffleArray(categoryNames);
      assignedCategories.push(shuffled.shift());
    }
  }

  if (!allHistory[historyKey]) allHistory[historyKey] = [];
  const results = [];

  // ── 辅助：解析 AI 返回并收集结果 ──
  function parseAndCollect(content, maxCount, getCategoryFn) {
    // 尝试提取 JSON 数组：先找第一个 [，再通过括号平衡找到匹配的 ]
    let jsonStr = null;
    const startIdx = content.indexOf('[');
    if (startIdx !== -1) {
      let depth = 0;
      for (let i = startIdx; i < content.length; i++) {
        if (content[i] === '[') depth++;
        else if (content[i] === ']') depth--;
        if (depth === 0) { jsonStr = content.slice(startIdx, i + 1); break; }
      }
    }
    if (!jsonStr) {
      console.error(`  选题解析失败 — AI 返回格式异常，内容: ${content.slice(0, 200)}`);
      return;
    }
    let topics;
    try {
      topics = JSON.parse(jsonStr).slice(0, maxCount);
    } catch (parseErr) {
      console.error(`  选题解析失败 — JSON 解析失败: ${parseErr.message}`);
      return;
    }
    for (let idx = 0; idx < topics.length; idx++) {
      const t = topics[idx];
      if (!t.topic) continue;
      if (isLowValueReversalTitle(t.topic)) {
        console.warn(`  跳过低价值劝骂式选题: ${t.topic}`);
        continue;
      }
      const category = getCategoryFn(idx);
      const problem = checkTitleRules(t.topic, category, work, isWechat);
      if (problem) {
        console.warn(`  跳过不合规标题（${problem}）: ${t.topic}`);
        continue;
      }
      if (allHistory[historyKey].includes(t.topic)) continue;
      allHistory[historyKey].push(t.topic);
      results.push({
        topic: t.topic,
        category,
        type: category,
        work,
        main_character: t.main_character || (t.characters && t.characters[0]) || '',
        characters: t.characters || [],
        related_works: t.related_works || [work],
      });
    }
  }

  // ── 按指定类别出题 ──
  if (normalCount > 0) {
    const categoryAssignment = assignedCategories
      .map((cat, i) => `第${i + 1}个选题 → ${cat}`)
      .join('\n');

    const famous = getFamousCharacters(work);
    const famousSection = isWechat && famous.characters.length
      ? `
【本书一线人物（标题主角只能从这里选，靠前的优先）】
人物：${famous.characters.join('、')}
势力：${famous.factions.join('、') || '无'}
`
      : '';
    // 标题长度照武侠百晓通：他 1098 个标题中位 26 字，九成在 23-28 字，两个平台一样
    const titleLengthRule = `只围绕《${work}》，标题二十二到二十八个汉字（不算标点），最长不超过三十二个汉字；把人物、反差和悬念都写出来，不要为了短而写空`;
    const titleTechniques = '【标题创作核心技巧】';
    const topicSection = `
【标题类型说明】
每个选题的类别已经指定，标题用该类别对应的写法（见上面的类别说明），另外：
- 高手排名类：排名依据只能是书里的战绩，不要虚构战场场景；标题点出榜首或垫底的反差
- 人物榜单类：评选标准要具体（会不会过日子、会不会算计、名声和本事差多少），不用"悲情""隐藏""被忽略"这类笼统虚词；上榜三到十个
- 动机揭秘类、实力解析类：问题落在一个具体的人和一件具体的事上，后半句只给线索不给答案
- 认知反转类：用"长大后才懂""多年后才看透""看懂……才明白"起句
- 人物揭秘类：标题里的"唯一""最"必须有书里的情节撑着
- 身世关系类、后续结局类：关系和下落必须是原著（以及射雕、神雕、倚天之间）写明的，不要把网文、续写或同人设定当成原著
- 作者揭秘类：写作者的起名、伏笔、改版、原型，不编作者没说过的话
- 所有类别都禁止“别再骂XX”“别只骂XX”“不要骂XX”“先别骂XX”这类劝读者不要批评角色的句式

${titleTechniques}
【他的标题写法】（武侠百晓通全部 1098 个标题的统计，照着写）
- 长度：二十二到二十八个汉字，他的中位是 26 字，20 字以内的只有 3%
- 分三段：79% 的标题用两个逗号或问号分成三段——第一段写人物和一个反常的事实或问题，第二段给线索或位次（"你看……""某某第2"），第三段落一个结果、反应或悬念（"黄蓉都替他害臊""原因难以启齿""第1名无可争议"）
- 问号多放在中间：带问号的标题 32%，以问号结尾的只有 8%；不用叹号
- 开头：直接以人名开头的最多（43%），其次是书名简称开头（射雕、神雕、倚天、天龙、梁山，15%）、"难怪"开头（14%）、《书名》开头（8%）
- 数字用阿拉伯数字：第2、6人、7位、10大、前3、43岁
- 常用词：为何（24%）、你看（18%）、难怪（15%）、最（15%）、都（14%）、却（11%）、还（8%），以及垫底、榜首、唯一、此人、就懂了；用"都""却""还"把反差加重
- 至少有一个可核对的专有名词（人名、书名、武功名、门派名），不写"某位高手""一位女子"这种泛指
九种常用模具，都按上面的三段来写：
① 疑问体：……为何……？你看……，……。如"黄药师为何要弄哑仆人？你看他们原本是什么人，个个死有余辜"
② 你看解谜体：……，你看……，……。如"萧峰在聚贤庄以一敌百，你看他用的什么拳，竟是最普通的太祖长拳"
③ 榜首型：榜单 + 位次 + 榜首反差。如"倚天10大高手排名，张无忌第2，第1名一生未逢敌手"
④ 难怪体：难怪……，你看……，……。如"难怪洪七公肯教郭靖绝学，你看黄蓉给他做了什么，他都吃上瘾了"
⑤ 榜单体：N位 + 评选标准 + 位次反差。如"梁山上最会做人的5位好汉，宋江只排第3，第1名人人都欠他人情"
⑥ 《书名》开头型：《X》+ 反常识断言。如"《天龙八部》的扫地僧，原著里连名字都没有，却是全书第一高手"
⑦ 顿悟体：长大后才懂，……为何……，……。如"长大后才懂，郭靖为何死守襄阳几十年，他图的从来不是名声"
⑧ 质疑体：……有多强？+ 证据。如"扫地僧有多强？萧远山、慕容博在他面前，毫无还手之力"
⑨ 定性反差体：他是……最……的，……，却……。如"他是全真教最没骨气的道士，犯下大错，却当上了掌教"
另外：
1. 反常识：名次、身份、结局和读者的印象相反，但必须有情节撑着
2. 留悬念：第二段只给线索不给答案，让读者点进来找
3. 句式多样化：同一批标题里同一种模具最多用两次
4. 控制重复词：同一批标题里"竟"最多出现一次，"为何""难怪""你看"最多各出现两次
5. 用现代人一眼就懂的说法：人名、武功、兵器写全称，不用古白话，不为了字数生造缩写（如把“百回合”写成“百合”、把“降龙十八掌”写成“降龙”）
6. 禁用文绉绉的虚词：${TITLE_BANNED_WORDS.map(word => `"${word}"`).join('')}，能写具体人物、动作、结果就写具体

【严格要求】
1. ${titleLengthRule}
2. 每个标题必须用不同句式，从上面的标题类型中选择，不要重复
3. 只允许使用当前指定类别对应的标题类型
4. 不要与已有选题重复或相似
5. 每个选题标注所属类别
6. related_works 固定为["${work}"]
7. 问号多放在中间，以问号结尾的标题不超过十分之一
8. 标题禁止出现英文字母；数字用阿拉伯数字
9. 禁止使用“别再骂”“别只骂”“不要骂”“先别骂”等劝读者不要批评角色的标题模板
10. 选题必须建立在书里确有的情节上：不要编造书里没有的事件，也不要硬凑“3次……”“7位……”这类数量，书里凑不够就换一个选题`;

    const normalPrompt = `为${platformLabel}生成 ${normalCount} 个关于《${work}》的爆款选题。
${historyText}

类别说明：
${categoryText}

【每个选题的类别已指定，严格按以下分配】
${categoryAssignment}
${famousSection}${topicSection}

输出格式（严格 JSON 数组）：
[{"topic": "标题", "category": "类别名", "main_character": "核心角色", "characters": ["角色1", "角色2"], "related_works": ["作品1", "作品2"]}]

说明：
- related_works 固定为["${work}"]`;

    try {
      const normalContent = await callLLM(normalPrompt, { maxTokens: 2000 });
      if (normalContent) {
        parseAndCollect(normalContent, normalCount, (idx) => assignedCategories[idx]);
      } else {
        console.error(`  正常分类选题生成失败: ${work} — AI 返回为空`);
      }
    } catch (e) {
      console.error(`  正常分类选题生成失败: ${work} — ${e.message}`);
    }
  }

  const reviewed = await reviewTopics(results, { lenient: platform === 'baijiahao' });
  // 改过措辞的标题也记进历史，避免下次再生成同样的题
  for (const t of reviewed) {
    if (!allHistory[historyKey].includes(t.topic)) allHistory[historyKey].push(t.topic);
  }
  saveHistory(allHistory);
  return reviewed;
}

/**
 * 获取所有作品列表
 * 从 config.json 的 works 字段读取
 */
function listWorks() {
  try {
    const config = loadConfig();
    return Object.keys(config.works || {});
  } catch (e) {
    console.error(`config.json 加载失败: ${e.message}`);
    return [];
  }
}

module.exports = {
  generateTopics,
  listWorks,
  buildWeightedCategoryPlan,
  getConfiguredCategoryWeights,
  isLowValueReversalTitle,
  reviewTopics,
};
