/**
 * 热点抓取 — 百度/微博/头条聚合
 */

const https = require('https');

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...headers,
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function fetchBaiduHot() {
  try {
    const raw = await httpGet('https://top.baidu.com/api/board?tab=realtime');
    const json = JSON.parse(raw);
    const cards = json?.data?.cards || [];
    const items = cards[0]?.content || [];
    return items.map(item => ({
      title: item.word || item.query,
      desc: item.desc || '',
      hotScore: parseInt(item.hotScore || item.num || 0),
      source: '百度',
      url: item.url || `https://www.baidu.com/s?wd=${encodeURIComponent(item.word)}`,
    }));
  } catch (e) {
    console.log(`百度热搜抓取失败: ${e.message}`);
    return [];
  }
}

async function fetchWeiboHot() {
  try {
    const raw = await httpGet('https://weibo.com/ajax/side/hotSearch', {
      'Referer': 'https://weibo.com/',
      'Cookie': 'SUB=_2AkMR',
      'X-Requested-With': 'XMLHttpRequest',
      'Accept': 'application/json, text/plain, */*',
    });
    const json = JSON.parse(raw);
    const list = json?.data?.realtime || [];
    return list.map(item => ({
      title: item.note || item.word,
      desc: item.label_name || '',
      hotScore: parseInt(item.num || 0),
      source: '微博',
      url: `https://s.weibo.com/weibo?q=${encodeURIComponent('#' + (item.note || item.word) + '#')}`,
    }));
  } catch (e) {
    // 备用：微博热搜榜 API
    try {
      const raw2 = await httpGet('https://weibo.com/ajax/statuses/hot_band', {
        'Referer': 'https://weibo.com/',
        'Cookie': 'SUB=_2AkMR',
      });
      const json2 = JSON.parse(raw2);
      const list2 = json2?.data?.band_list || [];
      return list2.map(item => ({
        title: item.note || item.word,
        desc: item.category || '',
        hotScore: parseInt(item.num || item.raw_hot || 0),
        source: '微博',
        url: `https://s.weibo.com/weibo?q=${encodeURIComponent('#' + (item.note || item.word) + '#')}`,
      }));
    } catch (e2) {
      console.log(`微博热搜抓取失败: ${e.message} / ${e2.message}`);
      return [];
    }
  }
}

async function fetchToutiaoHot() {
  try {
    const raw = await httpGet('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc');
    const json = JSON.parse(raw);
    const list = json?.data || [];
    return list.map(item => ({
      title: item.Title || item.title,
      desc: item.Abstract || '',
      hotScore: parseInt(item.HotValue || item.hot_value || 0),
      source: '头条',
      url: item.Url || item.url || '',
    }));
  } catch (e) {
    console.log(`头条热榜抓取失败: ${e.message}`);
    return [];
  }
}

async function fetchZhihuHot() {
  try {
    const raw = await httpGet('https://api.zhihu.com/topstory/hot-lists/total?limit=50', {
      'Referer': 'https://www.zhihu.com/',
      'Accept': 'application/json',
    });
    const json = JSON.parse(raw);
    const list = json?.data || [];
    return list.map(item => ({
      title: item.target?.title || '',
      desc: item.target?.excerpt || '',
      hotScore: parseInt(item.detail_text?.replace(/[^\d]/g, '') || 0),
      source: '知乎',
      url: `https://www.zhihu.com/question/${item.target?.id || ''}`,
    })).filter(t => t.title);
  } catch (e) {
    console.log(`知乎热榜抓取失败: ${e.message}`);
    return [];
  }
}

/**
 * 聚合四平台热点，按热度排序，标题去重，自动分类
 */
async function fetchAllHotTopics() {
  const [baidu, weibo, toutiao, zhihu] = await Promise.all([
    fetchBaiduHot(),
    fetchWeiboHot(),
    fetchToutiaoHot(),
    fetchZhihuHot(),
  ]);

  const all = [...baidu, ...weibo, ...toutiao, ...zhihu];

  // 标题去重（取热度高的）
  const map = new Map();
  for (const item of all) {
    const key = item.title.replace(/\s+/g, '');
    if (!map.has(key) || map.get(key).hotScore < item.hotScore) {
      map.set(key, item);
    }
  }

  const topics = Array.from(map.values()).sort((a, b) => b.hotScore - a.hotScore);

  // 自动分类
  for (const t of topics) {
    t.category = classifyTopic(t.title + (t.desc || ''));
  }

  return topics;
}

/**
 * 关键词分类
 */
const CATEGORY_RULES = [
  { name: '民生', keywords: ['房价', '房贷', '物价', '油价', '电价', '水费', '涨价', '降价', '工资', '社保', '医保', '养老', '退休', '就业', '失业', '裁员', '加班', '996', '打工', '上班', '通勤', '租房', '买房', '教育', '高考', '考研', '学区', '幼儿园', '补课', '医院', '看病', '药', '生育', '三胎', '人口', '老龄化', '菜价', '猪肉', '粮食', '食品安全', '快递', '外卖', '网约车', '地铁', '公交', '堵车', '停车', '小区', '物业', '装修', '水电', '暖气', '供暖', '电费', '燃气'] },
  { name: '社会', keywords: ['法院', '判决', '起诉', '犯罪', '诈骗', '偷', '抢', '杀', '事故', '火灾', '地震', '洪水', '台风', '暴雨', '救援', '志愿', '公益', '慈善', '捐', '见义勇为', '正能量', '热议', '争议', '曝光', '举报', '维权', '投诉', '道歉', '回应', '通报', '处罚', '罚款', '拘留', '调查', '真相', '反转', '离婚', '家暴', '校园', '霸凌', '性骚扰', '歧视', '公平', '正义'] },
  { name: '财经', keywords: ['股', 'A股', '基金', '理财', '投资', '融资', '上市', 'IPO', '市值', '营收', '利润', '亏损', '破产', '收购', '合并', '央行', '利率', '降息', '加息', '汇率', '人民币', '美元', '通胀', 'GDP', '经济', '消费', '出口', '进口', '贸易', '关税', '税', '减税', '补贴', '数字货币', '比特币', '芯片', '半导体', '新能源', '光伏', '锂电', '电动车', '特斯拉'] },
  { name: '国际', keywords: ['美国', '俄罗斯', '乌克兰', '日本', '韩国', '朝鲜', '欧洲', '英国', '法国', '德国', '印度', '中东', '以色列', '巴勒斯坦', '伊朗', '叙利亚', '联合国', 'NATO', '北约', '制裁', '外交', '大使', '领事', '峰会', 'G20', '战争', '冲突', '导弹', '核', '军事', '军演', '航母', '战机', '难民', '移民', '签证', '海外', '留学'] },
  { name: '科技', keywords: ['AI', '人工智能', 'ChatGPT', '大模型', '机器人', '自动驾驶', '无人机', '5G', '6G', '芯片', '量子', '航天', '火箭', '卫星', '空间站', '月球', '火星', 'iPhone', '华为', '小米', 'OPPO', '苹果', '谷歌', '微软', '腾讯', '阿里', '字节', '抖音', '微信', 'App', '算法', '数据', '隐私', '网络安全', '黑客', '开源', '编程', '程序员'] },
  { name: '娱乐', keywords: ['明星', '演员', '导演', '电影', '电视剧', '综艺', '选秀', '偶像', '粉丝', '演唱会', '音乐', '歌手', '专辑', '票房', '收视', '热播', '杀青', '开机', '官宣', '恋情', '结婚', '离婚', '出轨', '塌房', '翻车', '道歉', '封杀', '网红', '直播', '带货', '短视频', '游戏', '电竞', '动漫', '春晚', '跨年', '颁奖', '八卦', '绯闻', '分手', '复合', '怀孕', '生子', '整容', '素颜', '红毯', '造型', '穿搭', '热搜', '吃瓜', '瓜', '爆料', '回应', '澄清', '工作室', '经纪人', '剧组', '路透', '生图', '精修', '颜值', '身材', '减肥', '健身', '美妆', '护肤', '时尚', '奢侈品', '代言', '广告', '商务', '片酬', '身价', '豪宅', '豪车', '派对', '聚会', '夜店', '酒吧', '恋爱', '约会', '表白', '求婚', '婚礼', '婚纱', '伴郎', '伴娘', '前任', '现任', 'CP', '嗑', '磕', '站姐', '后援会', '应援', '打榜', '控评', '黑粉', '脱粉', '路人', '好感', '讨厌', '争议', '撕', '互撕', '拉踩', '碰瓷', '蹭', '炒作', '营销', '通稿', '水军', '买热搜', '演技', '唱功', '舞台', '现场', '花絮', '幕后', '采访', '杂志', '封面', '写真', '自拍', 'vlog', '日常'] },
  { name: '体育', keywords: ['世界杯', '奥运', '冠军', '金牌', '决赛', '半决赛', '联赛', '中超', '英超', 'NBA', 'CBA', '足球', '篮球', '乒乓', '羽毛球', '网球', '游泳', '田径', '马拉松', '体操', '跳水', '滑雪', '冰球', '教练', '球员', '转会', '进球', '比分', '淘汰', '晋级', '夺冠'] },
];

function classifyTopic(text) {
  let bestMatch = { name: '其他', score: 0 };
  for (const rule of CATEGORY_RULES) {
    let score = 0;
    for (const kw of rule.keywords) {
      if (text.includes(kw)) score++;
    }
    if (score > bestMatch.score) {
      bestMatch = { name: rule.name, score };
    }
  }
  return bestMatch.name;
}

module.exports = { fetchAllHotTopics, fetchBaiduHot, fetchWeiboHot, fetchToutiaoHot, fetchZhihuHot };
