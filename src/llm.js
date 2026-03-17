/**
 * 统一 LLM 调用 - 豆包
 */

const axios = require('axios');
const env = require('./env');

async function callLLM(prompt, options = {}) {
  const { maxTokens = 4000, retries = 3 } = options;
  const apiKey = env.doubaoKey();
  if (!apiKey) {
    console.error('DOUBAO_API_KEY 未配置');
    return null;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { data } = await axios.post(
        'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
        {
          model: env.doubaoModel(),
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          thinking: { type: 'disabled' },
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 180000,
        }
      );
      const content = data.choices?.[0]?.message?.content || '';
      if (content.trim()) return content.trim();
      return null;
    } catch (e) {
      const status = e.response?.status;
      const isTimeout = e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT';
      if ((status === 429 || isTimeout) && attempt < retries) {
        const delay = isTimeout ? attempt * 15 : attempt * 10;
        const reason = isTimeout ? '超时' : '限流(429)';
        console.warn(`  ⚠ API ${reason}，${delay}s 后重试 (${attempt}/${retries})`);
        await new Promise(r => setTimeout(r, delay * 1000));
        continue;
      }
      console.error(`  豆包调用失败: ${e.message}`);
      return null;
    }
  }
  return null;
}

module.exports = { callLLM };
