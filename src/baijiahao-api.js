/**
 * 百家号 API - Cookie + 内部接口方案
 */

const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const env = require('./env');

class BaijiahaoAPI {
  constructor(cookieStr) {
    this.authToken = '';
    this.userInfo = null;

    const cookie = cookieStr || env.cookie();

    this.client = axios.create({
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://baijiahao.baidu.com',
        'Referer': 'https://baijiahao.baidu.com/',
        'Cookie': cookie,
      },
      timeout: 30000,
    });
  }

  // ==================== 认证 ====================

  async checkAuth() {
    try {
      const { data } = await this.client.get(
        `https://baijiahao.baidu.com/builder/app/appinfo?_=${Date.now()}`
      );
      if (data.errmsg === 'success' && data.data?.user) {
        this.userInfo = data.data.user;
        console.log(`✓ 已登录: ${this.userInfo.name} (ID: ${this.userInfo.userid})`);
        return { success: true, name: this.userInfo.name, userid: this.userInfo.userid };
      }
      console.log('✗ 未登录或 Cookie 已失效');
      return { success: false };
    } catch (e) {
      console.log(`✗ 检查登录失败: ${e.message}`);
      return { success: false };
    }
  }

  async fetchAuthToken() {
    try {
      const { data: html } = await this.client.get(
        'https://baijiahao.baidu.com/builder/rc/edit'
      );
      const match = html.match(/window\.__BJH__INIT__AUTH__\s*=\s*['"]([^'"]+)['"]/);
      if (!match) {
        throw new Error('获取 auth token 失败，Cookie 可能已失效');
      }
      this.authToken = match[1];
      return this.authToken;
    } catch (e) {
      throw new Error(`获取 auth token 失败: ${e.message}`);
    }
  }

  // ==================== 文章列表 ====================

  /**
   * 从文章对象中提取时间戳（毫秒）
   * @returns {number} 毫秒时间戳，无法解析返回 0
   */
  _getArticleTimestamp(article) {
    const raw = article.publish_time || article.created_at || '';
    if (!raw) return 0;
    if (typeof raw === 'number' || /^\d+$/.test(raw)) {
      const num = Number(raw);
      return num > 1e12 ? num : num * 1000;
    }
    const parsed = new Date(raw).getTime();
    return isNaN(parsed) ? 0 : parsed;
  }

  /**
   * 拉取文章列表（单页）
   * @param {number} page 页码，从 1 开始
   * @param {number} pageSize 每页数量，最大 100
   * @returns {{ list: Array, totalCount: number, totalPage: number }}
   */
  async fetchArticleList(page = 1, pageSize = 100) {
    if (!this.authToken) {
      await this.fetchAuthToken();
    }

    const { data } = await this.client.get(
      'https://baijiahao.baidu.com/pcui/article/lists',
      {
        params: {
          currentPage: page,
          pageSize,
          search: '',
          type: '',
          collection: '',
          startDate: '',
          endDate: '',
          clearBeforeFetch: false,
          dynamic: 1,
        },
        headers: { token: this.authToken },
      }
    );

    if (data.errno !== 0 || !data.data) {
      throw new Error(`文章列表获取失败: ${data.errmsg || '未知错误'}`);
    }

    const { list = [], page: pageInfo = {} } = data.data;
    return {
      list,
      totalCount: pageInfo.totalCount || 0,
      totalPage: pageInfo.totalPage || 0,
    };
  }

  /**
   * 拉取最近半个月已发布文章，返回格式化的统计数据
   * 接口按时间倒序返回，遇到超过15天前的文章自动停止分页
   * @param {number} topN 每个维度返回的数量
   * @returns {{ byClickRate: Array, byRecLowClickRate: Array }}
   */
  async fetchTopArticles(topN = 10) {
    const allArticles = [];
    const pageSize = 20; // 超过20时接口不返回阅读/推荐数据
    const cutoffTs = Date.now() - 15 * 24 * 60 * 60 * 1000; // 15天前

    // 第一页拿总页数（带重试）
    let first;
    for (let retry = 0; retry < 3; retry++) {
      try {
        if (retry > 0) await new Promise(r => setTimeout(r, 2000));
        first = await this.fetchArticleList(1, pageSize);
        break;
      } catch (e) {
        if (retry === 2) throw e;
        console.error(`  第 1 页拉取失败，${retry + 1}/3 次重试...`);
      }
    }
    allArticles.push(...first.list);
    const totalPage = first.totalPage;

    // 拉取剩余页（间隔 1s 避免限流，失败重试 1 次）
    let reachedCutoff = false;
    for (let p = 2; p <= totalPage; p++) {
      if (reachedCutoff) break;
      let list = null;
      for (let retry = 0; retry < 2; retry++) {
        try {
          await new Promise(r => setTimeout(r, 1000));
          const result = await this.fetchArticleList(p, pageSize);
          list = result.list;
          break;
        } catch (e) {
          if (retry === 0) {
            console.error(`  第 ${p} 页拉取失败，重试中...`);
          } else {
            console.error(`  第 ${p} 页拉取失败: ${e.message}，停止翻页`);
          }
        }
      }
      if (!list) break;
      for (const item of list) {
        allArticles.push(item);
      }
      // 检查本页最后一条是否已超过截止日期
      if (list.length > 0) {
        const last = list[list.length - 1];
        const ts = this._getArticleTimestamp(last);
        if (ts > 0 && ts < cutoffTs) {
          reachedCutoff = true;
        }
      }
    }

    // 按时间过滤：只保留最近15天
    const filtered = allArticles.filter(a => {
      const ts = this._getArticleTimestamp(a);
      return ts === 0 || ts >= cutoffTs; // ts=0 说明无法解析，保留
    });

    // 过滤视频，只保留已发布图文；阅读量低于200的不参与分析
    const newsArticles = filtered.filter(a => a.type === 'news' && a.status === 'publish' && (a.read_amount || 0) >= 200);
    console.log(`  共拉取 ${allArticles.length} 篇，最近15天 ${filtered.length} 篇，图文(阅读≥200) ${newsArticles.length} 篇`);

    const format = a => ({
      title: a.title,
      article_id: a.article_id || a.id,
      read_amount: a.read_amount || 0,
      rec_amount: a.rec_amount || 0,
      click_rate: (a.rec_amount > 0) ? ((a.read_amount || 0) / a.rec_amount * 100).toFixed(1) + '%' : '0%',
      comment_amount: a.comment_amount || 0,
      share_amount: a.share_amount || 0,
      like_amount: a.like_amount || 0,
    });

    // 按点击率排序（阅读量/推荐量），过滤推荐量过低的文章
    const byClickRate = [...newsArticles]
      .filter(a => (a.rec_amount || 0) >= 10)
      .sort((a, b) => {
        const rateA = (a.read_amount || 0) / (a.rec_amount || 1);
        const rateB = (b.read_amount || 0) / (b.rec_amount || 1);
        return rateB - rateA;
      })
      .slice(0, topN)
      .map(format);

    // 高推荐低点击率（内容被平台认可但标题/封面不够吸引人）
    const byRecLowClickRate = [...newsArticles]
      .filter(a => (a.rec_amount || 0) >= 50)
      .sort((a, b) => {
        const rateA = (a.read_amount || 0) / (a.rec_amount || 1);
        const rateB = (b.read_amount || 0) / (b.rec_amount || 1);
        return rateA - rateB;
      })
      .slice(0, topN)
      .map(format);

    return { byClickRate, byRecLowClickRate };
  }

  // ==================== 图片上传 ====================

  async uploadImage(imagePath) {
    if (!fs.existsSync(imagePath)) {
      console.error(`图片不存在: ${imagePath}`);
      return null;
    }

    const ext = path.extname(imagePath).toLowerCase();
    const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
    const mimeType = mimeMap[ext] || 'image/jpeg';

    const form = new FormData();
    form.append('media', fs.createReadStream(imagePath), { contentType: mimeType, filename: path.basename(imagePath) });
    form.append('type', 'image');
    form.append('app_id', '1589639493090963');
    form.append('is_waterlog', '1');
    form.append('save_material', '1');
    form.append('no_compress', '0');
    form.append('is_events', '');
    form.append('article_type', 'news');

    try {
      const { data } = await this.client.post(
        'https://baijiahao.baidu.com/pcui/picture/uploadproxy',
        form,
        { headers: form.getHeaders() }
      );
      if (data.errmsg === 'success' && data.ret?.https_url) {
        console.log(`  图片上传成功: ${data.ret.https_url}`);
        return data.ret.https_url;
      }
      console.error(`  图片上传失败: ${data.errmsg || '未知错误'}`);
      return null;
    } catch (e) {
      console.error(`  图片上传异常: ${e.message}`);
      return null;
    }
  }

  async uploadImageFromUrl(imageUrl) {
    try {
      const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
      const contentType = imgResp.headers['content-type'] || 'image/jpeg';
      let ext = '.jpg';
      if (contentType.includes('png')) ext = '.png';
      else if (contentType.includes('gif')) ext = '.gif';
      else if (contentType.includes('webp')) ext = '.webp';

      const form = new FormData();
      form.append('media', Buffer.from(imgResp.data), { contentType, filename: `image${ext}` });
      form.append('type', 'image');
      form.append('app_id', '1589639493090963');
      form.append('is_waterlog', '1');
      form.append('save_material', '1');
      form.append('no_compress', '0');
      form.append('is_events', '');
      form.append('article_type', 'news');

      const { data } = await this.client.post(
        'https://baijiahao.baidu.com/pcui/picture/uploadproxy',
        form,
        { headers: form.getHeaders() }
      );
      if (data.errmsg === 'success' && data.ret?.https_url) {
        return data.ret.https_url;
      }
      return null;
    } catch (e) {
      console.error(`  图片上传异常: ${e.message}`);
      return null;
    }
  }

  // ==================== 草稿箱 ====================

  async saveDraft(title, content, coverImages) {
    if (!this.authToken) {
      try {
        await this.fetchAuthToken();
      } catch (e) {
        return { success: false, article_id: '', draft_url: '', message: e.message };
      }
    }

    const postData = new URLSearchParams({
      title,
      content,
      feed_cat: '1',
      len: String(content.length),
      activity_list: JSON.stringify([{ id: 408, is_checked: 0 }]),
      source_reprinted_allow: '0',
      original_status: '0',
      original_handler_status: '1',
      isBeautify: 'false',
      subtitle: '',
      bjhtopic_id: '',
      bjhtopic_info: '',
      type: 'news',
      domain: '影视',
    });

    postData.append('cate_user_cms[cate_d1]', '影视');
    postData.append('cate_user_cms[cate_d2]', '奇魔玄幻');

    if (coverImages && coverImages.length > 0) {
      postData.set('cover_images', JSON.stringify(coverImages));
    }

    try {
      const { data } = await this.client.post(
        'https://baijiahao.baidu.com/pcui/article/save?callback=bjhdraft',
        postData.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'token': this.authToken,
          },
          responseType: 'text',
          transformResponse: [d => d],
        }
      );

      let result;
      if (typeof data === 'string') {
        const jsonStr = data.replace(/^bjhdraft\(/, '').replace(/\);?\s*$/, '');
        result = JSON.parse(jsonStr);
      } else {
        result = data;
      }

      if (result.errmsg === 'success' && result.ret?.article_id) {
        const articleId = result.ret.article_id;
        const draftUrl = `https://baijiahao.baidu.com/builder/rc/edit?type=news&article_id=${articleId}`;
        console.log(`  草稿保存成功: ${title} (ID: ${articleId})`);
        return { success: true, article_id: String(articleId), draft_url: draftUrl, message: '已保存到草稿箱' };
      }

      const msg = result.errmsg || '保存失败';
      console.error(`  草稿保存失败: ${msg}`);
      return { success: false, article_id: '', draft_url: '', message: msg };
    } catch (e) {
      console.error(`  请求异常: ${e.message}`);
      return { success: false, article_id: '', draft_url: '', message: e.message };
    }
  }

  // ==================== 发布 ====================

  async fetchPublishTokens(articleId) {
    try {
      const url = articleId
        ? `https://baijiahao.baidu.com/builder/rc/edit?type=news&article_id=${articleId}`
        : 'https://baijiahao.baidu.com/builder/rc/edit';
      const { data: html } = await this.client.get(url);

      const authMatch = html.match(/window\.__BJH__INIT__AUTH__\s*=\s*['"]([^'"]+)['"]/);
      if (authMatch) {
        this.authToken = authMatch[1];
      }

      let acsToken = '';
      const acsMatch = html.match(/acsToken\s*[=:]\s*['"]([^'"]+)['"]/);
      if (acsMatch) {
        acsToken = acsMatch[1];
      }

      return { authToken: this.authToken, acsToken };
    } catch (e) {
      throw new Error(`获取发布 token 失败: ${e.message}`);
    }
  }

  async publishArticle(articleId, title, content, coverImages = []) {
    const tokens = await this.fetchPublishTokens(articleId);
    if (!tokens.authToken) {
      return { success: false, article_id: articleId, message: '获取 auth token 失败' };
    }

    const nonce = crypto.randomBytes(16).toString('hex');

    const postData = new URLSearchParams({
      type: 'news',
      title,
      content,
      abstract: '',
      auto_mount_goods: '0',
      len: String(content.length),
      source_reprinted_allow: '0',
      abstract_from: '1',
      isBeautify: 'false',
      usingImgFilter: 'false',
      cover_layout: coverImages.length ? 'one' : 'no_image',
      _cover_images_map: '[]',
      source: 'upload',
      cover_source: coverImages.length ? 'upload' : '',
      subtitle: '',
      bjhtopic_id: '',
      bjhtopic_info: '',
      clue: '',
      bjhmt: '',
      order_id: '',
      BJH_FE_NOUNCE: nonce,
      aigc_rebuild: '',
      image_edit_point: JSON.stringify([
        { img_type: 'cover', img_num: { template: 0, font: 0, filter: 0, paster: 0, cut: 0, any: 0 } },
        { img_type: 'body', img_num: { template: 0, font: 0, filter: 0, paster: 0, cut: 0, any: 0 } },
      ]),
      article_id: String(articleId),
    });

    const activities = [
      { id: 'ttv', is_checked: 1 },
      { id: 'ai_tts', is_checked: 1 },
      { id: 'reward', is_checked: 0 },
      { id: 'aigc_bjh_status', is_checked: 0 },
    ];
    activities.forEach((act, i) => {
      postData.append(`activity_list[${i}][id]`, act.id);
      postData.append(`activity_list[${i}][is_checked]`, String(act.is_checked));
    });

    if (coverImages.length) {
      const covers = coverImages.map(c => ({
        src: c.src,
        cropData: c.cropData || {},
        machine_chooseimg: 0,
        isLegal: 0,
      }));
      postData.set('cover_images', JSON.stringify(covers));
    }

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'token': tokens.authToken,
    };
    if (tokens.acsToken) {
      headers['Acs-Token'] = tokens.acsToken;
    }

    try {
      const { data } = await this.client.post(
        'https://baijiahao.baidu.com/pcui/article/publish?type=news&callback=bjhpublish',
        postData.toString(),
        {
          headers,
          responseType: 'text',
          transformResponse: [d => d],
        }
      );

      let result;
      if (typeof data === 'string') {
        const jsonStr = data.replace(/^bjhpublish\(/, '').replace(/\);?\s*$/, '');
        result = JSON.parse(jsonStr);
      } else {
        result = data;
      }

      if (result.errmsg === 'success') {
        const publishUrl = `https://baijiahao.baidu.com/s?id=${articleId}`;
        console.log(`  发布成功: ${title}`);
        return { success: true, article_id: String(articleId), publish_url: publishUrl, message: '已发布' };
      }

      const msg = result.errmsg || '发布失败';
      console.error(`  发布失败: ${msg} (errno: ${result.errno || ''})`);
      return { success: false, article_id: String(articleId), message: msg };
    } catch (e) {
      console.error(`  发布请求异常: ${e.message}`);
      return { success: false, article_id: String(articleId), message: e.message };
    }
  }

  // ==================== HTML 处理 ====================

  async processContentImages(htmlContent) {
    const skipPatterns = ['baijiahao.baidu.com', 'bdstatic.com', 'bcebos.com'];
    const imgRegex = /<img[^>]+src="([^"]+)"/g;
    let result = htmlContent;
    let match;
    const replacements = [];

    while ((match = imgRegex.exec(htmlContent)) !== null) {
      const src = match[1];
      if (!src || skipPatterns.some(p => src.includes(p))) continue;

      const decodedSrc = decodeURIComponent(src);

      let newUrl = null;
      if (fs.existsSync(decodedSrc)) {
        newUrl = await this.uploadImage(decodedSrc);
      } else if (fs.existsSync(src)) {
        newUrl = await this.uploadImage(src);
      } else if (src.startsWith('http')) {
        newUrl = await this.uploadImageFromUrl(src);
      }
      if (newUrl) {
        replacements.push({ old: src, new: newUrl });
      }
    }

    for (const r of replacements) {
      result = result.split(r.old).join(r.new);
    }
    return result;
  }

  static cleanHtml(html) {
    let c = html;
    c = c.replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '');
    c = c.replace(/<iframe[^>]*\/>/gi, '');
    c = c.replace(/<img[^>]+src="[^"]*\.svg"[^>]*>/gi, '');
    c = c.replace(/<img([^>]*)data-src="([^"]+)"([^>]*)>/gi, (m, before, dataSrc, after) => {
      if (/src="[^"]+"/.test(before + after)) return m;
      return `<img${before}src="${dataSrc}" data-src="${dataSrc}"${after}>`;
    });
    return c;
  }
}

function saveCookie(cookieStr) {
  env.updateCookie(cookieStr);
}

module.exports = { BaijiahaoAPI, saveCookie };
