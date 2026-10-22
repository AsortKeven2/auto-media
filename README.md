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

#### 公众号改用 Claude 写作（可选）

在 `config.json` 的 `wechat` 下加 `"llm": "claude"`，公众号命令（`wx:generate` 等）的选题、写作和审核就会改用本机已登录的 Claude Code（无头模式，不需要 API key），配图、上传、存草稿等其他流程不变；改成 `"doubao"` 或删掉这一项就回到豆包。百家号看 `baijiahao.llm`，不写默认豆包，现在配的是 `"workbuddy"`（见下）。

```json
{
  "wechat": { "llm": "claude" },
  "claude": { "model": "claude-opus-5-5", "effort": "medium" }
}
```

- 只在装了 Claude 桌面端或 Claude Code 的机器上设成 `claude`；NAS 上没有，百家号不要改
- 代理自动处理：每次运行时读取 macOS 当前生效的系统代理（开着哪个代理软件就用哪个的端口），只给 Claude 用，豆包和平台接口照旧直连；要固定某个代理可以填 `claude.proxy`（如 `"http://127.0.0.1:7890"`）。代理软件需要开启“系统代理”，否则 Claude 会报 403
- 默认使用 Claude 桌面端自带的最新版 Claude Code，也可以在 `claude.bin` 里指定路径；`~/.local/bin/claude` 低于 2.1.280 时不支持 `claude-opus-5-5`
- 用量计入 Claude 订阅的额度，并发高时可能触发限速，失败会自动重试

#### 百家号走 WorkBuddy 网关

NAS 上部署了 WorkBuddy2API 网关（Docker 项目 `workbuddy2api`，端口 7863），把 WorkBuddy 账号包装成 OpenAI 兼容接口。平台下设 `"llm": "workbuddy"` 就改走网关，用的是 WorkBuddy 账号的积分：

```json
{
  "baijiahao": { "llm": "workbuddy" },
  "workbuddy": {
    "base_url": "http://172.17.0.1:7863/v1",
    "api_key": "网关的 WB2A_API_KEY",
    "model": "deepseek-v4.1-flash"
  }
}
```

- `base_url` 写到 `/v1` 为止；`172.17.0.1` 是 NAS 上 Docker 默认网桥的宿主机地址，青龙和公众号助手容器都能连到，在 NAS 外面跑要换成 NAS 的局域网 IP
- 思考档位：选题等普通调用不思考；写文章的整个过程（事实清单、成文、文风和字数修改，auto-media-web 的贴图文案也一样）开低档思考（`reasoning_effort: low`，另外多给 8000 token 的额度）；逐句核验和识别作品不开，实测核验开思考会把上万 token 全耗在思考上、一个字不输出。思考把额度用完时会自动改成不思考重发一次
- 不显式关掉思考的话，网关会给 deepseek 系模型默认开高档思考，`max_tokens` 会被耗光、正文为空
- 可选模型和积分倍率看网关的 `/v1/models`（deepseek-v4.1-flash 为 x0.11）；账号登录、余额在网关面板 `http://<NAS IP>:7863/panel/` 里看
- auto-media-web（公众号助手）不写 `wechat.llm` 时默认走这个网关

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
- `baijiahao.fact_check` / `wechat.fact_check`: 是否在写作前列原著事实、写完后逐句核验并自动修改，默认开启；每篇多 2-5 次 AI 调用，赶时间时可设为 `false`
- `baijiahao.concurrency` / `wechat.concurrency`: 同时生成的数量，默认 `5`（最大 10）。百家号按篇并发、发布仍按 `interval` 逐篇进行；公众号按轮并发、每轮内按顺序生成，上传图片和保存草稿排队进行。命令行 `--concurrency <n>` 可临时覆盖
- `baijiahao.accounts`: 百家号账号配置，直接在 `cookie` 中填写账号 Cookie
- `wechat.work_weights`: 公众号已有合集的小说白名单及生成权重，与顶层百家号 `works` 分开维护；随机模式会先按全批文章数计算固定小说配额，再逐轮扣减，未列出的小说不参与公众号生成，设为 `0` 时禁用
- `wechat.category_weights`: 公众号文章类型权重，只影响公众号选题分配；数值越大分配越多，设为 `0` 时禁用
- `wechat.accounts`: 微信公众号账号配置
  - `author`: 文章原创作者名
  - `writer_id`: 作者ID
  - `combine`: 普通生成/同步模式下，`true`=多篇文章合并为一个多图文草稿，`false`=逐篇保存独立草稿；随机生成模式（`--random n`）每轮抽 n 个合集、每个出 `--per` 篇（默认 1），这一轮的文章合成一个多图文草稿（超过 8 篇才拆开）；`--rounds` 是轮数，也就是草稿数，默认 10
  - `image_dirs`: 账号级图片素材目录，例如 `["西游记"]`，优先于作品级 `image_dirs`
  - `cover_image`: 素材池没有可用封面时使用的账号级兜底封面
  - `past_recommendations_count`: 该账号生成文章尾部的“往期精彩文章推荐”数量；按已群发文章倒序读取，历史不足时使用实际可用数量，未配置或设为 `0` 时关闭
  - `hot_articles_reference`: 公众号热文标题列表（可选），手动指定的”热文参考标题”。配置后直接作为参考注入选题和写作；未配置时自动读取公众号热文标题
  - `works`: 各作品配置，每个作品可配置 `count`（AI 生成篇数）、`notionUrl`（Notion 同步）、`album_id`/`album_title`（合集）、`image_dirs`（配图目录）

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

# 随机模式默认20轮，每轮2篇，共40篇；每2篇合并为一个多图文草稿（共20个草稿）
node src/scripts/wechat-main.js generate --random 2 --account 叙世阁

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
npm run help           # 显示所有命令
```

### 热文参考

百家号批量生成不再自动拉取已发布热文，也不会把热文分析注入选题和写作；选题会从常规分类中直接随机分配。

- **微信公众号**: 如果 `config.json` 的 `wechat.hot_articles_reference` 或账号级 `hot_articles_reference` 配置了热文标题，就直接作为参考用于生成；未配置时，拉取最近一周文章并缓存到本地（`data/wx_articles_cache.json`），读取公众号热文标题作为参考

### 写作风格与质检

小说类文章（百家号和公众号共用）照搬头条号“武侠百晓通”的思维方式和写法（`src/core/categories.js` 的 `STYLE_GUIDE`，蒸馏自他 1098 篇文章）：从人人都知道的情节切入再立刻反问，自答给出反常识的结论，用利益和性格解释人物，转述原著情节当证据，定性断语收尾；书面说理腔（毕竟、其实、可见、笔者、要知道、那么问题来了），网络梗一两处封顶；每段两三句、55-70 字。用词、句式、段长的数量按他分段完整的 686 篇实测校准，和蒸馏稿不一致的以实测为准（例如骨架连接词他每篇中位 4 次，不是 10-18 次）。和蒸馏稿不同的取舍：篇幅按下面的字数配置；三国、西游照写；推论和跨书关联必须落在原著确有的情节上，事实核验照旧。

文章类别完全照搬他的选题方向（原来自己定的十二个类别已全部删除）：把他 1098 篇标题逐篇归类，九个方向的占比就是两个平台默认的 `category_weights`。他几乎不写假设对决，明确写“谁打得过谁”的只有 3 篇，所以没有对战类。

| 类别 | 权重（他的占比） | 写什么 | 结构 | 小标题 |
|---|---|---|---|---|
| 动机揭秘类 | 22 | 人物为什么这么做，答案落在利益、性格或隐情上 | 解谜文六段式 | 不用 |
| 实力解析类 | 17 | 一个人物或一门武功到底有多强、为何打不过谁 | 解谜文六段式 | 不用 |
| 高手排名类 | 12 | 按武功、实力给几位高手排名次 | 榜单文五段式 | `## 第X名：名字` |
| 人物揭秘类 | 10 | 有反差的人物（唯一……的人、最……的好汉）的经历和下场 | 人物反差型 | 不用 |
| 人物榜单类 | 9 | 按武功以外的标准评选几个人物（最适合当妻子、最会算计、名不副实） | 榜单文五段式 | `## 第X名：名字` |
| 认知反转类 | 9 | 长大后才懂：重新解读人物或情节，开头固定从读书认知的转变写起 | 解谜文六段式 | 不用 |
| 身世关系类 | 9 | 身世、师承、传人后代、被忽略的关系（必须原著写明） | 六段式考据版 | 不用 |
| 作者揭秘类 | 8 | 作者的起名、伏笔、改版、原型 | 六段式考据版 | 不用 |
| 后续结局类 | 4 | 人物结局，或射雕、神雕、倚天之间交代过的后续（不写续写同人） | 六段式考据版 | 不用 |

解谜文六段式：大众印象→抛出疑问→转述情节→反常识结论→利益/性格归因→定性收尾。榜单文五段式：踩旧榜单→从末位逐位点评→每位一句定性→榜首加冕→定性收尾。

选题标题照他全部 1098 个标题的统计来写（两个平台一样）：22-28 字（他中位 26 字，20 字以内的只有 3%）；79% 用两个逗号或问号分成三段——人物和反常的事实或问题、线索或位次（“你看……”“某某第2”）、结果或悬念；问号多放在中间，以问号结尾的只有 8%；数字用阿拉伯数字；常用模具是疑问体、你看解谜体、榜首型、难怪体、榜单体、《书名》开头型、顿悟体、质疑体、定性反差体；标题里至少有一个专有名词。

生成流程：标题审核（见下）→ 列原著事实（只保留有把握的）→ 按事实写作（开头、结尾写法按他的比例抽取：开头多为“《书名》中，……”或推翻大众印象，结尾多为定性断语）→ 字数校验（不够时只从事实清单里补）→ 文风质检（`src/core/style-lint.js`，命中口头禅、套话、不确定说法、写景意象词、网络梗超过两处、连接词堆砌、全篇没有设问、段落超过 100 字、编造经历、引流话术时做一次定向修改；阈值以他本人 74% 的文章能直接通过为准）→ 最后核验（逐句找出与原著不符或没有依据的句子，按问题清单自动修改后再核验，最多两轮；两轮后仍被点名的句子直接删除，超过 5 句判为不合格）→ 配图整理。百家号的核验放宽：只查和原著明确矛盾的硬伤（人物关系、身份、师承、武功兵器归属、谁做了什么、生死结局、先后顺序、跨书串台、引号里编的原话），补的动作表情场景细节、不离谱的数字、说得通的推论都不算；两轮后硬伤不超过 8 句就删句发布。公众号照旧逐句严查。

- 字数：公众号 1500-2500 字，百家号 1300-1800 字
- 原文引用：情节以转述为主，人物台词有把握才加引号；只有三国、水浒、西游允许标注一处“（原文）”，金庸、古龙等作品只能转述
- 配图：正文最多 5 张；开头两段、结尾三段不放图，两张图之间至少隔 3 段；榜单、清单的图放在对应小标题下面
- 公众号标题：不再限 20 字，和百家号一样按他的 22-28 字写；主角必须来自 `src/core/famous-characters.js` 里的一线人物名单，不含一线人物的选题会被丢弃重出。之前“15 字以内阅读中位数 882、21-25 字只有 46”的结论是被 7-8 月那批对战短标题带出来的：只看对战题，15 字以内中位 1697；去掉对战题，15 字以内中位只有 15，21-25 字中位 83 反而最好
- 作品选择：按两个号的数据配权重。射雕英雄传在两个号都是表现最好的书（同期阅读中位数是其他主流书的 4-17 倍，约一半文章过千），权重最高；碧血剑、雪山飞狐、连城诀、书剑恩仇录 17 篇无一过千，权重设为 0 不再写；另外只写武侠百晓通写的书加三国、水浒、西游：他 1098 篇里神雕 20%、天龙 18%、倚天 16%、射雕 13%、水浒 12%、笑傲 3.5%，鹿鼎记只有 1%，侠客行、碧血剑、雪山飞狐、书剑、西游记后传基本没有，所以鹿鼎记、侠客行、西游记后传也停写（权重 0）。百家号的 `works`（每天每部书的篇数）合计仍是 50 篇，停写空出的名额给了他写得最多的神雕、天龙、倚天
- 公众号头条位：多图文草稿里，作品权重最高的那篇排第一位，权重相同再看一线人物和标题长短（同次群发里头条阅读约为次条的 1.7 倍，冷门书当头条时阅读常常只有个位数）
- 标题审核（两个平台都做）：只判定能不能用，标题一律不由代码改。事实前提与原著不符的、有错别字或病句的、武功名写成截短叫法（如把降龙十八掌写成“降龙”）的，直接剔除；再把标题拆成词，脱离标题查每个词在现代汉语里最常用的意思，带回标题做代入检查，有读者会读岔的词（如把“百回合”写成“百合”、用古白话“端的”说“究竟”）也剔除。被剔除的由生成器重新出题，每轮篇数不变。百家号放宽：事实前提只刷和原著明确矛盾的（关系、身份、归属写错，编了和原著冲突的事件），“唯一”“最”这类论断、“你看他说了什么”这种后半句钩子、拿不准的都放行；不做读岔核对；错别字、病句、截短武功名照样剔除
- 分工原则：代码只管能量化的规则（禁用词、公众号字数、一线人物名单），用词读不读得懂交给标题审核判断，不按个例写正则补丁

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
