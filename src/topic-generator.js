/**
 * 选题生成器 - AI 驱动
 * 按作品分组管理历史，去重由 AI 完成
 */

const fs = require('fs');
const path = require('path');
const { callLLM } = require('./llm');
const { buildCategoryPromptSection, CATEGORIES } = require('./categories');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ARTICLES_DIR = path.join(__dirname, '..', 'archive', 'baijiahao');
const PUBLISH_CONFIG_PATH = path.join(__dirname, '..', 'publish_config.json');

/**
 * 加载按作品分组的历史选题
 * 自动迁移旧格式 (flat array) → 新格式 (per-novel object)
 */
function loadPerNovelHistory() {
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
  fs.writeFileSync(
    path.join(DATA_DIR, 'topics_history.json'),
    JSON.stringify(allHistory, null, 2),
    'utf-8'
  );
}

/**
 * 调用 AI 生成选题（按作品独立历史 + 分类别生成）
 */
async function generateTopics(count = 10, workFilter = null, platform = 'baijiahao', topArticlesHint = null) {
  const works = listWorks();
  const allHistory = loadPerNovelHistory();

  let allWorks = works;
  if (workFilter) {
    allWorks = works.filter(w => w === workFilter);
  }

  if (!allWorks.length) {
    console.error(`未找到作品: ${workFilter}`);
    return [];
  }

  const work = allWorks[Math.floor(Math.random() * allWorks.length)];

  // 只取当前作品的历史，上限 200 条
  const novelHistory = (allHistory[work] || []).slice(-200);
  const historyText = novelHistory.length
    ? '\n已有选题（请勿重复或相似）：\n' + novelHistory.map(t => `- ${t}`).join('\n')
    : '';

  const categoryText = buildCategoryPromptSection();

  // 本地随机分配类别，不依赖 AI 选择；同一作品尽量不重复类别
  const categoryNames = platform === 'wechat'
    ? ['数字盘点类', '假设对比类', '细节深挖类']
    : Object.keys(CATEGORIES);
  const assignedCategories = [];
  // 先打乱类别列表，按顺序分配，用完再重新打乱
  let shuffled = [...categoryNames].sort(() => Math.random() - 0.5);
  let shuffleIdx = 0;
  for (let i = 0; i < count; i++) {
    if (shuffleIdx >= shuffled.length) {
      shuffled = [...categoryNames].sort(() => Math.random() - 0.5);
      shuffleIdx = 0;
    }
    assignedCategories.push(shuffled[shuffleIdx++]);
  }

  const categoryAssignment = assignedCategories
    .map((cat, i) => `第${i + 1}个选题 → ${cat}`)
    .join('\n');

  const platformLabel = platform === 'wechat' ? '微信公众号' : '百家号/头条号';

  // ── 公共类型描述（微信 & 百家号共用） ──
  const sharedTypeDesc = `
类型6 - 数字盘点/排行：
- 盘点某部作品中的角色、法宝、事件等，数量不低于五个
- 标题必须包含作品名或作品标志词（如"西游""梁山""三国"），让读者一眼知道写的是哪部作品
- 标题必须提到至少一个具体角色名
- 盘点角度要具体有趣（如武力、兵器、智谋、搞笑、心机、酒量、逃跑能力等），禁止用"悲情""隐藏""被忽略"等笼统虚词
- 数字用汉字（"十大""五个""八位"），禁止阿拉伯数字和英文

类型7 - 假设对比：
- 两个角色假设对决、两方势力假设开战、不同阵营假设交锋等，分析结果会怎样
- 可以是角色vs角色、势力vs势力、门派vs门派，也可以是角色vs势力
- 可以是同一作品内，也可以跨作品
- 标题必须点名对比双方
- 句式要多变：不要都写"谁的胜算更大"，可以用"能撑几回合""鹿死谁手""谁先倒下""结局会怎样""能扛多久"等不同表达

类型8 - 细节深挖：
- 聚焦影视剧或原著中容易被忽略的细节、伏笔、暗线
- 标题必须包含具体的情节点或场景（如某个动作、某句台词、某个物件）
- 标题必须包含作品名或作品标志词，并提到具体角色
- 要有"你可能没注意到"的发现感，让读者觉得值得点进去看`;

  // 微信专用
  const wechatTopicSection = `
【标题类型说明】
只用以下三种类型，每种类型的标题句式必须每篇都不同，禁止套用固定模板：
${sharedTypeDesc}

【严格要求】
1. 只围绕《${work}》，标题不超过20字（根据内容自然表达，不要刻意凑字数）
2. 每个标题的句式、结构、用词都必须不同，绝对禁止多个标题用相同模板
3. 只从类型6（数字盘点/排行）、类型7（假设对比）、类型8（细节深挖）中选择
4. 不要与已有选题重复或相似
5. 每个选题标注所属类别
6. 如果是跨作品对比，必须在 related_works 字段中列出所有相关作品
7. 标题禁止出现任何英文字母和阿拉伯数字，数字一律用汉字表达`;

  // 百家号/头条号：全类型
  const baijiahaoTopicSection = `
【标题类型说明】
以下是所有可用类型，每种类型的标题句式必须每篇都不同，禁止套用固定模板：

类型1 - 二选一悬念：
- 标题抛出两个可能的原因或动机，引发读者好奇
- 可以是问句也可以是陈述句

类型2 - 具体细节挖掘：
- 聚焦一个具体情节或数字，揭示背后真相
- 标题要有画面感和具体细节

类型3 - 冒号反差（仅偶尔使用）：
- 冒号前给身份/标签，冒号后给反差信息
- 整批标题中最多用1个

类型4 - 强弱对比/反差陈述：
- 表面强的在某方面弱，表面弱的在某方面强
- 用"却""偏偏""竟"等转折词制造反差

类型5 - 具体场景+矛盾：
- 点名一个具体场景，揭示其中的矛盾或反常
- 标题要有叙事感
${sharedTypeDesc}

【标题创作核心技巧】
1. 句式多样化：每个标题必须用不同句式，禁止重复模板
2. 具体细节：用"三年""十大""万千""几个回合""几天"等具体数字，数字一律用汉字
3. 极端词汇：从不、明明、连...都、最、全部、唯一
4. 制造矛盾：强vs弱、应该vs实际、表面vs真相
5. 避免纯疑问句：不要只写"为何XXX？"，要加具体场景或对比

【严格要求】
1. 只围绕《${work}》，标题不超过20字（根据内容自然表达，不要刻意凑字数）
2. 每个标题必须用不同句式，从上面8种类型中选择，不要重复
3. 冒号句式（类型3）最多只用1个，其他类型优先
4. 不要与已有选题重复或相似
5. 每个选题标注所属类别
6. 如果是跨作品对比，必须在 related_works 字段中列出所有相关作品
7. 不要全部标题都用问号结尾，句式随机发挥
8. 标题禁止出现任何英文字母和阿拉伯数字，数字一律用汉字表达`;

  const topicSection = platform === 'wechat' ? wechatTopicSection : baijiahaoTopicSection;

  const topArticlesSection = topArticlesHint
    ? `\n【热文参考——你的高阅读量文章规律】\n${topArticlesHint}\n请参考以上规律，让新选题的标题风格和选题方向向高阅读量文章靠拢。\n`
    : '';

  const prompt = `为${platformLabel}生成 ${count} 个关于《${work}》的爆款选题。
${historyText}
${topArticlesSection}
类别说明：
${categoryText}

【每个选题的类别已指定，严格按以下分配】
${categoryAssignment}
${topicSection}

输出格式（严格 JSON 数组）：
[{"topic": "标题", "category": "类别名", "main_character": "核心角色", "characters": ["角色1", "角色2"], "related_works": ["作品1", "作品2"]}]

说明：
- related_works: 如果是跨作品对比（如"关羽攻打梁山"），列出所有涉及的作品["三国演义", "水浒传"]；如果只涉及《${work}》，则为["${work}"]`;

  try {
    const content = await callLLM(prompt, { maxTokens: 2000 });
    if (!content) {
      console.error(`选题生成失败: ${work} — AI 返回为空`);
      return [];
    }

    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error(`选题生成失败: ${work} — AI 返回格式异常，内容: ${content.slice(0, 200)}`);
      return [];
    }

    let topics;
    try {
      topics = JSON.parse(jsonMatch[0]).slice(0, count);
    } catch (parseErr) {
      console.error(`选题生成失败: ${work} — JSON 解析失败: ${parseErr.message}，内容: ${jsonMatch[0].slice(0, 200)}`);
      return [];
    }
    const results = [];

    if (!allHistory[work]) allHistory[work] = [];

    for (let idx = 0; idx < topics.length; idx++) {
      const t = topics[idx];
      if (!t.topic) continue;
      // 仅精确匹配去重，语义去重交给 AI
      if (allHistory[work].includes(t.topic)) continue;

      // 用本地分配的类别，不信任 AI 返回的 category
      const category = assignedCategories[idx];

      allHistory[work].push(t.topic);
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

    saveHistory(allHistory);
    return results;
  } catch (e) {
    console.error(`选题生成失败: ${work} — ${e.message}`);
    return [];
  }
}

/**
 * 获取所有作品列表
 * 从 publish_config.json 的 works 字段读取
 */
function listWorks() {
  if (!fs.existsSync(PUBLISH_CONFIG_PATH)) {
    console.error('未找到 publish_config.json，请先创建配置文件');
    return [];
  }
  try {
    const config = JSON.parse(fs.readFileSync(PUBLISH_CONFIG_PATH, 'utf-8'));
    return Object.keys(config.works || {});
  } catch (e) {
    console.error(`publish_config.json 解析失败: ${e.message}`);
    return [];
  }
}

module.exports = { generateTopics, listWorks };
