/**
 * 文风质检 - 找出生成文章里偏离武侠百晓通写法的地方，交给定向改写
 * 阈值按他分段完整的 686 篇文章实测：段长中位 65 字、几乎不超过 100 字；骨架连接词每篇四次左右；
 * 网络梗一两处封顶；不用不确定说法、意象词和引流话术；不和读者套近乎、不编个人经历
 */

const { removeImageMarkers } = require('./markdown-utils');

const CHAT_FILLERS = [
  '你们记不记得', '你还记得', '你想想', '说实在的', '换做是你', '换作是你',
  '咱们', '掰扯', '琢磨', '唠唠', '唠嗑', '其实啊', '别急',
];
const CLICHES = [
  '综上所述', '总而言之', '不难发现', '显而易见', '值得注意的是', '由此可见', '毋庸置疑',
  '见仁见智', '各有千秋', '最后想问',
];
// 他从不用的不确定说法；“可能有人会说了”这种拿来当靶子的让步不算
const UNCERTAIN_WORDS = ['也许', '或许', '我觉得', '我个人认为'];
// 写景、抒情的意象词，他一篇都不写
const IMAGERY_WORDS = ['月光', '黄昏', '斑驳', '怅然', '清冷', '细雨', '秋意'];
// 网络梗只是点缀，全篇最多两处；牛马、开香槟、细思极恐是低频彩蛋，最多一处
const SLANG_PATTERNS = [/妥妥/g, /配置/g, /开挂/g, /战神属性/g, /封神(?!榜|演义)/g, /天花板/g, /逆天/g];
const RARE_SLANG_PATTERNS = [/牛马/g, /开香槟/g, /细思极恐/g];
const MAX_SLANG = 2;
// 骨架连接词他每篇合计四次左右，最多十来次；模型照着清单堆词就成了机械模仿
const SKELETON_WORDS = ['毕竟', '其实', '可见', '笔者', '要知道', '那么问题来了', '纵观', '但凡', '实则'];
const MAX_SKELETON_TOTAL = 14;
const MAX_SKELETON_EACH = 4;
const FAKE_EXPERIENCE = /上次(?:跟|和|与)|前几天|前阵子|前段时间|重刷|刷到|弹幕|撸串|唠嗑|第一次刷|盯着屏幕/;
const TEMPLATE_ENDING = /最后想问|你们觉得|你觉得呢|评论区(?:聊聊|说说|留言)|欢迎(?:在)?评论区/;
const CALL_TO_ACTION = /点赞|关注我|加关注|点个关注|收藏|转发/;
const PROMPT_ECHO = /开头写法|结尾写法|本篇写法/;
// 句首可以直接删掉的口头禅，删完句子依然通顺
const REMOVABLE_FILLERS = /(^|[。！？!?；;，,：:\n])\s*(?:说实在的|你想想|其实啊|别急)[，,：:]?\s*/g;

const MAX_PARAGRAPH_CHARS = 100;

function countChars(text) {
  return String(text || '').replace(/\s/g, '').length;
}

function countMatches(text, patterns) {
  return patterns.reduce((sum, pattern) => sum + (text.match(pattern) || []).length, 0);
}

/** 写作要求被原样抄进正文：按逗号切成片段，任一 8 字以上的片段出现在正文里就算 */
function echoesInstruction(text, phrases) {
  return (phrases || []).filter(Boolean).some(phrase => (
    phrase.split(/[，,、；;]/).some(part => part.trim().length >= 8 && text.includes(part.trim()))
  ));
}

function extractTextParagraphs(markdown) {
  return removeImageMarkers(String(markdown || ''))
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !/^#{1,6}\s/.test(line));
}

/**
 * 检查文章写法
 * @param {string} markdown 文章 Markdown
 * @param {{allowQuote?: boolean, allowHeadings?: boolean, instructionPhrases?: string[]}} [options]
 *   allowQuote：是否允许标注“（原文）”；allowHeadings：是否允许 ## 小标题（榜单型、清单型）；
 *   instructionPhrases：本篇指定的开头、结尾写法，用来检查是否被抄进正文
 * @returns {{passed: boolean, issues: {type: string, message: string}[], metrics: object}}
 */
function lintArticleStyle(markdown, options = {}) {
  const { allowQuote = false, allowHeadings = false, instructionPhrases = [] } = options;
  const paragraphs = extractTextParagraphs(markdown);
  const text = paragraphs.join('\n');
  const lengths = paragraphs.map(countChars);
  const issues = [];

  const fillers = CHAT_FILLERS.filter(word => text.includes(word));
  if (fillers.length) {
    issues.push({ type: 'filler', message: `出现聊天口头禅：${fillers.join('、')}，删掉或改成直接陈述` });
  }

  const cliches = CLICHES.filter(word => text.includes(word));
  if (cliches.length) {
    issues.push({ type: 'cliche', message: `出现套话：${cliches.join('、')}，删掉或改成直接的判断` });
  }

  const uncertain = UNCERTAIN_WORDS.filter(word => text.includes(word));
  if (uncertain.length) {
    issues.push({ type: 'uncertain', message: `出现不确定的说法：${uncertain.join('、')}，改成确定的判断` });
  }

  const imagery = IMAGERY_WORDS.filter(word => text.includes(word));
  if (imagery.length) {
    issues.push({ type: 'imagery', message: `出现写景、抒情的意象词：${imagery.join('、')}，删掉或改成直接陈述` });
  }

  const rareSlangCount = countMatches(text, RARE_SLANG_PATTERNS);
  const slangCount = countMatches(text, SLANG_PATTERNS) + rareSlangCount;
  if (slangCount > MAX_SLANG) {
    issues.push({ type: 'slang', message: `网络梗用了 ${slangCount} 处，全篇只留一两处，其余改成书面说法` });
  } else if (rareSlangCount > 1) {
    issues.push({ type: 'slang', message: '“牛马”“开香槟”“细思极恐”这类梗全篇最多用一处，其余改成书面说法' });
  }

  const skeletonCounts = SKELETON_WORDS.map(word => ({ word, count: text.split(word).length - 1 }));
  const skeletonTotal = skeletonCounts.reduce((sum, item) => sum + item.count, 0);
  const overused = skeletonCounts.filter(item => item.count > MAX_SKELETON_EACH);
  if (overused.length || skeletonTotal > MAX_SKELETON_TOTAL) {
    const detail = overused.length
      ? overused.map(item => `“${item.word}”${item.count} 次`).join('、')
      : `合计 ${skeletonTotal} 次`;
    issues.push({ type: 'skeleton-overuse', message: `连接词堆得太密（${detail}），删掉多余的，同一个词不超过三次` });
  }

  if (!/[？?]/.test(text)) {
    issues.push({ type: 'no-question', message: '全篇没有一处设问，挑一两处改成“那么问题来了，……？”再紧接着自答' });
  }

  const longCount = lengths.filter(length => length > MAX_PARAGRAPH_CHARS).length;
  if (longCount) {
    issues.push({ type: 'long-paragraph', message: `有 ${longCount} 段超过 ${MAX_PARAGRAPH_CHARS} 字，按意思拆成两三句一段` });
  }

  if (FAKE_EXPERIENCE.test(paragraphs.slice(0, 2).join(''))) {
    issues.push({ type: 'fake-experience', message: '开头编造了个人经历（聊天、刷剧、看弹幕之类），改成从书里的事实或大众印象起笔' });
  }

  const tail = paragraphs.slice(-2).join('');
  if (TEMPLATE_ENDING.test(tail)) {
    issues.push({ type: 'template-ending', message: '结尾用了固定的提问模板，改成一句定性的判断收住' });
  }
  if (CALL_TO_ACTION.test(tail)) {
    issues.push({ type: 'call-to-action', message: '结尾出现了点赞、关注、收藏之类的引流话术，删掉' });
  }
  if ((tail.match(/[？?]/g) || []).length > 2) {
    issues.push({ type: 'ending-questions', message: '结尾连续抛了多个问题，只保留一个，或改成一句判断' });
  }

  const quoteCount = (text.match(/[（(]原文[）)]/g) || []).length;
  if (!allowQuote && quoteCount) {
    issues.push({ type: 'quote', message: '这部作品不要标注“（原文）”，把引文改成用自己的话转述' });
  } else if (quoteCount > 1) {
    issues.push({ type: 'quote', message: '“（原文）”引用超过一处，只保留最有把握的一处' });
  }

  if ((text.match(/不是[^。！？\n]{1,30}而是/g) || []).length > 1) {
    issues.push({ type: 'not-but', message: '“不是……而是……”句式用了不止一次，只保留一处，其余改成直接下判断' });
  }

  if (PROMPT_ECHO.test(text) || echoesInstruction(text, instructionPhrases)) {
    issues.push({ type: 'prompt-echo', message: '正文里出现了写作要求本身的文字，删掉这句，直接写内容' });
  }

  if (!allowHeadings && /^##\s/m.test(String(markdown || ''))) {
    issues.push({ type: 'heading', message: '这类文章不用小标题，删掉 ## 小标题，把它的意思并入前后段落' });
  }

  const totalChars = lengths.reduce((sum, length) => sum + length, 0);
  return {
    passed: issues.length === 0,
    issues,
    metrics: {
      chars: totalChars,
      paragraphs: paragraphs.length,
      avgParagraph: paragraphs.length ? Math.round(totalChars / paragraphs.length) : 0,
      maxParagraph: lengths.length ? Math.max(...lengths) : 0,
      skeletonWords: skeletonTotal,
      slang: slangCount,
    },
  };
}

/** 删掉句首可以直接去掉的口头禅，作为定向改写后的兜底 */
function stripRemovableFillers(markdown) {
  return String(markdown || '').replace(REMOVABLE_FILLERS, '$1');
}

module.exports = { lintArticleStyle, stripRemovableFillers };
