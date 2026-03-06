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
