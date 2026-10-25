# 缅甸新闻 RSS（Myanmar News RSS）

本项目从 Google News RSS 汇集缅甸及 Burma 相关英文新闻，按新闻来源过滤并去除重复标题，最终生成 RSS 2.0 订阅源，通过 GitHub Pages 发布。

**RSS 订阅源：** <https://hois.github.io/myanmar-news-rss/feed.xml>

**项目页面：** <https://hois.github.io/myanmar-news-rss/>

## 主要功能

- 聚合 Google News 中与 Myanmar／Burma 相关的英文新闻。
- 按新闻来源过滤社交平台、YouTube、电商网站及部分 MITV 国际稿。
- 提供模糊去重和精确去重两种模式。
- 输出经过验证的 RSS 2.0 订阅源，并发布到 GitHub Pages。
- 新内容与已发布版本相同时跳过重复部署。
- 无需数据库、KV、AI API 或跨次运行的持久状态。

## 工作原理

```text
Google News RSS（英文查询，when:1d 当前快照）
  → RSS 验证
  → 新闻来源过滤
  → 标题去重
  → feed.xml
  → GitHub Pages
  → Folo 或其他 RSS 阅读器
```

项目使用固定的 [Google News 查询](https://news.google.com/rss/search?hl=en-US&gl=US&q=%28myanmar%7Cburma%29%20when%3A1d&ceid=US%3Aen)，每次运行只处理该查询返回的当前快照。RSS 内容为英文。项目不保存跨次运行的新闻历史，也不在 Google News 的 `when:1d` 窗口之外建立新闻档案。

输入和输出都会验证为 RSS 2.0。输入必须包含一个带有标题、链接和描述的频道；每条新闻必须有标题、链接、GUID 和有效的 `pubDate`，描述及来源字段可选。对相同输入和模式，输出保持确定；新闻按发布时间从新到旧排列，`lastBuildDate` 取所选新闻中最新的 `pubDate`，并转换为 UTC。

## 如何订阅

将正式 RSS 订阅源地址复制到 Folo 或其他支持 RSS 的阅读器中，按应用提供的添加订阅方式完成订阅：

```text
https://hois.github.io/myanmar-news-rss/feed.xml
```

## 本地使用

需要 Node.js 24 或更高版本。安装锁定的依赖并运行测试：

```sh
npm ci
npm test
```

使用本地测试样例生成订阅源，不访问网络：

```sh
node rss.js --input test/fixtures/handmade.xml --output feed.xml --mode dice
```

从 Google News 抓取当前 RSS 并生成订阅源：

```sh
node rss.js --fetch --output feed.xml --mode dice
```

`--fetch` 使用 Node.js 内置的 `fetch`，来源请求超时为 30 秒且不重试；来源必须返回 HTTP 200 及非空、有效的 RSS 2.0。抓取、验证或生成失败时，不会覆盖现有输出文件。需要比较已发布订阅源时，可设置 `PAGES_FEED_URL`，或对单次运行传入 `--published-url <url>`。

`dice` 是生产使用的模糊去重模式，会合并标题相似的新闻；`exact` 只合并规范化后完全相同的标题。CLI 未指定 `--mode` 时默认使用 `dice`。

## 来源过滤与新闻去重

### 来源过滤

过滤只依据已验证的 `source` 和 `sourceUrl`，不根据标题中的平台名称或商品关键词判断：

- 社交平台：Facebook、X／Twitter、Instagram、LinkedIn。
- 视频平台：YouTube。
- 电商来源：Amazon 域名及 `mobilitypass.com`。
- MITV：不整站排除，只对识别为 Myanmar International TV 的项目应用保守的本地信号规则。

只有 `source` 名称为 Myanmar International TV，或 `sourceUrl` 主机名属于 `myanmaritv.com` 时，才应用 MITV 规则。判断内容前会先清除标题末尾的来源后缀，避免后缀中的 Myanmar 被误判为本地信号。标题若带有栏目式前缀（例如 `Culture and Traditions:`），或包含缅甸相关核心词，会保留；其他不符合本地信号条件的 MITV 标题会被过滤。栏目式前缀须为 1 至 7 个词，后接 ASCII 冒号及至少 3 个词的标题内容。若同一批次有至少 10 条 MITV 新闻，且没有任何标题符合栏目式前缀，MITV 专项过滤会对该批次失效保护并保留所有 MITV 新闻；其他来源过滤仍照常执行。

### 去重与代表新闻

生产模式为 `dice`。模糊去重使用调整后分数 `0.80` 作为门槛；对于严格子集标题，还要求原始 Dice 分数达到 `0.85`，否则不合并。`exact` 模式只合并规范化后相同的标题。

同一去重组以最早的 `pubDate` 新闻作为代表；日期相同时按 GUID、标题稳定排序。输出按发布时间从新到旧排列。

## 自动更新与发布

当前自动更新路径为：

```text
cron-job.org → GitHub workflow_dispatch → GitHub Actions → GitHub Pages
```

仓库内的 [更新 Workflow](.github/workflows/update-feed.yml) 只声明 `workflow_dispatch`，没有启用 GitHub 原生 `schedule`。外部 cron-job.org 负责按其仓库外的配置调用该 Workflow；具体运行间隔不由本仓库文件定义。

在仓库 Actions Variables 中配置以下变量，不要将它们设为 Secrets：

| 变量 | 用途／正式值 |
| --- | --- |
| `DEDUPE_MODE` | 自动运行时的去重模式；正式值为 `dice`，为空时也默认使用 `dice`。 |
| `PAGES_FEED_URL` | 已发布订阅源的比较地址：`https://hois.github.io/myanmar-news-rss/feed.xml`。 |

手动运行 Workflow 时，`mode` 可选 `inherit`、`dice` 或 `exact`。默认的 `inherit` 使用 `DEDUPE_MODE`；选择 `dice` 或 `exact` 只覆盖本次运行，不会修改仓库变量。cron-job.org 自动触发时使用默认的 `inherit`。`DEDUPE_MODE` 未设置或为空时使用 `dice`；无效的非空值会使构建在抓取前失败。

Workflow 使用 Node.js 24 和锁定依赖，在抓取 Google News 前运行 `npm test`，并且只把通过验证的 `feed.xml` 上传为构建产物。新订阅源生成并通过验证后，会与已发布版本比较 SHA-256：相同则跳过构建产物上传和部署；不同则发布有效的新订阅源。比较请求超时为 10 秒；若已发布版本无法比较，仍允许有效的新订阅源发布。来源抓取、过滤、生成或验证失败时，Workflow 不会上传新构建产物，已成功发布的订阅源保持不变；不会因单次失败清空订阅源。

Workflow 中的 Actions 均固定到完整 commit SHA。构建任务仅有 `contents: read` 权限；独立的部署任务使用 `pages: write` 和 `id-token: write`。并发组会取消重叠的运行，但不能撤销已经完成的部署；构建和部署任务的超时分别为 5 分钟和 12 分钟。

RSS 通道中的 `ttl` 为 15 分钟，只是阅读器的缓存提示，不代表 Workflow 的执行频率。

## 已知限制与既有验证记录

- Google News 不是完整新闻数据库；`when:1d` 是查询窗口，不保证完整覆盖过去 24 小时的每一则新闻。
- 生产观察中曾多次收到 100 个项目，但这只是观察结果，不是 Google 官方确认的固定上限。项目不会按 100 条截断结果。
- 项目不保存跨次运行的新闻历史。模糊去重可能误合并不同新闻，也可能漏掉相似标题。
- 既有参数审查中，`0.80` 门槛在已审查样本内没有误合并；这不代表所有未来新闻都不会误合并。`0.85` 严格子集保护目前仍为正式设置；`0.82` 严格子集保护曾被列为候选值，但不是生产参数。
- `when:12h` 曾被测试，但遗漏了一些发布已 12 至 24 小时、仍有价值的新闻，因此没有采用。`when:18h` 仍是待观察候选，不是当前查询窗口。
- 既有生产冒烟记录验证过 Google News 返回 HTTP 200、`dice` 发布、单次 `exact` 覆盖后恢复 `dice`，以及无效的继承模式会在抓取和发布前失败并保留上次成功的订阅源。这些是既有记录，不是本次重新执行的测试。
- 生产环境尚未自然出现 `changed=false` 的批次；该分支由自动化测试覆盖。Workflow 已配置并发运行取消，但尚未在生产环境强制验证。

## 技术信息与相关文件

- **运行环境：** Node.js 24。
- **核心依赖：** [`@rgrove/parse-xml@5.0.0`](package.json)。
- **测试：** `npm test`；测试文件包括 [RSS 与过滤测试](test/rss.test.js)、[去重测试](test/dedupe.test.js) 和 [抓取／CLI 测试](test/fetch.test.js)。
- **主要实现：** [RSS 生成与抓取](rss.js)、[标题去重](dedupe.js)。
- **自动更新：** [GitHub Actions Workflow](.github/workflows/update-feed.yml)。
