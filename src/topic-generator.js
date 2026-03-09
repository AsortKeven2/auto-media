/**
 * 选题生成器 - AI 驱动
 * 按作品分组管理历史，去重由 AI 完成
 */

const fs = require('fs');
const path = require('path');
const { callLLM } = require('./llm');
const { buildCategoryPromptSection } = require('./categories');

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
async function generateTopics(count = 10, workFilter = null) {
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

  const prompt = `为百家号/头条号生成 ${count} 个关于《${work}》的爆款选题。
${historyText}

选题必须属于以下 4 个类别之一，尽量均匀分布：
${categoryText}

【优质标题参考案例 - 多种句式】
以下是高质量标题的不同写法，每种句式都不同：

类型1 - 二选一悬念（是A还是B）：
- 菩提祖师从不露面，是怕如来还是身份特殊？
- 铁扇公主不借芭蕉扇，真的是恨孙悟空吗？

类型2 - 具体细节+疑问：
- 猪八戒在高老庄住了3年，到底干了哪些事？
- 花果山万千猴孙，为何最后所剩无几？

类型3 - 冒号反差（仅偶尔使用）：
- 天庭最懒神仙：啥也不干，玉帝还不敢罚
- 最富有的妖怪：财宝比天庭国库还多

类型4 - 强弱对比：
- 六耳猕猴骗过如来，为何瞒不过八戒？
- 火眼金睛能辨妖魔，为何总被假悟空蒙蔽？

类型5 - 具体场景+矛盾：
- 萧峰母亲惨死，玄慈明明在场为何不救？
- 青牛精下凡，是意外走失还是老君故意放行？

类型6 - 数字盘点：
- 十大有后台妖怪：悟空连一半都不敢真打
- 八大妖王实力对比：金翅大鹏雕能排第二？

类型7 - 假设对比（谁会赢/能坚持多久）：
- 武松对战林冲，谁的胜算更大？
- 李逵单挑鲁智深，能撑过几个回合？
- 关羽攻打梁山，宋江能守住几天？

【标题创作核心技巧】
1. 句式多样化：每个标题必须用不同句式，禁止重复模板
2. 具体细节：用"3年""十大""万千""几个回合""几天"等具体数字
3. 极端词汇：从不、明明、连...都、最、全部、唯一
4. 制造矛盾：强vs弱、应该vs实际、表面vs真相
5. 假设对比：谁会赢、能坚持多久、胜算多大、能撑几回合（可跨作品对比）
6. 避免纯疑问句：不要只写"为何XXX？"，要加具体场景或对比

【严格要求】
1. 只围绕《${work}》，标题不超过20字（根据内容自然表达，不要刻意凑字数）
2. 每个标题必须用不同句式，从上面7种类型中选择，不要重复
3. 冒号句式（类型3）最多只用1个，其他类型优先
4. 不要与已有选题重复或相似
5. 每个选题标注所属类别
6. 如果是跨作品对比，必须在 related_works 字段中列出所有相关作品

输出格式（严格 JSON 数组）：
[{"topic": "标题", "category": "类别名", "main_character": "核心角色", "characters": ["角色1", "角色2"], "related_works": ["作品1", "作品2"]}]

说明：
- related_works: 如果是跨作品对比（如"关羽攻打梁山"），列出所有涉及的作品["三国演义", "水浒传"]；如果只涉及《${work}》，则为["${work}"]`;

  try {
    const content = await callLLM(prompt, { maxTokens: 2000 });
    if (!content) {
      console.error('选题生成失败');
      return [];
    }

    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.error('AI 返回格式异常');
      return [];
    }

    const topics = JSON.parse(jsonMatch[0]).slice(0, count);
    const results = [];

    if (!allHistory[work]) allHistory[work] = [];

    for (const t of topics) {
      if (!t.topic) continue;
      // 仅精确匹配去重，语义去重交给 AI
      if (allHistory[work].includes(t.topic)) continue;

      allHistory[work].push(t.topic);
      results.push({
        topic: t.topic,
        category: t.category || '疑问解读类',
        type: t.category || '深度解读',
        work,
        main_character: t.main_character || (t.characters && t.characters[0]) || '',
        characters: t.characters || [],
        related_works: t.related_works || [work], // 涉及的作品列表，用于配图
      });
    }

    saveHistory(allHistory);
    return results;
  } catch (e) {
    console.error(`选题生成失败: ${e.message}`);
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
