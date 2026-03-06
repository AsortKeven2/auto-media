/**
 * 大纲生成器 - AI 驱动（类别感知）
 */

const { callLLM } = require('./llm');
const { getCategory } = require('./categories');

/**
 * 调用 AI 生成大纲（根据类别调整结构）
 */
async function generateOutline(topic, topicType, category) {
  const catDef = category ? getCategory(category) : null;
  const outlineHint = catDef ? catDef.outlineHint : '4-6 个章节，每章一个小标题 + 2-3 个写作要点';

  const prompt = `为以下选题设计文章大纲。

选题：${topic}
类型：${topicType || '自由发挥'}
类别：${category || '自由发挥'}${catDef ? `（${catDef.subtitle}）` : ''}

要求：
1. ${outlineHint}，每章 2-3 个写作要点
2. 结构自由发挥，不要写成八股文，章节标题用口语化的疑问句或感叹句（如"说到这儿，就得聊聊XX了""最让人没想到的是……"），不要用"第一章""一、"这种死板编号
3. 写作要点基于原著/影视真实情节，不要编造，每个要点尽量标注对应的影视名场面或原著情节
4. 第一章必须是"引子/钩子"，用来抛出核心疑问、制造悬念
5. 最后一章必须是"收束/讨论"，用来总结观点并留下开放性问题

输出格式（严格 JSON）：
{"structure": "结构风格", "sections": [{"heading": "章节标题", "points": ["要点1", "要点2"]}]}`;

  const maxAttempts = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const content = await callLLM(prompt, { maxTokens: 1500 });
      if (!content) {
        throw new Error('大纲生成失败');
      }

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('大纲 AI 返回格式异常');
      }

      const parsed = JSON.parse(jsonMatch[0]);
      return {
        title: topic,
        type: topicType || '深度解读',
        category: category || null,
        structure: parsed.structure || '自由结构',
        sections: (parsed.sections || []).map(s => ({
          heading: s.heading,
          points: s.points || [],
        })),
      };
    } catch (e) {
      lastError = e;
      if (attempt < maxAttempts) {
        console.warn(`  ⚠ 大纲生成第${attempt}次失败(${e.message})，重试中...`);
      }
    }
  }

  throw new Error(`大纲生成失败: ${lastError.message}`);
}

function formatOutline(outline) {
  const lines = [];
  lines.push(`# ${outline.title}`);
  lines.push(`\n类型: ${outline.type} | 结构: ${outline.structure}`);
  if (outline.category) lines.push(`类别: ${outline.category}`);
  lines.push('\n---\n');

  outline.sections.forEach((s, i) => {
    lines.push(`## ${i + 1}. ${s.heading}`);
    s.points.forEach(p => lines.push(`  - ${p}`));
    lines.push('');
  });

  return lines.join('\n');
}

module.exports = { generateOutline, formatOutline };
