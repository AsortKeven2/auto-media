# auto-media — 自媒体内容自动化工具

基于 AI（豆包大模型）的自媒体内容自动化工具，支持选题生成、文章写作、智能配图、多平台批量发布。

> **公众号说明**: 微信公众号支持两种模式 — 从 Notion 同步文章到草稿箱，或与百家号/头条号一样由 AI 直接生成文章并推送到草稿箱。

## 功能

- **AI 选题生成** — 按作品自动生成多样化选题
- **AI 文章写作** — 根据选题自动撰写文章，支持风格参考
- **智能配图** — AI 自主决定插图位置和角色，自动匹配本地图片库
- **多平台发布** — 支持百家号、头条号、微信公众号
- **批量生产** — 按配置文件批量生成 + 发布，一键完成
- **热文分析** — 自动拉取已发布文章数据，LLM 分析高阅读量规律，反哺选题和写作
- **微信公众号** — 支持 AI 直接生成或从 Notion 同步文章，推送到草稿箱，支持多轮批量生成

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置

复制配置模板并填写你的信息：

```bash
cp .env.local.example .env.local
```

编辑 `.env.local`，填写以下内容：

```ini
# 百家号 Cookie（从浏览器开发者工具复制）
BJH_COOKIE=你的百家号Cookie

# 头条号 Cookie
TOUTIAO_COOKIE=你的头条号Cookie

# 微信公众号 Cookie（mp.weixin.qq.com）
WECHAT_COOKIE=你的公众号Cookie

# 豆包 API Key（https://console.volcengine.com/ark）
DOUBAO_API_KEY=你的API Key

# 豆包模型（可选，默认 doubao-seed-1-8-251228）
DOUBAO_MODEL=doubao-seed-1-8-251228

# 图片素材目录（可选，默认 ./images）
IMAGE_DIR=./images

# 尾图路径（可选，默认 ./images/cover.jpg）
TAIL_IMAGE=./images/cover.jpg

# Chrome 浏览器路径（图片下载脚本需要，不配置则使用系统默认路径）
# macOS:   /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
# Windows: C:\Program Files\Google\Chrome\Application\chrome.exe
# Linux:   /usr/bin/google-chrome
CHROME_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

### 3. 准备图片素材
+ Q: 为什么不直接用AI生成图片？ 因为AI生图质量比较差，所以我们使用预先抓取图库，AI配图的模式

在 `images/` 目录下按作品分目录存放角色图片：

```
images/
├── 西游记/
│   ├── 孙悟空.jpg
│   ├── 猪八戒.jpeg
│   └── ...
├── 三国演义/
│   ├── 曹操.jpg
│   └── ...
└── cover.jpg          # 尾图
```

### 4. 配置发布

创建 `publish_config.json`（所有配置集中管理）：

```json
{
  "works": {
    "西游记": 2,
    "三国演义": 1,
    "水浒传": 1
  },
  "platforms": ["baijiahao", "toutiao", "wechat"],
  "publish": false,
  "interval": 30,
  "baijiahao": {
    "works": {
      "西游记": {
        "count": 1,
        "notionUrl": "https://www.notion.so/xxx",
        "image_dirs": ["西游记"]
      }
    }
  },
  "wechat": {
    "author": "你的公众号作者名",
    "writer_id": "你的作者ID",
    "combine": true,
    "hot_articles_reference": [
      "黄药师为何独独不认杨过？",
      "梁山真正看透宋江的人是谁？",
      "孙悟空大闹天宫时，太上老君为何一直旁观？"
    ],
    "works": {
      "西游记": {
        "count": 1,
        "notionUrl": "https://www.notion.so/xxx",
        "album_id": "合集ID",
        "album_title": "合集标题",
        "image_dirs": ["西游记"]
      }
    }
  }
}
```

字段说明：
- `works`: 各作品批量生成文章数量（作品名: 篇数）
- `platforms`: 发布平台列表（baijiahao / toutiao / wechat）
- `publish`: `true`=直接发布，`false`=仅保存草稿
- `interval`: 每篇发布间隔秒数
- `baijiahao`: 百家号 Notion 直发配置
  - `works`: 各作品的 Notion 来源配置，每个作品可配置 `count`（每次运行该作品最多读取并立即发布几篇）、`notionUrl`（Notion 目录页）和 `image_dirs`（配图目录）
- `wechat`: 微信公众号配置
  - `author`: 文章原创作者名
  - `writer_id`: 作者ID
  - `combine`: `true`=多篇文章合并为一个多图文草稿，`false`=逐篇保存独立草稿（微信最多合并 8 篇）
  - `hot_articles_reference`: 公众号热文标题列表（可选），手动指定的”热文参考标题”。配置后直接作为参考注入选题和写作；未配置时自动读取公众号热文标题
  - `works`: 各作品配置，每个作品可配置 `count`（AI 生成篇数）、`notionUrl`（Notion 同步）、`album_id`/`album_title`（合集）、`image_dirs`（配图目录）

> **兜底机制**: 如果 `publish_config.json` 不存在，会尝试读取旧的 `batch.json` + `works.json`，都不存在则自动生成默认配置（每作品1篇，仅草稿），新项目可直接运行。

## 使用

### 通用命令（百家号 + 头条号 + 公众号）

```bash
# 检查所有平台登录状态
node src/main.js check

# 设置 Cookie
node src/main.js login "你的Cookie"
node src/main.js login "你的Cookie" -p toutiao
node src/main.js login "你的Cookie" -p wechat

# 生成选题
node src/main.js topics -c 10
node src/main.js topics -w 西游记

# 列出所有作品
node src/main.js works

# 生成文章大纲
node src/main.js outline "孙悟空大闹天宫，真的是故意留手吗？"

# 推送单篇文章
node src/main.js push articles/xxx.md
node src/main.js push articles/xxx.md -p wechat    # 推送到公众号

# 热文排行（百家号）
node src/main.js top                   # 查看阅读量/点击率排行
node src/main.js top -n 20             # 显示前20

# 批量生成 + 发布
node src/main.js batch                # 按 publish_config.json 配置执行
node src/main.js batch --no-push      # 仅生成不推送
node src/main.js batch --publish      # 强制发布（覆盖配置）
node src/main.js batch --no-publish   # 强制仅草稿（覆盖配置）
node src/main.js batch -p baijiahao   # 仅发百家号（覆盖配置）
node src/main.js batch -p wechat      # 仅发公众号（覆盖配置）
node src/main.js batch --interval 60  # 自定义间隔秒数（覆盖配置）

# 推送所有 ready 状态文章
node src/main.js push-ready --publish
node src/main.js push-ready -p wechat     # 仅推送到公众号
```

### 微信公众号 AI 生成

```bash
# AI 直接生成文章 → 推送到草稿箱
node src/wechat-main.js generate               # 按配置生成所有作品
node src/wechat-main.js generate 西游记         # 仅生成指定作品
node src/wechat-main.js generate --no-push     # 仅生成不推送
node src/wechat-main.js generate --rounds 3    # 执行3轮（批量生成多天文章）

# 热文排行（公众号）
node src/wechat-main.js top                    # 查看阅读量排行
node src/wechat-main.js top -n 20              # 显示前20
```

### 微信公众号 Notion 同步

```bash
# 从 Notion 同步到公众号草稿箱
node src/wechat-main.js batch             # 同步所有作品
node src/wechat-main.js batch 西游记       # 同步指定作品

# 列出草稿
node src/wechat-main.js list

# 清空草稿
node src/wechat-main.js clean
```

执行 `wx batch` 时，会先把 Notion 页面同步到本地 Markdown（同步时就完成配图），再继续推送到公众号草稿箱。

### 百家号本地 Markdown 发布

```bash
# 手动从 Notion 同步到本地 Markdown（同步时就配图）
node src/bjh-notion-main.js sync
node src/bjh-notion-main.js sync 西游记

# 从本地 Markdown 发布到百家号（按 baijiahao.works.<作品>.count 控制数量）
node src/bjh-notion-main.js publish
node src/bjh-notion-main.js publish 西游记

# 查看本地同步/发布状态
node src/bjh-notion-main.js status
node src/bjh-notion-main.js status 西游记
```

### npm scripts 快捷方式

```bash
npm run check          # 检查登录状态
npm run batch          # 批量生成并发布（三平台）
npm run batch:dry      # 批量生成但不推送
npm run batch:bjh      # 仅发百家号
npm run batch:tt       # 仅发头条
npm run bjh:sync       # 手动同步 Notion 到本地 Markdown
npm run bjh:publish    # 从本地 Markdown 发布到百家号
npm run bjh:status     # 查看百家号本地 Markdown 状态
npm run wx:batch       # 微信公众号批量同步
npm run wx:list        # 列出公众号草稿
npm run help           # 显示所有命令
```

### 热文分析

批量生成时（`batch` / `generate`）会读取热文相关参考，并将其注入到选题和写作提示词中，提升内容质量。

- **百家号**: 拉取最近15天文章，分析阅读量、推荐量、点击率
- **微信公众号**: 如果 `publish_config.json` 的 `wechat.hot_articles_reference` 配置了热文标题，就直接作为参考用于生成；未配置时，拉取最近一周文章并缓存到本地（`data/wx_articles_cache.json`），读取公众号热文标题作为参考

### 图片素材管理

文章配图需要本地图片素材，按 `images/<作品名>/<角色名>.jpg` 的结构存放。提供了两个辅助脚本：

**1. 批量下载角色图片**

通过 puppeteer 无头浏览器从百度图片搜索下载，需要本地安装 Chrome 浏览器。

```bash
# 扫描已有图片目录，自动补齐不足 3 张的角色
node scripts/download-images.js 水浒传

# 只下载指定角色
node scripts/download-images.js 水浒传 武大郎 宋江

# 每角色下载 5 张
node scripts/download-images.js 水浒传 武大郎 宋江 -n 5
```

下载的图片保存在 `downloads/<作品名>/` 目录，人工筛选后移入 `images/<作品名>/`。

> 如果提示找不到 Chrome 浏览器，需要在 `.env.local` 中配置 `CHROME_PATH`。

## 项目结构

```
├── src/
│   ├── main.js              # CLI 入口（百家号/头条号/公众号 AI 生成流程）
│   ├── wechat-main.js       # CLI 入口（公众号 Notion 同步流程）
│   ├── article-generator.js # AI 文章生成 + 智能配图
│   ├── topic-generator.js   # AI 选题生成
│   ├── outline-generator.js # AI 大纲生成
│   ├── llm.js               # 豆包大模型调用
│   ├── batch-publish.js     # 批量发布（Markdown→HTML→推送）
│   ├── content-manager.js   # 文章管理（CRUD）
│   ├── image-library.js     # 图片库管理 + 封面选择
│   ├── baijiahao-api.js     # 百家号 API
│   ├── toutiao-api.js       # 头条号 API
│   ├── wechat-api.js        # 微信公众号 API
│   ├── notion-fetcher.js    # Notion 页面抓取
│   ├── categories.js        # 文章类别定义
│   └── env.js               # 配置加载
├── scripts/
│   ├── download-images.js   # 图片下载工具
├── package.json
└── .env.local.example       # 配置模板
```

## 技术栈

- **运行环境**: Node.js
- **AI 模型**: 豆包大模型（火山引擎 ARK API）
- **平台接口**: 百家号/头条号/微信公众号内部 API
- **内容来源**: Notion 公开页面（微信公众号流程）

## License

MIT
