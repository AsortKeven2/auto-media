# auto-media — 自媒体内容自动化工具

基于 AI（豆包大模型）的自媒体内容自动化工具，支持选题生成、文章写作、智能配图、多平台批量发布。

> **公众号说明**: 微信公众号支持两种模式 — 从 Notion 同步文章到草稿箱，或与百家号/头条号一样由 AI 直接生成文章并推送到草稿箱。

## 功能

- **AI 选题生成** — 按作品自动生成多样化选题
- **AI 文章写作** — 根据选题自动撰写文章，支持风格参考
- **智能配图** — AI 自主决定插图位置和角色，自动匹配本地图片库
- **多平台发布** — 支持百家号、头条号、微信公众号
- **批量生产** — 按配置文件批量生成 + 发布，一键完成
- **分类随机选题** — 百家号批量生成时直接从常规文章分类中随机分配选题方向
- **微信公众号** — 支持 AI 直接生成或从 Notion 同步文章，推送到草稿箱，支持多轮批量生成

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置

复制配置模板并填写你的信息：

```bash
cp config.json.example config.json
```

编辑 `config.json`，填写豆包 API Key、各平台 Cookie、图片目录和发布作品配置。`config.json` 会被 Git 忽略，不会提交本地 Cookie。

```json
{
  "doubao_api_key": "你的豆包 API Key",
  "doubao_model": "doubao-seed-1-8-251228",
  "image_dir": "./images",
  "tail_image": "./images/cover.jpg",
  "chrome_path": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "works": {
    "西游记": 4,
    "三国演义": 4
  },
  "platforms": ["baijiahao"],
  "publish": true,
  "interval": 30,
  "baijiahao": {
    "daily_rounds": 5,
    "accounts": [
      {
        "name": "default",
        "cookie": "你的百家号 Cookie"
      }
    ]
  }
}
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

字段说明：
- `works`: 各作品常规批量生成文章数量（作品名: 篇数）
- `platforms`: 发布平台列表（baijiahao / toutiao / wechat）
- `publish`: `true`=直接发布，`false`=仅保存草稿
- `interval`: 每篇发布间隔秒数
- `baijiahao.daily_rounds`: 百家号每天分时发布轮次，和青龙定时次数保持一致
- `baijiahao.category_weights`: 百家号文章类型权重，只影响百家号选题分配
- `baijiahao.accounts`: 百家号账号配置，直接在 `cookie` 中填写账号 Cookie
- `wechat.work_weights`: 公众号已有合集的小说白名单及生成权重，与顶层百家号 `works` 分开维护；随机模式会先按全批文章数计算固定小说配额，再逐轮扣减，未列出的小说不参与公众号生成，设为 `0` 时禁用
- `wechat.category_weights`: 公众号文章类型权重，只影响公众号选题分配；数值越大分配越多，设为 `0` 时禁用
- `wechat.accounts`: 微信公众号账号配置
  - `author`: 文章原创作者名
  - `writer_id`: 作者ID
  - `combine`: `true`=多篇文章合并为一个多图文草稿，`false`=逐篇保存独立草稿（微信最多合并 8 篇）
  - `image_dirs`: 账号级图片素材目录，例如 `["女性朋友圈文案"]`，优先于作品级 `image_dirs`
  - `cover_image`: 素材池没有可用封面时使用的账号级兜底封面
  - `past_recommendations_count`: 该账号生成文章尾部的“往期精彩文章推荐”数量；按已群发文章倒序读取，历史不足时使用实际可用数量，未配置或设为 `0` 时关闭
  - `hot_articles_reference`: 公众号热文标题列表（可选），手动指定的”热文参考标题”。配置后直接作为参考注入选题和写作；未配置时自动读取公众号热文标题
  - `works`: 各作品配置，每个作品可配置 `count`（AI 生成篇数）、`notionUrl`（Notion 同步）、`album_id`/`album_title`（合集）、`image_dirs`（配图目录）

女性朋友圈文案通过生成命令临时指定类别，不限制公众号账号。图片可选配置为：

```json
{
  "name": "新公众号名称",
  "image_dirs": ["女性朋友圈文案"],
  "cover_image": "./images/女性朋友圈文案/封面.jpg",
  "past_recommendations_count": 10
}
```

该类别把 700-2000 字作为软范围，通常以 1200-1500 字为参考，不会因字数偏离而强制重写，也不会要求固定条数或硬凑篇幅。正文默认不插入影视角色图，封面会从 `images/女性朋友圈文案/` 中选择比例接近 3:2 的图片。素材建议使用自有图片、明确授权的图库图片或 AI 生成图片，不要直接搬运其他公众号配图。适合的素材方向包括花朵、咖啡、书桌、城市散步、女性背影和明亮的日常生活场景。

## 使用

### 通用命令（百家号 + 头条号 + 公众号）

```bash
# 检查所有平台登录状态
node src/scripts/main.js check

# 设置 Cookie
node src/scripts/main.js login "你的Cookie"
node src/scripts/main.js login "你的Cookie" -p toutiao
node src/scripts/main.js login "你的Cookie" -p wechat

# 生成选题
node src/scripts/main.js topics -c 10
node src/scripts/main.js topics -w 西游记

# 列出所有作品
node src/scripts/main.js works

# 生成文章大纲
node src/scripts/main.js outline "孙悟空大闹天宫，真的是故意留手吗？"

# 推送单篇文章
node src/scripts/main.js push articles/xxx.md
node src/scripts/main.js push articles/xxx.md -p wechat    # 推送到公众号

# 热文排行（百家号）
node src/scripts/main.js top                   # 查看阅读量/点击率排行
node src/scripts/main.js top -n 20             # 显示前20

# 批量生成 + 发布
node src/scripts/main.js batch                # 按 config.json 配置执行
node src/scripts/main.js batch --no-push      # 仅生成不推送
node src/scripts/main.js batch --publish      # 强制发布（覆盖配置）
node src/scripts/main.js batch --no-publish   # 强制仅草稿（覆盖配置）
node src/scripts/main.js batch -p baijiahao   # 仅发百家号（覆盖配置）
node src/scripts/main.js batch -p wechat      # 仅发公众号（覆盖配置）
node src/scripts/main.js batch --interval 60  # 自定义间隔秒数（覆盖配置）

# 百家号分时发布：青龙每天执行几次，就把 config.json 的 baijiahao.daily_rounds 配成几轮
# 每轮数量按 当日总数 / 轮次 向下取整；最后不足一轮时并入当前轮，例如 50 篇 6 轮 = 8/8/8/8/8/10
node src/scripts/main.js batch --platform baijiahao --daily-record --publish

# 推送所有 ready 状态文章
node src/scripts/main.js push-ready --publish
node src/scripts/main.js push-ready -p wechat     # 仅推送到公众号
```

### 微信公众号 AI 生成

```bash
# AI 直接生成文章 → 推送到草稿箱
node src/scripts/wechat-main.js generate               # 按配置生成所有作品
node src/scripts/wechat-main.js generate 西游记         # 仅生成指定作品
node src/scripts/wechat-main.js generate --no-push     # 仅生成不推送
node src/scripts/wechat-main.js generate --rounds 3    # 执行3轮（批量生成多天文章）
node src/scripts/wechat-main.js generate --account 叙世阁 --category 女性朋友圈文案类 --no-push  # 现有账号临时生成朋友圈文案

# 热文排行（公众号）
node src/scripts/wechat-main.js top                    # 查看阅读量排行
node src/scripts/wechat-main.js top -n 20              # 显示前20
```

### 微信公众号 Notion 同步

```bash
# 从 Notion 同步到公众号草稿箱
node src/scripts/wechat-main.js batch             # 同步所有作品
node src/scripts/wechat-main.js batch 西游记       # 同步指定作品

# 列出草稿
node src/scripts/wechat-main.js list

# 清空草稿
node src/scripts/wechat-main.js clean
```

执行 `wx batch` 时，会先把 Notion 页面同步到本地 Markdown（同步时就完成配图），再继续推送到公众号草稿箱。

### npm scripts 快捷方式

```bash
npm run check          # 检查登录状态
npm run batch          # 批量生成并发布（三平台）
npm run batch:dry      # 批量生成但不推送
npm run batch:bjh      # 仅发百家号
npm run batch:bjh:slot # 百家号分时发布，轮次读config
npm run batch:tt       # 仅发头条
npm run wx:batch       # 微信公众号批量同步
npm run wx:list        # 列出公众号草稿
npm run wx:generate:wenan -- --account 新公众号名称  # 生成女性朋友圈文案账号文章
npm run help           # 显示所有命令
```

`wx:generate:wenan` 不绑定具体账号名，命令会在本次运行中指定 `女性朋友圈文案类`，不会修改账号配置，也不影响该账号下次生成其他类别。首次只建议使用 `--no-push` 检查生成效果：

```bash
npm run wx:generate:wenan -- --account 新公众号名称 --no-push
npm run wx:generate:wenan -- --account 叙世阁 --no-push
```

### 热文参考

百家号批量生成不再自动拉取已发布热文，也不会把热文分析注入选题和写作；选题会从常规分类中直接随机分配。

- **微信公众号**: 如果 `config.json` 的 `wechat.hot_articles_reference` 或账号级 `hot_articles_reference` 配置了热文标题，就直接作为参考用于生成；未配置时，拉取最近一周文章并缓存到本地（`data/wx_articles_cache.json`），读取公众号热文标题作为参考

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

> 如果提示找不到 Chrome 浏览器，需要在 `config.json` 中配置 `chrome_path`。

## 项目结构

```
├── src/
│   ├── core/                # 核心能力：配置、AI、选题、写作、平台 API、图片库
│   └── scripts/             # CLI 入口：百家号/头条/公众号批量生成与发布
├── scripts/
│   ├── download-images.js   # 图片下载工具
├── package.json
└── config.json.example      # 配置模板
```

## 技术栈

- **运行环境**: Node.js
- **AI 模型**: 豆包大模型（火山引擎 ARK API）
- **平台接口**: 百家号/头条号/微信公众号内部 API
- **内容来源**: Notion 公开页面（微信公众号流程）

## License

MIT
