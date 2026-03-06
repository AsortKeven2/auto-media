/**
 * 头条号 API - Cookie + 内部接口方案
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const env = require('./env');

class ToutiaoAPI {
  constructor(cookieStr) {
    const cookie = cookieStr || env.toutiaoCookie();

    this.client = axios.create({
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://mp.toutiao.com',
        'Referer': 'https://mp.toutiao.com/profile_v4/graphic/publish',
        'Cookie': cookie,
      },
      timeout: 30000,
    });
  }

  // ==================== 认证 ====================

  async checkAuth() {
    try {
      const { data } = await this.client.get(
        'https://mp.toutiao.com/mp/agw/media/get_media_info'
      );

      if (data.data?.user?.id) {
        const user = data.data.user;
        console.log(`✓ 头条已登录: ${user.screen_name} (ID: ${user.id})`);
        return { success: true, name: user.screen_name, userid: String(user.id) };
      }
      console.log('✗ 头条未登录或 Cookie 已失效');
      return { success: false };
    } catch (e) {
      console.log(`✗ 头条检查登录失败: ${e.message}`);
      return { success: false };
    }
  }

  // ==================== CSRF Token ====================

  async getCsrfToken() {
    try {
      const res = await this.client.head('https://mp.toutiao.com/ttwid/check/', {
        headers: {
          'x-secsdk-csrf-request': '1',
          'x-secsdk-csrf-version': '1.2.22',
        },
      });
      return res.headers['x-ware-csrf-token'] || '';
    } catch (e) {
      console.error(`获取 CSRF token 失败: ${e.message}`);
      return '';
    }
  }

  // ==================== 图片上传 ====================

  async uploadImage(imagePath, retries = 3) {
    if (!fs.existsSync(imagePath)) {
      console.error(`图片不存在: ${imagePath}`);
      return null;
    }

    const ext = path.extname(imagePath).toLowerCase();
    const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
    const mimeType = mimeMap[ext] || 'image/jpeg';

    for (let attempt = 1; attempt <= retries; attempt++) {
      const csrfToken = await this.getCsrfToken();
      const form = new FormData();
      form.append('image', fs.createReadStream(imagePath), { contentType: mimeType, filename: path.basename(imagePath) });

      try {
        const { data } = await this.client.post(
          'https://mp.toutiao.com/spice/image?upload_source=20020002&aid=1231&device_platform=web',
          form,
          {
            headers: {
              ...form.getHeaders(),
              'x-secsdk-csrf-token': csrfToken,
            },
            timeout: 60000,
          }
        );

        if (data.code === 0 && data.data?.image_url) {
          console.log(`  图片上传成功: ${data.data.image_url}`);
          return {
            url: data.data.image_url,
            uri: data.data.image_uri || '',
            width: data.data.image_width || 0,
            height: data.data.image_height || 0,
          };
        }
        console.error(`  图片上传失败: ${data.message || '未知错误'}`);
        return null;
      } catch (e) {
        console.error(`  图片上传异常 (${attempt}/${retries}): ${e.message}`);
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }
    return null;
  }

  async uploadImageFromUrl(imageUrl, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const imgResp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 30000 });
        const contentType = imgResp.headers['content-type'] || 'image/jpeg';
        let ext = '.jpg';
        if (contentType.includes('png')) ext = '.png';
        else if (contentType.includes('gif')) ext = '.gif';
        else if (contentType.includes('webp')) ext = '.webp';

        const csrfToken = await this.getCsrfToken();

        const form = new FormData();
        form.append('image', Buffer.from(imgResp.data), { contentType, filename: `image${ext}` });

        const { data } = await this.client.post(
          'https://mp.toutiao.com/spice/image?upload_source=20020002&aid=1231&device_platform=web',
          form,
          {
            headers: {
              ...form.getHeaders(),
              'x-secsdk-csrf-token': csrfToken,
            },
            timeout: 60000,
          }
        );

        if (data.code === 0 && data.data?.image_url) {
          return {
            url: data.data.image_url,
            uri: data.data.image_uri || '',
            width: data.data.image_width || 0,
            height: data.data.image_height || 0,
          };
        }
        return null;
      } catch (e) {
        console.error(`  图片上传异常 (${attempt}/${retries}): ${e.message}`);
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }
    return null;
  }

  // ==================== 草稿/发布 ====================

  async saveDraft(title, content, coverImages) {
    return this._publish(title, content, coverImages, true);
  }

  async publishArticle(title, content, coverImages) {
    return this._publish(title, content, coverImages, false);
  }

  async _publish(title, content, coverImages, isDraft) {
    const titleId = `${Date.now()}_${Math.random().toString().slice(2, 18)}`;

    const extra = JSON.stringify({
      content_source: 100000000402,
      content_word_cnt: content.length,
      is_multi_title: 0,
      sub_titles: [],
      gd_ext: {
        entrance: '',
        from_page: 'publisher_mp',
        enter_from: 'PC',
        device_platform: 'mp',
        is_message: 0,
      },
      tuwen_wtt_trans_flag: '0',
      info_source: {
        source_type: 5,
        source_author_uid: '',
        time_format: '',
        position: {},
      },
    });

    // 封面：单图大封面
    let pgcFeedCovers = '[]';
    let coverType = 0;
    if (coverImages && coverImages.length > 0) {
      coverType = 2;
      pgcFeedCovers = JSON.stringify(coverImages.map(c => ({
        extra: { from_content_idx: '0', from_content_uri: '' },
        origin_uri: c.uri || '',
        thumb_height: c.height || 0,
        thumb_url: c.uri || '',
        thumb_width: c.width || 0,
        url: c.url || '',
        uri: c.uri || '',
        width: c.width || 0,
        height: c.height || 0,
        ic_uri: '',
      })));
    }

    const postData = new URLSearchParams({
      article_type: '0',
      pgc_id: '0',
      source: '29',
      extra,
      content,
      title,
      search_creation_info: JSON.stringify({ searchTopOne: 0, abstract: '', clue_id: '' }),
      title_id: titleId,
      mp_editor_stat: '{}',
      is_refute_rumor: '0',
      save: isDraft ? '1' : '0',
      entrance: 'main',
      timer_status: '0',
      timer_time: '',
      educluecard: '',
      draft_form_data: JSON.stringify({ coverType }),
      pgc_feed_covers: pgcFeedCovers,
      article_ad_type: '3',
      is_fans_article: '0',
      govern_forward: '0',
      praise: '0',
      disable_praise: '0',
      tree_plan_article: '0',
      activity_tag: '0',
      trends_writing_tag: '0',
      claim_exclusive: '0',
    });

    try {
      const { data } = await this.client.post(
        'https://mp.toutiao.com/mp/agw/article/publish?source=mp&type=article&aid=1231',
        postData.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        }
      );

      if (data.err_no === 0 && data.data?.pgc_id) {
        const pgcId = data.data.pgc_id;
        const draftUrl = `https://mp.toutiao.com/profile_v4/graphic/publish?pgc_id=${pgcId}`;
        const mode = isDraft ? '草稿' : '发布';
        console.log(`  头条${mode}成功: ${title} (pgc_id: ${pgcId})`);
        return {
          success: true,
          article_id: String(pgcId),
          draft_url: draftUrl,
          message: `已保存到${mode}`,
        };
      }

      const msg = data.message || '操作失败';
      console.error(`  头条操作失败: ${msg}`);
      return { success: false, article_id: '', draft_url: '', message: msg };
    } catch (e) {
      console.error(`  头条请求异常: ${e.message}`);
      return { success: false, article_id: '', draft_url: '', message: e.message };
    }
  }

  // ==================== HTML 处理 ====================

  async processContentImages(htmlContent) {
    const skipPatterns = ['pstatp.com', 'toutiao.com', 'byteimg.com'];
    const imgRegex = /<img[^>]+src="([^"]+)"/g;
    let result = htmlContent;
    let match;
    const replacements = [];

    while ((match = imgRegex.exec(htmlContent)) !== null) {
      const src = match[1];
      if (!src || skipPatterns.some(p => src.includes(p))) continue;

      const decodedSrc = decodeURIComponent(src);

      let uploadResult = null;
      if (fs.existsSync(decodedSrc)) {
        uploadResult = await this.uploadImage(decodedSrc);
      } else if (fs.existsSync(src)) {
        uploadResult = await this.uploadImage(src);
      } else if (src.startsWith('http')) {
        uploadResult = await this.uploadImageFromUrl(src);
      }

      if (uploadResult) {
        replacements.push({ old: src, new: uploadResult.url });
      }
    }

    for (const r of replacements) {
      result = result.split(r.old).join(r.new);
    }

    // 头条特有：图片包裹 pgc-img
    result = result.replace(
      /<img\s+([^>]+)>/gi,
      '<div class="pgc-img"><img $1><p class="pgc-img-caption"></p></div>'
    );

    return result;
  }

  static cleanHtml(html) {
    let c = html;
    c = c.replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '');
    c = c.replace(/<iframe[^>]*\/>/gi, '');
    c = c.replace(/<img[^>]+src="[^"]*\.svg"[^>]*>/gi, '');
    c = c.replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, '$1');
    c = c.replace(/<figure[^>]*>\s*<\/figure>/gi, '');
    return c;
  }
}

module.exports = { ToutiaoAPI };
