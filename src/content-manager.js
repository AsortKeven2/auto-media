/**
 * 内容管理器 - 文章状态流转
 */

const fs = require('fs');
const path = require('path');
const fm = require('front-matter');
const yaml = require('js-yaml');

function getArticlesDir() {
  const dir = path.resolve(__dirname, '..', 'archive', 'baijiahao');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function parseArticle(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const { attributes, body } = fm(raw);
  return { meta: attributes, body, filePath };
}

function listArticles(statusFilter) {
  const dir = getArticlesDir();
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
  const articles = files.map(f => {
    try {
      return parseArticle(path.join(dir, f));
    } catch { return null; }
  }).filter(Boolean);

  if (statusFilter) {
    return articles.filter(a => a.meta.status === statusFilter);
  }
  return articles;
}

function updateMeta(filePath, updates) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const { attributes, body } = fm(raw);
  Object.assign(attributes, updates);
  const newYaml = yaml.dump(attributes, { lineWidth: -1 });
  fs.writeFileSync(filePath, `---\n${newYaml}---\n${body}`, 'utf-8');
}

function createArticle(title, content, meta = {}) {
  const dir = getArticlesDir();
  const slug = title.replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '_').slice(0, 40);
  const filename = `${slug}.md`;
  const filePath = path.join(dir, filename);

  const defaults = {
    title,
    status: 'draft',
    type: '',
    work: '',
    characters: [],
    cover_image: '',
    tags: [],
    created_at: new Date().toISOString(),
    published_at: '',
    article_id: '',
  };
  const finalMeta = { ...defaults, ...meta, title };
  const yamlStr = yaml.dump(finalMeta, { lineWidth: -1 });
  fs.writeFileSync(filePath, `---\n${yamlStr}---\n\n${content}`, 'utf-8');
  console.log(`文章已创建: ${filePath}`);
  return filePath;
}

function importArticle(srcPath) {
  const dir = getArticlesDir();
  const raw = fs.readFileSync(srcPath, 'utf-8');
  let meta, body;

  try {
    const parsed = fm(raw);
    meta = parsed.attributes;
    body = parsed.body;
  } catch {
    // 没有 front matter，当作纯内容处理
    body = raw;
    meta = {};
  }

  if (!meta.title) {
    // 从内容第一行提取标题
    const firstLine = body.trim().split('\n')[0].replace(/^#+\s*/, '');
    meta.title = firstLine || path.basename(srcPath, '.md');
  }

  return createArticle(meta.title, body, meta);
}

module.exports = { listArticles, parseArticle, updateMeta, createArticle, importArticle, getArticlesDir };
