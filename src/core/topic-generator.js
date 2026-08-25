/**
 * 选题生成器 - AI 驱动
 * 按作品分组管理历史，去重由 AI 完成
 */

const fs = require('fs');
const path = require('path');
const { callLLM } = require('./llm');
const { buildCategoryPromptSection, CATEGORIES } = require('./categories');

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
      return !category || name === '热文风格' || name === '人物弧光类' || category.standalone;
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
      .filter(([name, cat]) => (
        name !== '热文风格'
        && !cat.featuredTitleOnly
        && (!cat.platforms || cat.platforms.includes(platform))
      ))
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
async function generateTopics(count = 10, workFilter = null, platform = 'baijiahao', topArticlesHint = null, explicitHotCount = null, categoryOverrides = null) {
  const works = listWorks();
  const allHistory = loadPerNovelHistory();
  const normalizedOverrides = Array.isArray(categoryOverrides)
    ? categoryOverrides.filter(name => Boolean(CATEGORIES[name]))
    : null;
  const standaloneMode = Boolean(
    normalizedOverrides
    && normalizedOverrides.length
    && normalizedOverrides.every(name => CATEGORIES[name].standalone)
  );

  let allWorks = standaloneMode
    ? [workFilter || normalizedOverrides[0]]
    : works;
  if (!standaloneMode && workFilter) {
    allWorks = works.filter(w => w === workFilter);
  }

  if (!allWorks.length) {
    console.error(`未找到作品: ${workFilter}`);
    return [];
  }

  const work = allWorks[Math.floor(Math.random() * allWorks.length)];
  const historyKey = standaloneMode
    ? `__category__${normalizedOverrides[0]}`
    : work;

  // 只取当前作品最近 50 条历史用于去重
  const novelHistory = (allHistory[historyKey] || []).slice(-50);
  const historyText = novelHistory.length
    ? '\n已有选题（请勿重复或相似）：\n' + novelHistory.map(t => `- ${t}`).join('\n')
    : '';

  const platformLabel = platform === 'wechat' ? '微信公众号' : '百家号/头条号';
  const categoryText = buildCategoryPromptSectionForPlatform(platform);

  // ── 热文/正常分配由调用方通过 explicitHotCount 决定 ──
  const hotCount = (platform === 'wechat' && topArticlesHint && explicitHotCount !== null)
    ? Math.min(explicitHotCount, count)
    : 0;
  const normalCount = count - hotCount;
  if (hotCount > 0) {
    console.log(`  混合模式：${hotCount} 条热文风格 + ${normalCount} 条正常分类`);
  }

  // 本地随机分配类别。微信/百家号支持外部传入全局分类配额，避免每本小说各自洗牌；
  // 热文风格只服务于微信热文参考，不参与常规随机选题。
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
      if (allHistory[historyKey].includes(t.topic)) continue;
      allHistory[historyKey].push(t.topic);
      const standaloneCategory = Boolean(CATEGORIES[category]?.standalone);
      results.push({
        topic: t.topic,
        category,
        type: category,
        work,
        main_character: standaloneCategory ? '' : (t.main_character || (t.characters && t.characters[0]) || ''),
        characters: standaloneCategory ? [] : (t.characters || []),
        related_works: standaloneCategory ? [] : (t.related_works || [work]),
      });
    }
  }

  // ── 第一批：热文风格（如有） ──
  if (hotCount > 0) {
    const hotPrompt = `为${platformLabel}生成 ${hotCount} 个关于《${work}》的爆款选题。
${historyText}

【热文标题参考——这是已验证的高流量标题，你必须严格模仿它们的风格】
${topArticlesHint}

【核心要求】
1. 仔细分析以上热文标题的句式结构、悬念设置、用词风格，新标题必须与热文标题保持一致的风格和套路
2. 可以模仿热文的句式模板（如"难怪...不是...你看...""如果...能否...你看..."），但内容必须围绕《${work}》的不同角色和情节
3. 每个标题必须提到至少一个具体角色名
4. 标题不超过30字
5. 不要与已有选题重复或相似
6. 标题禁止出现任何英文字母和阿拉伯数字，数字一律用汉字表达
7. 如果是跨作品对比，必须在 related_works 字段中列出所有相关作品
8. 禁止使用“别再骂”“别只骂”“不要骂”“先别骂”等劝读者不要批评角色的标题模板

输出格式（严格 JSON 数组）：
[{"topic": "标题", "category": "热文风格", "main_character": "核心角色", "characters": ["角色1", "角色2"], "related_works": ["作品1", "作品2"]}]`;

    try {
      const hotContent = await callLLM(hotPrompt, { maxTokens: 2000 });
      if (hotContent) {
        // 热文风格的选题统一使用"热文风格"类别
        parseAndCollect(hotContent, hotCount, () => '热文风格');
      } else {
        console.error(`  热文风格选题生成失败: ${work} — AI 返回为空`);
      }
    } catch (e) {
      console.error(`  热文风格选题生成失败: ${work} — ${e.message}`);
    }
  }

  if (standaloneMode && normalCount > 0) {
    const categoryName = normalizedOverrides[0];
    const category = CATEGORIES[categoryName];
    const standalonePrompt = `为微信公众号生成 ${normalCount} 个“${categoryName}”选题。
${historyText}

【账号定位】
${category.subtitle}。读者打开文章后，可以直接挑选其中的短句复制到朋友圈。内容不关联任何影视剧、小说、角色或作品。

【标题方向】
1. 人格标签型：清醒、通透、自信、有气质、高情商、落落大方、情绪稳定、边界感
2. 旺自己型：停止内耗、好好爱自己、提升状态、积攒福气、认真搞钱、保持好心态
3. 关系疗愈型：放下、释怀、不纠缠、体面离开、守住分寸、降低期待
4. 时间节点型：月初、月末、周末、节气、生日、新阶段

【常用标题结构】
- 真正{人格标签}的女人，会这样记录朋友圈
- {状态}的你，可以这样发朋友圈
- 女人这样记录生活，不为{误解}，只为{正向结果}
- {时间节点}，这些朋友圈文案温暖又走心
- {关系痛点}最好的方式，不是A，不是B，而是{答案}

【严格要求】
1. 每个标题都必须明确包含“女人”“朋友圈”“文案”或具体女性状态中的至少一项
2. 标题控制在十六到三十个汉字，不写作品名、角色名和剧情
3. 同一批标题不要连续使用相同开头或相同人格标签
4. 可以使用“秒赞”“超赞”“很走心”等情绪词，但禁止承诺百分之百有效、必定转运或保证发财
5. 不要与已有标题重复或近似，不要照搬任何参考公众号的完整标题
6. 所有选题的 category 固定为“${categoryName}”

输出格式（严格 JSON 数组）：
[{"topic":"标题","category":"${categoryName}","main_character":"","characters":[],"related_works":[]}]`;

    try {
      const standaloneContent = await callLLM(standalonePrompt, { maxTokens: 2000 });
      if (standaloneContent) {
        parseAndCollect(standaloneContent, normalCount, () => categoryName);
      } else {
        console.error(`  ${categoryName}选题生成失败 — AI 返回为空`);
      }
    } catch (e) {
      console.error(`  ${categoryName}选题生成失败 — ${e.message}`);
    }

    saveHistory(allHistory);
    return results;
  }

  // ── 第二批：正常分类 ──
  if (normalCount > 0) {
    const categoryAssignment = assignedCategories
      .map((cat, i) => `第${i + 1}个选题 → ${cat}`)
      .join('\n');

    const topicSection = `
【标题类型说明】
以下是唯一可用标题类型。必须结合上面的"指定类别"选对应类型，禁止使用旧的泛悬念、泛反差、泛情绪模板：

类型1 - 数字盘点/名单盘点：
- 盘点某部作品中的角色、法宝、事件、冷知识、结局、名单等，数量不低于五个，适合"数字盘点类"
- 标题必须包含作品名或作品标志词（如"西游""梁山""三国"），让读者一眼知道写的是哪部作品
- 盘点角度要具体有趣（如武力、兵器、智谋、搞笑、心机、酒量、逃跑能力等），禁止用"悲情""隐藏""被忽略"等笼统虚词
- 数字用汉字（"十大""五个""八位"），禁止阿拉伯数字和英文
- 示例句式："水浒传中的十大冷知识""曹操的七大救命恩人，谁最容易被忽略"

类型2 - 武力排名/战力榜单：
- 专门写高手、战将、法力、武功、兵器实战的排名，适合"武力排名类"
- 标题必须体现排名依据，不能只写"十大高手"这种空泛题
- 示例句式："三国超一流上将排名，赵云为何不排第一""倚天十大高手榜，张无忌之外谁最稳"

类型3 - 实力判定/武艺档次：
- 判断某角色是否够格、能否斩杀某人、和谁是否同档，适合"实力判定类"
- 标题要有明确判断问题，不能写成泛泛的"谁更强"
- 示例句式："关平在蜀汉二代里算不算最高""典韦和关羽是一个档次吗""颜良文丑到底能不能斩夏侯惇"

类型4 - 原著考据/历史设定：
- 辨析原著、影视改编、历史原型、民间传说之间的差异，适合"原著考据类"
- 标题要点出一个容易混淆的说法
- 示例句式："杨门女将到底有谁，她们真存在吗""唐僧算不算孝子，原著早给了答案"

类型5 - 剧情假设/改写走向：
- 改一个关键条件，看后续剧情会不会翻盘，适合"剧情假设类"
- 标题必须限定具体假设，禁止空泛写"如果XX会怎样"
- 示例句式："如果华容道关羽不放曹操，三国会不会改写""若典韦不死，曹操还能走到哪一步"

类型6 - 结局命运/生死去向：
- 写人物或群体的死亡、善终、惨死、改命、意难平，适合"结局命运类"
- 标题要带结局压力，如"之死""善终者少""结局最好""最冤"
- 示例句式："三国十大战将之死，谁最让人意难平""瓦岗诸将结局盘点，善终者为何这么少"

类型7 - 冷门翻案/低估角色：
- 给冷门角色、边缘人物或被低估的选择重新估值，适合"冷门翻案类"
- 标题必须落到具体贡献、具体处境或关键选择，给出新角度但不能硬洗
- 禁止使用“别再骂XX”“别只骂XX”“不要骂XX”“先别骂XX”等劝读者不要批评角色的句式
- 示例句式："很多人小看XX，他在三次危局里都选对了""XX最容易被忽略的贡献，恰好救了全局"

类型8 - 细节深挖/伏笔暗线：
- 聚焦影视剧或原著中容易被忽略的细节、伏笔、暗线，适合"细节深挖类"
- 标题必须包含具体的情节点或场景（如某个动作、某句台词、某个物件）
- 标题必须包含作品名或作品标志词，并提到具体角色
- 示例句式："猪八戒在高老庄三年，到底藏了多少事""华容道那晚，曹操到底带了多少人"

类型9 - 反差揭秘/认知翻转：
- 写一个和大众印象相反、但能用剧情支撑的判断，适合"反差揭秘类"
- 标题要有"原来不是那样"的感觉，但不能硬造颠覆
- 示例句式："最富有的妖怪，财宝比天庭国库还多""武松其实不爱打架，他最想要的是安稳日子"

类型10 - 关系博弈/人物拉扯：
- 写两个人或三个人之间的信任、亏欠、试探、控制和误解，适合"关系博弈类"
- 标题必须点名关系双方，最好带一个具体动作、称呼或一句话
- 示例句式："刘备和诸葛亮最微妙的一次沉默""黄蓉对杨过的提防，郭靖其实早看出来了"

类型11 - 同书人物对战：
- 只写同一作品内两个角色假设对决，适合"假设对比类"
- 标题必须点名双方角色，不能写势力，也不能跨作品
- 句式要多变：不要都写"谁的胜算更大"，可以用"能撑几回合""鹿死谁手""谁先倒下""能扛多久"等不同表达
- 示例句式："孙悟空对战牛魔王，能撑百回合吗""林冲对战武松，谁先露破绽"

类型12 - 跨书人物对战：
- 写A小说中的人物对战B小说中的人物，适合"跨书人物对战类"
- 标题必须点名两个角色，且两人必须来自不同作品
- 标题可以带"能撑几回合""谁先露败象""谁会先变招""鹿死谁手"等强讨论表达
- related_works 必须列出双方所属作品，如["神雕侠侣","笑傲江湖"]
- 示例句式："杨过对战东方不败，谁先露败象""萧峰遇上郭靖，能打满百招吗"

类型13 - 势力对战：
- 写门派、山寨、朝廷、妖族、团队、阵营之间开战，适合"势力对战类"
- 标题必须点名两个势力，不能只写两个头面人物单挑
- 标题要有战役推演感，可以写"能撑几天""谁先失守""谁会先崩盘""能扛多久"
- related_works 必须列出双方势力所属作品，跨作品时列出所有作品
- 示例句式："梁山对战五岳剑派，能撑几天""取经团队攻打梁山，宋江能扛多久"

类型14 - 名场面复盘：
- 围绕一场经典战斗、宴席、审问、告别、聚义、围攻等场景重新拆解
- 标题必须有具体场景名或事件名，不要泛泛写"那一战""那一次"
- 示例句式："少室山一战，XX真正输在这一步""华容道最险的，不是XX放走XX"

类型15 - 权谋布局/局势推演：
- 写阵营、权力、计谋、招安、夺位、结盟、背叛等局势
- 标题要有"局"的感觉：谁布置、谁入局、哪一步反噬
- 示例句式："XX这步棋，看似保命其实埋雷""XX招安前，梁山已经输在这三步"

类型16 - 设定纠偏/误区辨伪：
- 纠正常见误读、伪设定、不合理名单或流传很广但不准确的说法，适合"设定纠偏类"
- 标题要让读者意识到"我可能记错了"
- 示例句式："封神里根本不存在的设定，为何流传这么广""隋唐十八条好汉这份名单，哪里最不合理"

类型17 - 续书衍生/版本对照：
- 比较原著、续书、后传、改编之间的人物结局和设定差异，适合"续书衍生类"
- 标题必须点明原著或续书/后传，不要把不同版本混成一锅
- 示例句式："残水浒和水浒传的梁山结局有何不同""荡寇志为何被说成最狠的水浒续书"

类型18 - 物件线索：
- 从兵器、信物、佛珠、酒杯、衣角、鞋、扇子、通关文牒等具体物件切入
- 标题必须包含物件名，不能只写抽象的"暗线""伏笔"
- 示例句式："XX手里那串佛珠，藏着XX旧事""XX送出的那双鞋，才是最后的心软"

类型19 - 阵营群像/组织兴衰：
- 写门派、家族、山寨、朝廷、妖族、帮派、师门等群体的秩序和崩塌
- 标题必须包含阵营名或组织标志词，并点出一个关键人物
- 示例句式："梁山真正散掉，不是从招安开始""XX能压住众人，靠的不是武功"

类型20 - 疑问解读/悬念求证：
- 围绕一个明确问题拆解真相，适合"疑问解读类"
- 标题可以问，但问题必须具体，不能只写"为什么XX"
- 示例句式："西游记里最被低估的真相，唐僧到底算不算孝子""赵云为何武艺排前，却在五虎将里位列最后"

【标题创作核心技巧】
1. 句式多样化：每个标题必须用不同句式，禁止重复模板
2. 具体细节：用"三年""十大""万千""几个回合""几天"等具体数字，数字一律用汉字
3. 极端词汇：从不、明明、连...都、最、全部、唯一
4. 制造矛盾：强vs弱、应该vs实际、表面vs真相
5. 避免纯疑问句：不要只写"为何XXX？"，要加具体场景或对比
6. 控制重复词：同一批标题里"为何""谁先""竟藏""对战"最多各出现一次
7. 少用万能词："深藏布局""另有隐情""暗藏玄机"这类泛词不能连续出现，能写具体物件、动作、场景就写具体

【严格要求】
1. 只围绕《${work}》，标题一般控制在二十二到三十二个汉字，最长不超过三十六个汉字；信息量要足，不要为了短而写空
2. 每个标题必须用不同句式，从上面的标题类型中选择，不要重复
3. 只允许使用当前指定类别对应的标题类型，不要生成"人物弧光类"等已停用旧类别
4. 不要与已有选题重复或相似
5. 每个选题标注所属类别
6. 如果是跨作品对比，必须在 related_works 字段中列出所有相关作品
7. 不要全部标题都用问号结尾，句式随机发挥
8. 标题禁止出现任何英文字母和阿拉伯数字，数字一律用汉字表达
9. 禁止使用“别再骂”“别只骂”“不要骂”“先别骂”等劝读者不要批评角色的标题模板`;

    const normalPrompt = `为${platformLabel}生成 ${normalCount} 个关于《${work}》的爆款选题。
${historyText}

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

  saveHistory(allHistory);
  return results;
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
};
