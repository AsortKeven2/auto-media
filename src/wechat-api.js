/**
 * 微信公众号 API - Cookie + 内部接口方案
 * 通过 mp.weixin.qq.com 后台接口实现图片上传、草稿创建、发布
 */

const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const env = require('./env');

class WechatAPI {
  constructor(cookieStr) {
    this.token = '';
    this.ticket = '';


    const cookie = cookieStr || env.wechatCookie();

    this.client = axios.create({
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'https://mp.weixin.qq.com',
        'Referer': 'https://mp.weixin.qq.com/',
        'Cookie': cookie,
      },
      timeout: 30000,
      maxRedirects: 0,
      validateStatus: s => s < 400,
    });
  }

  // ==================== 认证 ====================

  async checkAuth() {
    try {
      const token = await this.fetchToken();
      if (token) {
        console.log(`✓ 公众号已登录 (token: ${token})`);
        return { success: true, token };
      }
      console.log('✗ 公众号未登录或 Cookie 已失效');
      return { success: false };
    } catch (e) {
      console.log(`✗ 公众号检查登录失败: ${e.message}`);
      return { success: false };
    }
  }

  async fetchToken() {
    if (this.token) return this.token;

    try {
      // 访问根路径，微信会 302 到带 token 的 URL
      const resp = await this.client.get('https://mp.weixin.qq.com/', {
        maxRedirects: 0,
        validateStatus: s => s >= 200 && s < 400,
      });

      // 如果没有重定向直接返回了 200，从 HTML 提取
      if (typeof resp.data === 'string') {
        const htmlMatch = resp.data.match(/token=(\d+)/);
        if (htmlMatch) {
          this.token = htmlMatch[1];
          return this.token;
        }
      }
      throw new Error('无法提取 token，Cookie 可能已失效');
    } catch (e) {
      // 302 重定向 - 从 Location 头提取 token
      if (e.response?.status === 302 || e.response?.status === 301) {
        const location = e.response.headers.location || '';
        const match = location.match(/token=(\d+)/);
        if (match) {
          this.token = match[1];
          return this.token;
        }
      }
      throw new Error(`获取 token 失败: ${e.message}`);
    }
  }

  async fetchTicket() {
    if (this.ticket) return this.ticket;
    if (!this.token) await this.fetchToken();

    try {
      const resp = await this.client.get(
        `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&type=77&appmsgid=&token=${this.token}&lang=zh_CN`,
        { maxRedirects: 5, validateStatus: s => s < 500 }
      );
      if (typeof resp.data === 'string') {
        const match = resp.data.match(/ticket\s*[:=]\s*"([^"]+)"/);
        if (match) {
          this.ticket = match[1];
          return this.ticket;
        }
      }
      throw new Error('无法从编辑页提取 ticket');
    } catch (e) {
      if (e.message.includes('ticket')) throw e;
      throw new Error(`获取 ticket 失败: ${e.message}`);
    }
  }

  generateFingerprint() {
    const seed = (this.ticket || '') + (this.token || '') + String(Date.now());
    return crypto.createHash('md5').update(seed).digest('hex');
  }

  // ==================== 图片上传 ====================

  async uploadImage(imagePath) {
    if (!fs.existsSync(imagePath)) {
      console.error(`图片不存在: ${imagePath}`);
      return null;
    }

    if (!this.token) await this.fetchToken();

    const ext = path.extname(imagePath).toLowerCase();
    const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
    const mimeType = mimeMap[ext] || 'image/jpeg';

    const form = new FormData();
    form.append('file', fs.createReadStream(imagePath), { contentType: mimeType, filename: path.basename(imagePath) });

    try {
      const { data } = await this.client.post(
        `https://mp.weixin.qq.com/cgi-bin/filetransfer?action=upload_material&f=json&scene=1&writetype=doublewrite&groupid=1&token=${this.token}&lang=zh_CN`,
        form,
        {
          headers: form.getHeaders(),
          timeout: 60000,
          maxRedirects: 5,
          validateStatus: s => s < 500,
        }
      );

      if (data.base_resp?.ret === 0 && data.cdn_url) {
        console.log(`  图片上传成功: ${data.cdn_url.slice(0, 60)}...`);
        return {
          url: data.cdn_url,
          fileid: data.content || '',
        };
      }
      console.error(`  图片上传失败: ${JSON.stringify(data.base_resp || data)}`);
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

      if (!this.token) await this.fetchToken();

      const form = new FormData();
      form.append('file', Buffer.from(imgResp.data), { contentType, filename: `image${ext}` });

      const { data } = await this.client.post(
        `https://mp.weixin.qq.com/cgi-bin/filetransfer?action=upload_material&f=json&scene=1&writetype=doublewrite&groupid=1&token=${this.token}&lang=zh_CN`,
        form,
        {
          headers: form.getHeaders(),
          timeout: 60000,
          maxRedirects: 5,
          validateStatus: s => s < 500,
        }
      );

      if (data.base_resp?.ret === 0 && data.cdn_url) {
        return { url: data.cdn_url, fileid: data.content || '' };
      }
      return null;
    } catch (e) {
      console.error(`  图片上传异常: ${e.message}`);
      return null;
    }
  }

  // ==================== 草稿管理 ====================

  // ==================== 文章统计 ====================

  /**
   * 拉取群发文章列表（单页，包含阅读/点赞等统计数据）
   * @param {number} begin 起始偏移（offset 分页）
   * @param {number} count 每页数量（最大10）
   * @returns {{ list: Array, totalCount: number }}
   */
  async fetchSentList(begin = 0, count = 10) {
    if (!this.token) await this.fetchToken();

    const { data } = await this.client.get(
      `https://mp.weixin.qq.com/cgi-bin/newmasssendpage`,
      {
        params: {
          begin,
          count,
          begin_send_time: 0,
          need_stat: 1,
          token: this.token,
          lang: 'zh_CN',
          f: 'json',
          ajax: 1,
        },
        maxRedirects: 5,
        validateStatus: s => s < 500,
      }
    );

    if (data.base_resp?.ret !== 0) {
      throw new Error(`群发列表获取失败: ${data.base_resp?.err_msg || '未知错误'}`);
    }

    return {
      list: data.sent_list || [],
      totalCount: data.total_count || 0,
    };
  }

  /**
   * 拉取最近一周文章数据并更新本地缓存，返回最近15天 top N（按阅读量）
   * 缓存路径：data/wx_articles_cache.json
   * @param {number} topN 返回数量
   * @returns {{ byRead: Array }}
   */
  async fetchTopArticles(topN = 10) {
    const cacheDir = path.join(__dirname, '..', 'data');
    const cachePath = path.join(cacheDir, 'wx_articles_cache.json');

    // 读取现有缓存
    let cached = [];
    if (fs.existsSync(cachePath)) {
      try { cached = JSON.parse(fs.readFileSync(cachePath, 'utf-8')); } catch {}
    }

    // 拉取最近一周的新数据
    const oneWeekAgo = Date.now() / 1000 - 7 * 24 * 60 * 60;
    const freshArticles = [];
    const pageSize = 10;

    let first;
    for (let retry = 0; retry < 3; retry++) {
      try {
        if (retry > 0) await new Promise(r => setTimeout(r, 2000));
        first = await this.fetchSentList(0, pageSize);
        break;
      } catch (e) {
        if (retry === 2) throw e;
        console.error(`  第 1 页拉取失败，${retry + 1}/3 次重试...`);
      }
    }

    this._extractArticles(first.list, freshArticles);
    const totalCount = first.totalCount;

    let reachedCutoff = false;
    for (let begin = pageSize; begin < totalCount; begin += pageSize) {
      if (reachedCutoff) break;
      let list = null;
      for (let retry = 0; retry < 2; retry++) {
        try {
          await new Promise(r => setTimeout(r, 1000));
          const result = await this.fetchSentList(begin, pageSize);
          list = result.list;
          break;
        } catch (e) {
          if (retry === 0) console.error(`  偏移${begin} 拉取失败，重试中...`);
          else console.error(`  偏移${begin} 拉取失败: ${e.message}，停止翻页`);
        }
      }
      if (!list) break;
      this._extractArticles(list, freshArticles);

      // 超过一周就停
      if (list.length > 0) {
        const lastTime = list[list.length - 1].sent_info?.time || 0;
        if (lastTime > 0 && lastTime < oneWeekAgo) reachedCutoff = true;
      }
    }

    // 合并缓存：用新数据覆盖同标题+同时间的旧数据，去重
    const keyOf = a => `${a.title}|${a.send_time}`;
    const merged = new Map();
    for (const a of cached) merged.set(keyOf(a), a);
    for (const a of freshArticles) merged.set(keyOf(a), a); // 新数据覆盖旧数据

    // 只保留最近30天的缓存（避免无限增长）
    const thirtyDaysAgo = Date.now() / 1000 - 30 * 24 * 60 * 60;
    const allCached = [...merged.values()].filter(a => a.send_time === 0 || a.send_time >= thirtyDaysAgo);

    // 写入缓存
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(allCached, null, 2), 'utf-8');

    // 分析用最近15天
    const fifteenDaysAgo = Date.now() / 1000 - 15 * 24 * 60 * 60;
    const recent = allCached.filter(a => a.send_time === 0 || a.send_time >= fifteenDaysAgo);
    console.log(`  本次拉取 ${freshArticles.length} 篇，缓存 ${allCached.length} 篇，最近15天 ${recent.length} 篇`);

    const format = a => ({
      title: a.title,
      read_num: a.read_num || 0,
      like_num: a.like_num || 0,
      share_num: a.share_num || 0,
      comment_num: a.comment_num || 0,
      send_time: a.send_time || 0,
    });

    const byRead = [...recent]
      .sort((a, b) => (b.read_num || 0) - (a.read_num || 0))
      .slice(0, topN)
      .map(format);

    return { byRead };
  }

  /**
   * 从群发列表项中提取单篇文章数据
   */
  _extractArticles(sentList, target) {
    for (const item of sentList) {
      const sendTime = item.sent_info?.time || 0;
      const articles = item.appmsg_info || [];
      for (const a of articles) {
        target.push({
          title: a.title || '',
          read_num: a.read_num || 0,
          like_num: a.like_num || 0,
          share_num: a.share_num || 0,
          comment_num: a.comment_num || 0,
          send_time: sendTime,
        });
      }
    }
  }

  // ==================== 草稿列表 ====================

  /**
   * 列出草稿箱中的所有草稿
   * @returns {{ list: { app_id: string, title: string, update_time: number }[], total: number }}
   */
  async listDrafts() {
    if (!this.token) await this.fetchToken();

    const allItems = [];
    let begin = 0;
    const count = 20;

    while (true) {
      const { data } = await this.client.get(
        `https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_ex&begin=${begin}&count=${count}&type=77&token=${this.token}&lang=zh_CN&f=json`,
        { maxRedirects: 5, validateStatus: s => s < 500 }
      );

      if (data.base_resp?.ret !== 0) {
        throw new Error(`获取草稿列表失败: ${data.base_resp?.err_msg || 'unknown'}`);
      }

      const items = data.app_msg_list || [];
      for (const item of items) {
        allItems.push({
          app_id: String(item.appmsgid),
          title: item.title || '',
          update_time: item.update_time || 0,
        });
      }

      if (items.length < count) break;
      begin += count;
    }

    return { list: allItems, total: allItems.length };
  }

  /**
   * 删除草稿
   * @param {string} appmsgId 草稿 ID
   */
  async deleteDraft(appmsgId) {
    if (!this.token) await this.fetchToken();

    const postData = new URLSearchParams({
      token: this.token,
      lang: 'zh_CN',
      f: 'json',
      ajax: '1',
      AppMsgId: String(appmsgId),
    });

    const { data } = await this.client.post(
      `https://mp.weixin.qq.com/cgi-bin/operate_appmsg?t=ajax-response&sub=del&token=${this.token}&lang=zh_CN`,
      postData.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        maxRedirects: 5,
        validateStatus: s => s < 500,
      }
    );

    if (data.base_resp?.ret === 0) {
      return { success: true };
    }
    return { success: false, message: data.base_resp?.err_msg || '删除失败' };
  }

  async saveDraft(title, content, coverUrl, options = {}) {
    if (!this.token) await this.fetchToken();
    await this.fetchTicket();

    const author = options.author || '';
    const writerId = options.writerId || '';
    const claimSourceType = options.claimSourceType || '4';  // 个人观点，仅供参考
    const claimSource = options.claimSource || '个人观点，仅供参考';
    const albumInfo = options.albumInfo || '{"appmsg_album_infos":[]}';

    // 处理封面图
    let thumbUrl = '';
    let thumbFileid = '';
    if (coverUrl && typeof coverUrl === 'string') {
      if (coverUrl.startsWith('http')) {
        thumbUrl = coverUrl;
      } else if (fs.existsSync(coverUrl)) {
        const uploaded = await this.uploadImage(coverUrl);
        thumbUrl = uploaded?.url || '';
        thumbFileid = uploaded?.fileid || '';
      }
    } else if (coverUrl && coverUrl.url) {
      thumbUrl = coverUrl.url;
      thumbFileid = coverUrl.fileid || '';
    }

    const fingerprint = this.generateFingerprint();

    const form = new FormData();
    // 基础参数
    form.append('token', this.token);
    form.append('lang', 'zh_CN');
    form.append('f', 'json');
    form.append('ajax', '1');
    form.append('fingerprint', fingerprint);
    form.append('random', String(Math.random()));
    form.append('AppMsgId', '');
    form.append('count', '1');
    form.append('data_seq', 'null');
    form.append('operate_from', 'Chrome');
    form.append('isnew', '0');
    form.append('articlenum', '1');
    form.append('save_type', '1');
    form.append('isneedsave', '0');
    form.append('is_auto_type_setting', '3');
    form.append('remind_flag', 'null');
    form.append('autosave_log', 'true');
    form.append('pre_timesend_set', '0');

    // 文章内容参数（注意字段名是 title0 不是 title_0）
    form.append('title0', title);
    form.append('content0', content);
    form.append('author0', author);
    form.append('writerid0', writerId);
    form.append('fileid0', thumbFileid);
    form.append('digest0', '');
    form.append('auto_gen_digest0', '1');
    form.append('sourceurl0', '');
    form.append('cdn_url0', thumbUrl);
    form.append('cdn_235_1_url0', '');
    form.append('cdn_16_9_url0', '');
    form.append('cdn_3_4_url0', '');
    form.append('cdn_1_1_url0', '');
    form.append('cdn_finder_url0', '');
    form.append('cdn_video_url0', '');
    form.append('cdn_url_back0', '');
    form.append('crop_list0', '');
    form.append('show_cover_pic0', thumbUrl ? '1' : '0');
    form.append('app_cover_auto0', '0');
    form.append('multi_picture_cover0', '0');

    // 评论设置
    form.append('need_open_comment0', '1');
    form.append('only_fans_can_comment0', '0');
    form.append('only_fans_days_can_comment0', '0');
    form.append('reply_flag0', '2');
    form.append('not_pay_can_comment0', '0');
    form.append('auto_elect_comment0', '1');
    form.append('auto_elect_reply0', '1');
    form.append('option_version0', '5');

    // 版权设置
    form.append('copyright_type0', '1');
    form.append('is_cartoon_copyright0', '0');
    form.append('copyright_img_list0', '{"max_width":586,"img_list":[]}');
    form.append('allow_fast_reprint0', '0');
    form.append('allow_reprint0', '0');
    form.append('allow_reprint_modify0', '0');
    form.append('original_article_type0', '');
    form.append('ori_white_list0', '{"white_list":[]}');

    // 付费/打赏
    form.append('can_reward0', '0');
    form.append('pay_gifts_count0', '0');
    form.append('reward_reply_id0', '');
    form.append('fee0', '0');
    form.append('is_pay_subscribe0', '0');
    form.append('pay_fee0', '');
    form.append('pay_preview_percent0', '');
    form.append('pay_desc0', '');
    form.append('pay_album_info0', '');
    form.append('free_content0', '');

    // 视频/音频相关
    form.append('is_finder_video0', '0');
    form.append('finder_draft_id0', '0');
    form.append('related_video0', '');
    form.append('is_video_recommend0', '-1');
    form.append('music_id0', '');
    form.append('video_id0', '');
    form.append('vid_type0', '');
    form.append('video_ori_status0', '');
    form.append('ad_video_transition0', '');

    // 广告
    form.append('insert_ad_mode0', '2');
    form.append('can_insert_ad0', '0');
    form.append('open_keyword_ad0', '1');
    form.append('open_comment_ad0', '1');
    form.append('incontent_ad_count0', '0');
    form.append('ad_id0', '');

    // 其他设置
    form.append('applyori0', '0');
    form.append('open_fansmsg0', '0');
    form.append('share_page_type0', '0');
    form.append('share_imageinfo0', '{"list":[]}');
    form.append('share_video_id0', '');
    form.append('share_voice_id0', '');
    form.append('share_finder_audio_username0', '');
    form.append('share_finder_audio_exportid0', '');
    form.append('is_share_copyright0', '0');
    form.append('share_copyright_url0', '');
    form.append('source_article_type0', '');
    form.append('reprint_recommend_title0', '');
    form.append('reprint_recommend_content0', '');
    form.append('hit_nickname0', '');
    form.append('last_choose_cover_from0', '0');
    form.append('is_user_title0', '');
    form.append('platform0', '');
    form.append('voteid0', '');
    form.append('voteismlt0', '');
    form.append('supervoteid0', '');
    form.append('super_vote_id0', '');
    form.append('guide_words0', '');
    form.append('dot0', '{}');
    form.append('mmlistenitem_json_buf0', '');
    form.append('appmsg_album_info0', albumInfo);
    form.append('audio_info0', '{"audio_infos":[]}');
    form.append('mp_video_info0', '{"list":{}}');
    form.append('categories_list0', '[]');
    form.append('compose_info0', '{"list":[]}');
    form.append('sections0', '[]');
    form.append('danmu_pub_type0', '0');
    form.append('appmsg_danmu_pub_type0', '');
    form.append('is_set_sync_to_finder0', '0');
    form.append('sync_to_finder_cover0', '');
    form.append('sync_to_finder_cover_source0', '');
    form.append('import_to_finder0', '0');
    form.append('import_from_finder_export_id0', '');
    form.append('style_type0', '3');
    form.append('sticker_info0', '{"is_stickers":0,"common_stickers_num":0,"union_stickers_num":0,"sticker_id_list":[],"has_invalid_sticker":0}');
    form.append('new_pic_process0', '0');
    form.append('disable_recommend0', '0');
    form.append('claim_source_type0', claimSourceType);
    form.append('is_user_no_claim_source0', '0');
    form.append('msg_index_id0', '');
    form.append('convert_to_image_share_page0', '');
    form.append('convert_from_image_share_page0', '');
    form.append('title_gen_type0', '0');

    // req JSON
    form.append('req', JSON.stringify({
      idx_infos: [{
        save_old: 0,
        cps_info: { cps_import: 0 },
        red_packet_cover_list: {},
        claim_source: { claim_source_type: Number(claimSourceType), claim_source: claimSource },
        line_info: { is_appmsg_flag: 0, scene: 2 },
        window_product: {},
        link_info: {},
        appmsg_link: {},
        weapp_link: {},
        yqj_info: {},
        ai_pic_info: { ai_pic_id: [] },
        single_video_snap_card: {},
        product_activity: {},
        footer_gift_activity: {},
        footer_common_shops: [],
        location: {},
      }],
      appmsg_id: 0,
      is_use_flag: 0,
      template_version: '82086039',
    }));

    try {
      const { data } = await this.client.post(
        `https://mp.weixin.qq.com/cgi-bin/operate_appmsg?t=ajax-response&sub=create&type=77&token=${this.token}&lang=zh_CN`,
        form,
        {
          headers: form.getHeaders(),
          timeout: 60000,
          maxRedirects: 5,
          validateStatus: s => s < 500,
        }
      );

      if (data.base_resp?.ret === 0 && data.appMsgId) {
        const appmsgId = String(data.appMsgId);
        console.log(`  草稿保存成功: ${title} (appMsgId: ${appmsgId})`);
        return {
          success: true,
          article_id: appmsgId,
          draft_url: `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&type=77&appmsgid=${appmsgId}&token=${this.token}`,
          message: '已保存到草稿箱',
        };
      }

      const msg = data.base_resp?.err_msg || '保存失败';
      const ret = data.base_resp?.ret || '';
      console.error(`  草稿保存失败: ${msg} (ret: ${ret})`);
      return { success: false, article_id: '', draft_url: '', message: `${msg} (ret: ${ret})` };
    } catch (e) {
      console.error(`  请求异常: ${e.message}`);
      return { success: false, article_id: '', draft_url: '', message: e.message };
    }
  }

  // ==================== 发布 ====================

  /**
   * 保存多篇文章到同一个草稿（多图文）
   * @param {Array<{title, content, coverUrl, options?}>} articles 文章列表
   * @returns {{ success, article_id, draft_url, message }}
   */
  async saveMultiDraft(articles) {
    if (!articles.length) return { success: false, article_id: '', draft_url: '', message: '没有文章' };
    if (articles.length === 1) {
      const a = articles[0];
      return this.saveDraft(a.title, a.content, a.coverUrl, a.options || {});
    }

    if (!this.token) await this.fetchToken();
    await this.fetchTicket();

    const fingerprint = this.generateFingerprint();
    const count = articles.length;

    const form = new FormData();
    // 基础参数
    form.append('token', this.token);
    form.append('lang', 'zh_CN');
    form.append('f', 'json');
    form.append('ajax', '1');
    form.append('fingerprint', fingerprint);
    form.append('random', String(Math.random()));
    form.append('AppMsgId', '');
    form.append('count', String(count));
    form.append('data_seq', 'null');
    form.append('operate_from', 'Chrome');
    form.append('isnew', '0');
    form.append('articlenum', String(count));
    form.append('save_type', '1');
    form.append('isneedsave', '0');
    form.append('is_auto_type_setting', '3');
    form.append('remind_flag', 'null');
    form.append('autosave_log', 'true');
    form.append('pre_timesend_set', '0');

    const idxInfos = [];

    for (let idx = 0; idx < count; idx++) {
      const a = articles[idx];
      const opts = a.options || {};
      const author = opts.author || '';
      const writerId = opts.writerId || '';
      const claimSourceType = opts.claimSourceType || '4';
      const claimSource = opts.claimSource || '个人观点，仅供参考';
      const albumInfo = opts.albumInfo || '{"appmsg_album_infos":[]}';

      // 处理封面图
      let thumbUrl = '';
      let thumbFileid = '';
      if (a.coverUrl && typeof a.coverUrl === 'string') {
        if (a.coverUrl.startsWith('http')) {
          thumbUrl = a.coverUrl;
        } else if (fs.existsSync(a.coverUrl)) {
          const uploaded = await this.uploadImage(a.coverUrl);
          thumbUrl = uploaded?.url || '';
          thumbFileid = uploaded?.fileid || '';
        }
      } else if (a.coverUrl && a.coverUrl.url) {
        thumbUrl = a.coverUrl.url;
        thumbFileid = a.coverUrl.fileid || '';
      }

      const i = idx; // field suffix
      form.append(`title${i}`, a.title);
      form.append(`content${i}`, a.content);
      form.append(`author${i}`, author);
      form.append(`writerid${i}`, writerId);
      form.append(`fileid${i}`, thumbFileid);
      form.append(`digest${i}`, '');
      form.append(`auto_gen_digest${i}`, '1');
      form.append(`sourceurl${i}`, '');
      form.append(`cdn_url${i}`, thumbUrl);
      form.append(`cdn_235_1_url${i}`, '');
      form.append(`cdn_16_9_url${i}`, '');
      form.append(`cdn_3_4_url${i}`, '');
      form.append(`cdn_1_1_url${i}`, '');
      form.append(`cdn_finder_url${i}`, '');
      form.append(`cdn_video_url${i}`, '');
      form.append(`cdn_url_back${i}`, '');
      form.append(`crop_list${i}`, '');
      form.append(`show_cover_pic${i}`, thumbUrl ? '1' : '0');
      form.append(`app_cover_auto${i}`, '0');
      form.append(`multi_picture_cover${i}`, '0');

      // 评论设置
      form.append(`need_open_comment${i}`, '1');
      form.append(`only_fans_can_comment${i}`, '0');
      form.append(`only_fans_days_can_comment${i}`, '0');
      form.append(`reply_flag${i}`, '2');
      form.append(`not_pay_can_comment${i}`, '0');
      form.append(`auto_elect_comment${i}`, '1');
      form.append(`auto_elect_reply${i}`, '1');
      form.append(`option_version${i}`, '5');

      // 版权设置
      form.append(`copyright_type${i}`, '1');
      form.append(`is_cartoon_copyright${i}`, '0');
      form.append(`copyright_img_list${i}`, '{"max_width":586,"img_list":[]}');
      form.append(`allow_fast_reprint${i}`, '0');
      form.append(`allow_reprint${i}`, '0');
      form.append(`allow_reprint_modify${i}`, '0');
      form.append(`original_article_type${i}`, '');
      form.append(`ori_white_list${i}`, '{"white_list":[]}');

      // 付费/打赏
      form.append(`can_reward${i}`, '0');
      form.append(`pay_gifts_count${i}`, '0');
      form.append(`reward_reply_id${i}`, '');
      form.append(`fee${i}`, '0');
      form.append(`is_pay_subscribe${i}`, '0');
      form.append(`pay_fee${i}`, '');
      form.append(`pay_preview_percent${i}`, '');
      form.append(`pay_desc${i}`, '');
      form.append(`pay_album_info${i}`, '');
      form.append(`free_content${i}`, '');

      // 视频/音频相关
      form.append(`is_finder_video${i}`, '0');
      form.append(`finder_draft_id${i}`, '0');
      form.append(`related_video${i}`, '');
      form.append(`is_video_recommend${i}`, '-1');
      form.append(`music_id${i}`, '');
      form.append(`video_id${i}`, '');
      form.append(`vid_type${i}`, '');
      form.append(`video_ori_status${i}`, '');
      form.append(`ad_video_transition${i}`, '');

      // 广告
      form.append(`insert_ad_mode${i}`, '2');
      form.append(`can_insert_ad${i}`, '0');
      form.append(`open_keyword_ad${i}`, '1');
      form.append(`open_comment_ad${i}`, '1');
      form.append(`incontent_ad_count${i}`, '0');
      form.append(`ad_id${i}`, '');

      // 其他设置
      form.append(`applyori${i}`, '0');
      form.append(`open_fansmsg${i}`, '0');
      form.append(`share_page_type${i}`, '0');
      form.append(`share_imageinfo${i}`, '{"list":[]}');
      form.append(`share_video_id${i}`, '');
      form.append(`share_voice_id${i}`, '');
      form.append(`share_finder_audio_username${i}`, '');
      form.append(`share_finder_audio_exportid${i}`, '');
      form.append(`is_share_copyright${i}`, '0');
      form.append(`share_copyright_url${i}`, '');
      form.append(`source_article_type${i}`, '');
      form.append(`reprint_recommend_title${i}`, '');
      form.append(`reprint_recommend_content${i}`, '');
      form.append(`hit_nickname${i}`, '');
      form.append(`last_choose_cover_from${i}`, '0');
      form.append(`is_user_title${i}`, '');
      form.append(`platform${i}`, '');
      form.append(`voteid${i}`, '');
      form.append(`voteismlt${i}`, '');
      form.append(`supervoteid${i}`, '');
      form.append(`super_vote_id${i}`, '');
      form.append(`guide_words${i}`, '');
      form.append(`dot${i}`, '{}');
      form.append(`mmlistenitem_json_buf${i}`, '');
      form.append(`appmsg_album_info${i}`, albumInfo);
      form.append(`audio_info${i}`, '{"audio_infos":[]}');
      form.append(`mp_video_info${i}`, '{"list":{}}');
      form.append(`categories_list${i}`, '[]');
      form.append(`compose_info${i}`, '{"list":[]}');
      form.append(`sections${i}`, '[]');
      form.append(`danmu_pub_type${i}`, '0');
      form.append(`appmsg_danmu_pub_type${i}`, '');
      form.append(`is_set_sync_to_finder${i}`, '0');
      form.append(`sync_to_finder_cover${i}`, '');
      form.append(`sync_to_finder_cover_source${i}`, '');
      form.append(`import_to_finder${i}`, '0');
      form.append(`import_from_finder_export_id${i}`, '');
      form.append(`style_type${i}`, '3');
      form.append(`sticker_info${i}`, '{"is_stickers":0,"common_stickers_num":0,"union_stickers_num":0,"sticker_id_list":[],"has_invalid_sticker":0}');
      form.append(`new_pic_process${i}`, '0');
      form.append(`disable_recommend${i}`, '0');
      form.append(`claim_source_type${i}`, claimSourceType);
      form.append(`is_user_no_claim_source${i}`, '0');
      form.append(`msg_index_id${i}`, '');
      form.append(`convert_to_image_share_page${i}`, '');
      form.append(`convert_from_image_share_page${i}`, '');
      form.append(`title_gen_type${i}`, '0');

      idxInfos.push({
        save_old: 0,
        cps_info: { cps_import: 0 },
        red_packet_cover_list: {},
        claim_source: { claim_source_type: Number(claimSourceType), claim_source: claimSource },
        line_info: { is_appmsg_flag: 0, scene: 2 },
        window_product: {},
        link_info: {},
        appmsg_link: {},
        weapp_link: {},
        yqj_info: {},
        ai_pic_info: { ai_pic_id: [] },
        single_video_snap_card: {},
        product_activity: {},
        footer_gift_activity: {},
        footer_common_shops: [],
        location: {},
      });
    }

    form.append('req', JSON.stringify({
      idx_infos: idxInfos,
      appmsg_id: 0,
      is_use_flag: 0,
      template_version: '82086039',
    }));

    try {
      const { data } = await this.client.post(
        `https://mp.weixin.qq.com/cgi-bin/operate_appmsg?t=ajax-response&sub=create&type=77&token=${this.token}&lang=zh_CN`,
        form,
        {
          headers: form.getHeaders(),
          timeout: 120000,
          maxRedirects: 5,
          validateStatus: s => s < 500,
        }
      );

      if (data.base_resp?.ret === 0 && data.appMsgId) {
        const appmsgId = String(data.appMsgId);
        console.log(`  多图文草稿保存成功 (appMsgId: ${appmsgId}, ${count} 篇)`);
        return {
          success: true,
          article_id: appmsgId,
          draft_url: `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&type=77&appmsgid=${appmsgId}&token=${this.token}`,
          message: `已保存 ${count} 篇到同一草稿`,
        };
      }

      const msg = data.base_resp?.err_msg || '保存失败';
      const ret = data.base_resp?.ret || '';
      console.error(`  多图文草稿保存失败: ${msg} (ret: ${ret})`);
      return { success: false, article_id: '', draft_url: '', message: `${msg} (ret: ${ret})` };
    } catch (e) {
      console.error(`  请求异常: ${e.message}`);
      return { success: false, article_id: '', draft_url: '', message: e.message };
    }
  }

  // ==================== 发布（原有） ====================

  async publishArticle(appmsgId) {
    if (!this.token) await this.fetchToken();

    try {
      const postData = new URLSearchParams({
        token: this.token,
        lang: 'zh_CN',
        f: 'json',
        ajax: '1',
        random: String(Math.random()),
        appmsgid: String(appmsgId),
      });

      const { data } = await this.client.post(
        `https://mp.weixin.qq.com/cgi-bin/freepublish?action=publish&token=${this.token}&lang=zh_CN`,
        postData.toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          maxRedirects: 5,
          validateStatus: s => s < 500,
        }
      );

      if (data.base_resp?.ret === 0) {
        console.log(`  发布成功: ${appmsgId}`);
        return { success: true, article_id: String(appmsgId), message: '已发布' };
      }

      const msg = data.base_resp?.err_msg || '发布失败';
      console.error(`  发布失败: ${msg}`);
      return { success: false, article_id: String(appmsgId), message: msg };
    } catch (e) {
      console.error(`  发布请求异常: ${e.message}`);
      return { success: false, article_id: String(appmsgId), message: e.message };
    }
  }

  // ==================== HTML 处理 ====================

  async processContentImages(htmlContent) {
    const skipPatterns = ['mmbiz.qpic.cn', 'mmbiz.qlogo.cn'];
    const imgRegex = /<img[^>]+src="([^"]+)"/g;
    let result = htmlContent;
    let match;
    const replacements = [];

    while ((match = imgRegex.exec(htmlContent)) !== null) {
      const src = match[1];
      if (!src || skipPatterns.some(p => src.includes(p))) continue;

      const decodedSrc = decodeURIComponent(src);

      let uploaded = null;
      if (fs.existsSync(decodedSrc)) {
        uploaded = await this.uploadImage(decodedSrc);
      } else if (fs.existsSync(src)) {
        uploaded = await this.uploadImage(src);
      } else if (src.startsWith('http')) {
        uploaded = await this.uploadImageFromUrl(src);
      }
      if (uploaded) {
        replacements.push({ old: src, new: uploaded.url });
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
    c = c.replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, '$1');
    return c;
  }
}

module.exports = { WechatAPI };
