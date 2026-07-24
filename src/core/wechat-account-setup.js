const { WechatAPI } = require('./wechat-api');
const { getAccountCookie } = require('./account-config');

function copyConfigValue(value) {
  if (Array.isArray(value)) return value.map(copyConfigValue);
  if (value && typeof value === 'object') return { ...value };
  return value;
}

function getWorks(account) {
  return account && account.works && typeof account.works === 'object'
    ? account.works
    : {};
}

function selectTemplateAccount(accounts, targetAccount) {
  return [...(accounts || [])]
    .filter(account => account && account !== targetAccount && Object.keys(getWorks(account)).length > 0)
    .sort((a, b) => Object.keys(getWorks(b)).length - Object.keys(getWorks(a)).length)[0] || null;
}

function cloneWorkConfig(workName, sourceConfig) {
  const cloned = {};
  for (const [key, value] of Object.entries(sourceConfig || {})) {
    if (key === 'album_id') continue;
    cloned[key] = copyConfigValue(value);
  }
  if (!cloned.album_title) cloned.album_title = workName;
  return cloned;
}

function mergeMissingWorkConfig(workName, targetConfig, sourceConfig) {
  let changed = false;
  for (const [key, value] of Object.entries(sourceConfig || {})) {
    if (key === 'album_id') continue;
    if (targetConfig[key] === undefined || targetConfig[key] === '') {
      targetConfig[key] = key === 'album_title'
        ? (value || workName)
        : copyConfigValue(value);
      changed = true;
    }
  }
  if (!targetConfig.album_title) {
    targetConfig.album_title = workName;
    changed = true;
  }
  return changed;
}

function ensureWechatAccountDefaults(accounts, account) {
  let changed = false;
  const templateAccount = selectTemplateAccount(accounts, account);

  if (account && !account.author && account.name && account.name !== 'default') {
    account.author = account.name;
    changed = true;
  }

  if (!account.works || typeof account.works !== 'object') {
    account.works = {};
    changed = true;
  }

  if (templateAccount) {
    if (account.combine === undefined && templateAccount.combine !== undefined) {
      account.combine = templateAccount.combine;
      changed = true;
    }

    for (const [workName, sourceConfig] of Object.entries(getWorks(templateAccount))) {
      if (!account.works[workName]) {
        account.works[workName] = cloneWorkConfig(workName, sourceConfig);
        changed = true;
      } else if (mergeMissingWorkConfig(workName, account.works[workName], sourceConfig)) {
        changed = true;
      }
    }
  }

  return {
    changed,
    templateName: templateAccount ? templateAccount.name : '',
  };
}

function resolveWechatAuthor(accountConfig, wechatConfig = {}) {
  if (accountConfig && accountConfig.author) return accountConfig.author;
  if (accountConfig && accountConfig.name && accountConfig.name !== 'default') return accountConfig.name;
  return wechatConfig.author || '';
}

function resolveWechatWriterId(accountConfig, wechatConfig = {}) {
  if (accountConfig && accountConfig.writer_id) return accountConfig.writer_id;
  if (!accountConfig || accountConfig.name === 'default') return wechatConfig.writer_id || '';
  return '';
}

function applyRuntimeCookie(account, api) {
  const cookie = api && typeof api.getCookieString === 'function'
    ? api.getCookieString()
    : '';
  if (!cookie || account.cookie === cookie) return false;
  account.cookie = cookie;
  return true;
}

async function fetchTokenQuietly(api) {
  try {
    await api.fetchToken();
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

async function resolveWechatApiForAccount(account, accounts, options = {}) {
  const prefix = options.prefix || '';
  const cookie = getAccountCookie(account);

  if (cookie) {
    const directApi = new WechatAPI(cookie);
    const directAuth = await fetchTokenQuietly(directApi);
    if (directAuth.success) {
      const cookieChanged = applyRuntimeCookie(account, directApi);
      console.log(`${prefix}公众号已登录`);
      return {
        success: true,
        api: directApi,
        changed: cookieChanged,
        via: 'direct',
      };
    } else {
      console.log(`${prefix}直接登录失败: ${directAuth.message}`);
    }
  }

  return {
    success: false,
    message: `公众号未登录，请先执行 npm run wx:cookie -- --account ${account.name || 'default'} 刷新该账号 Cookie`,
  };
}

async function ensureWechatAlbumsForAccount(api, account, options = {}) {
  const works = getWorks(account);
  const workNames = options.workNames && options.workNames.length
    ? options.workNames
    : Object.keys(works);
  let changed = false;

  for (const workName of workNames) {
    const workConfig = works[workName];
    if (!workConfig) continue;

    const albumTitle = String(workConfig.album_title || workName).trim();
    if (!workConfig.album_title) {
      workConfig.album_title = albumTitle;
      changed = true;
    }
    if (workConfig.album_id) continue;

    const ensured = await api.ensureArticleAlbum(albumTitle);
    if (!ensured.success) {
      throw new Error(`合集「${albumTitle}」确保失败: ${ensured.message || 'unknown'}`);
    }

    workConfig.album_id = ensured.album_id;
    workConfig.album_title = ensured.album_title || albumTitle;
    changed = true;
    const action = ensured.created ? '创建' : '匹配';
    console.log(`  ${action}合集: ${workConfig.album_title} (${workConfig.album_id})`);
  }

  return { changed };
}

module.exports = {
  ensureWechatAccountDefaults,
  ensureWechatAlbumsForAccount,
  resolveWechatApiForAccount,
  resolveWechatAuthor,
  resolveWechatWriterId,
};
