/**
 * 多账号配置归一化
 * 从 config.json 读取平台账号配置，统一为 accounts 数组格式
 * 兼容旧的扁平格式（无 accounts 时自动包装为单账号）
 */

const { loadConfig } = require('./config');

/**
 * 将平台配置归一化为 accounts 数组
 * - 有 accounts 字段：直接返回
 * - 无 accounts 但有 works：包装为单账号 (name="default")
 */
function normalizePlatformAccounts(platformConfig, platform) {
  if (!platformConfig || typeof platformConfig !== 'object') return [];

  if (Array.isArray(platformConfig.accounts) && platformConfig.accounts.length) {
    return platformConfig.accounts;
  }

  // 旧格式兼容：扁平结构 → 单账号
  if (!platformConfig.works || !Object.keys(platformConfig.works).length) return [];

  const account = {
    name: 'default',
    cookie: platformConfig.cookie || '',
    works: platformConfig.works,
  };

  // wechat 额外字段提升到账号级别
  if (platform === 'wechat') {
    if (platformConfig.author) account.author = platformConfig.author;
    if (platformConfig.writer_id) account.writer_id = platformConfig.writer_id;
    if (platformConfig.combine !== undefined) account.combine = platformConfig.combine;
    if (platformConfig.hot_articles_reference) account.hot_articles_reference = platformConfig.hot_articles_reference;
    if (platformConfig.image_dirs) account.image_dirs = platformConfig.image_dirs;
    if (platformConfig.cover_image) account.cover_image = platformConfig.cover_image;
    if (platformConfig.past_recommendations_count !== undefined) {
      account.past_recommendations_count = platformConfig.past_recommendations_count;
    }
  }

  return [account];
}

/**
 * 从 config.json 加载指定平台的账号列表
 */
function loadPlatformAccounts(platform) {
  const config = loadConfig();
  return normalizePlatformAccounts(config[platform] || {}, platform);
}

/**
 * 按账号名过滤，不传则返回全部
 */
function filterAccounts(accounts, accountName) {
  if (!accountName) return accounts;
  const matched = accounts.filter(a => a.name === accountName);
  if (!matched.length) {
    console.error(`未找到账号 "${accountName}"，可用账号: ${accounts.map(a => a.name).join('、')}`);
  }
  return matched;
}

/**
 * 获取账号的 cookie
 * 从 config.json 的 account.cookie 读取
 */
function getAccountCookie(account) {
  if (!account) return '';
  return account.cookie || '';
}

module.exports = {
  loadPlatformAccounts,
  filterAccounts,
  getAccountCookie,
};
