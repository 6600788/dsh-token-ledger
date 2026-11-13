# dsh-token-ledger · Token 用量账本

[![CI](https://github.com/6600788/dsh-token-ledger/actions/workflows/ci.yml/badge.svg)](https://github.com/6600788/dsh-token-ledger/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![awesome-dsh-plugin](https://img.shields.io/badge/listed_awesome--dsh--plugin-%E2%9C%93-blue?logo=github)](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)

A sidebar plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai) that keeps a
**fully local** token-usage ledger. It adds a **「Token 账本」** entry to the left sidebar
and opens a full statistics page.

> **中文**：在左侧栏新增「Token 账本」入口，点进去就是完整统计页：**两个独立账本**、
> 按周 / 月 / 天与自定义区间筛选、四桶拆分、每个模型用量，以及随时可查的精确总计。
> 所有数据只存在本机，不上报、不联网。

**Highlights / 特性**

- Two independent books — **之前 (Before)** vs **现在 (After)** — split at a movable `baselineAt`.
- Exact values only: full digits with thousands separators, never `K` / `M` / `B`, never rounded or estimated.
- Four-bucket accounting (`input` / `cacheRead` / `cacheWrite` / `output`); `reasoningTokens` is a subset of output and is never double-counted.
- Global filters: today / this week / last week / this month / last month / last 7 or 30 days, custom date range, any ISO week, any calendar month.
- **Optional cost estimate**: provide a per-model price table and `data.json` / `query.json` will expose a `costEstimate` field; tokens are always zero-estimation.
- Cached server-side aggregation with `ETag` / `304`, so an idle page costs a bare ~200-byte response instead of re-downloading a large JSON payload.
- Client-side fallback that reproduces the host's numbers exactly when the host is still on an older build.

---

## 两个账本 · Two books

顶部两张卡片是彼此独立的账本，各自有自己的总消耗，点卡片即可只查看其中一本。

| 账本 Book | 内容 |
| --- | --- |
| 「之前」 Before | 分界点以前的全部消耗，含从 whale 账本导入的安装前历史 |
| 「现在」 After | 分界点以后新记的每一轮，精确到会话 id、轮次、模型、四桶 |

分界点 `baselineAt` 默认是插件首次启动时刻，存在 `ledger.json` 里。**分界是读时计算，
不改写、不删除任何事件**，所以可以随时移动再恢复：

- 「从现在重新起账」→ 把分界线移到此刻，此后的新消耗全部记进「现在」。
- 「恢复默认分界」→ 回到首次启动时刻。
- 两本相加永远等于合计，移动分界不会改变总量。

## 筛选范围 · Filters

筛选是**全局**的：KPI、构成条、趋势图、按会话 / 按模型 / 按周月 / 消耗明细四个表
全部跟随同一范围。

- 快捷 Quick: 全部时间、今天、本周、上周、本月、上月、近 7 天、近 30 天
- 自定义 Custom: 两个日期输入框，任选「某天 ~ 某天」
- 某周 Week: 下拉列出账本覆盖的所有 ISO 周（周一 ~ 周日，如 `2026-W44`）
- 某月 Month: 下拉列出所有自然月
- 「清除筛选」一键回到全部

服务端 `/query.json` 按 `group` + `from` + `to` 聚合；周和月都在服务端算好小计，
每行都带输入 / 缓存读 / 缓存写 / 输出、事件数、会话数、轮次数。

## 页面功能 · Page sections

| 区域 | 内容 |
| --- | --- |
| 顶部 KPI | 合计消耗、输入、缓存读取、缓存写入、输出（含推理数）、今日消耗、会话 / 轮次、历史费用 |
| 两本账卡片 | 各自的总量、事件数、会话数、四桶 mini 拆分、时间范围、主要模型 |
| 消耗构成 | 四桶占比堆叠条 + 图例 |
| 消耗趋势 | 按天 / 按周 / 按月分段切换的柱状图 |
| 按会话 | 每个对话的消耗、轮次、事件数、四桶拆分、最后活动、占比；点行展开模型拆分与最近明细 |
| 按模型 | 每个模型的事件数、会话数、四桶拆分、推理、占比 |
| 按周 / 月 | 每周 / 每月 / 每天一行，9 列小计 + `<tfoot>` 总计行 |
| 消耗明细 | 时间 / 会话 / 轮次 / 模型 / 输入 / 缓存读 / 缓存写 / 输出 / 推理 / 合计 / 来源，可搜索 |
| 统计口径 | 两本账、筛选、四桶与模型、数据与接口的完整说明 |

顶部按钮：刷新、暂停刷新、补导历史、导出账本。明暗主题跟随宿主，样式全部使用
`--dsw-alias-*` 原生变量。

### 轮询与缓存 · Polling and caching (v1.2.0)

页面每 5 秒轮询一次，可暂停。为了避免空闲时的重复计算与传输：

1. Host 把 `data.json` / `query.json` 的**序列化结果按 revision 缓存**，并派生一个
   强 `ETag`（`sha256` 前 16 字节）。`generatedAt` 也按 revision 冻结，保证数据未变时
   响应字节完全一致。
2. 任何写入（落盘、会话标题变化、新轮次开始、分界点移动、历史导入、重置）都会
   `bump()` revision 并清空缓存。
3. 客户端保存每个 URL 的 `ETag`，下次带 `If-None-Match` 请求；命中时服务端返回
   **无 body 的 304**，客户端跳过 `setData`，页面不重渲染。
4. `document.hidden` 时跳过定时请求，页签重新可见时立即刷新一次。
5. `cache-control: no-store` 始终保留 —— 这是应用层条件请求，不是浏览器 HTTP 缓存，
   账本数据永不落到磁盘缓存。

`health.json` 与 `buildPayload()` 都暴露单调递增的 `revision`，便于外部轮询判断是否需要拉取全量。

## 数值精度 · 零估算 (Exact values)

页面上的 Token 数值全部是**账本里存的原始逐位精确值**，只加千分位分隔符：

- **不用** `K` / `M` / `B` 缩写，不四舍五入，不估算，不取近似值。例如显示
  例如显示 `12,345,678,901`，不显示 `12.35B`。
- 覆盖：顶部 8 张 KPI、两本账卡片、消耗构成图例、柱状图悬停提示、按会话 / 按模型 /
  按周月 / 逐条明细的每一个单元格；鼠标悬停数字可见完整值。
- 百分比保留 2 位小数，费用最多 4 位小数；上游若上报小数 token 也原样保留。
- 记录侧同样零折算：`usage` 里的整数直接累加，导出 JSON 与页面显示完全一致。
- 长数字会按长度自动缩小字号并允许折行，绝不被卡片裁掉或省略。

`test/exact.mjs` 用 VM 加载真实 `client.js`，锁死这些约束；并静态扫描源码禁止
`compact()` / 除以 `1e9` / `B` 后缀。

## 统计口径 · Accounting

按 DSH 官方 `tokenUsage` 四桶相加：

```
total = inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens
```

- `inputTokens` 与 `uncachedInputTokens` 是别名（DSH 的 `bucketsFrom` 把前者映射成
  后者），只取其一，不相加。
- `reasoningTokens` 是 `outputTokens` 的子集，**不重复累加**，仅单独展示。
- 安装前的历史来自 `~/.dsh/.dshw-usage.json`（whale 账本）：首次启动导入时间戳早于
  启动时刻的全部记录，放进合成会话「历史用量（安装前 · whale 账本）」，保留原费用；
  按 `ts|model|tokens` 去重、幂等，可随时点「补导历史」重跑。
- 兼容 whale 的两种文件格式：新版对象包
  (`{ date, lastBalance, ..., events: [...] }`) 与旧版裸数组；元数据绝不当用量。
- **历史日志只有总量、没有四桶拆分**，所以「之前」这本的四桶显示为 0、总量有值；
  「现在」这本从第一条实时记录起四桶齐全。页面构成条因此注明「四桶之和可能小于合计」。
- 不读取 `.codearts-usage.json`（按天汇总、无时间戳、会与 whale 重复计）。

## 数据 · Data & privacy

- 账本：`~/.dsh/token-ledger/ledger.json`（`DSH_HOME` 可覆盖；原子写：先写 `.tmp` 再 `rename`）
- 归档：事件超过 20000 条时，前半归档到 `events.archive.json`
- 会话数上限 4000，超出按最久未活跃淘汰
- **全部数据本地保存，不上报、不联网**。仓库里不含任何真实账本或个人用量数据。
- 所有 HTTP 路由仅回环 + 同源放行（见下）。

## HTTP 接口 · Routes (loopback + same-origin only)

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-token-ledger/data.json` | 全量页面数据（无筛选，兼容旧客户端）；带 `ETag` |
| GET | `/dsh-token-ledger/query.json?group=&from=&to=&label=` | 按账本 / 日期区间聚合，页面默认走这里；带 `ETag` |
| GET | `/dsh-token-ledger/health.json` | 健康检查（含 `baselineAt`、`revision`） |
| GET | `/dsh-token-ledger/export.json` | 完整账本 JSON |
| POST | `/dsh-token-ledger/baseline` | 移动分界点：`{"at":<ms>}` 或 `{"reset":true}` |
| POST | `/dsh-token-ledger/import-history` | 重跑历史导入 |
| POST | `/dsh-token-ledger/reset` | 清空实时记录（需 `{"confirm":true}`，保留历史并重新起账） |

信任栅栏：Host 必须回环或列在 `DSH_TOKEN_LEDGER_HOSTS`；`sec-fetch-site: cross-site`
拒绝；http/https Origin 与 Host 不同源拒绝；`dsh-app:` / `app:` / `file:` / `null`
视为本地 shell 放行。请求体上限 65536 字节。

条件请求示例：

```bash
# 首次取数据，记下 ETag
curl -i "${GUI_ORIGIN}/dsh-token-ledger/health.json"

# 用 ETag 轮询，未变化时返回 304 且无 body
curl -i -H 'If-None-Match: "<etag>"' \
  "${GUI_ORIGIN}/dsh-token-ledger/query.json?group=all"
```

## 不用重启也能用 · Graceful fallback

`client.js` 内置一套与宿主**完全相同的聚合逻辑**。如果页面刷新了但宿主进程还是旧版
（`/query.json` 返回 404），客户端会自动改拉 `/export.json` 在浏览器本地算出两本账、
周 / 月、筛选结果，并在筛选栏标注「页面本地统计」。`test/parity.mjs` 会逐字段比对
两条路径的输出，保证数字一致。

宿主重启后 `/query.json` 生效，自动切回服务端聚合（更快，且带 `revision` /
`pendingTurns` 等实时状态）。回退分支会清掉该 URL 缓存的 ETag，避免旧宿主上残留陈旧标签。

## 安装与启动 · Install

前置条件 Preconditions：Node >= 18、DSH `>=0.1.5-rc.1`、一个可用的 DSH profile。

```bash
# 1) 把仓库放到 profile 的 plugins 目录
git clone https://github.com/6600788/dsh-token-ledger.git \
  ~/.dsh/plugins/dsh-token-ledger

# 2) 在 profile 的 package.json 里注册（路径按实际位置调整）
#    dependencies:
#      "dsh-token-ledger": "link:../plugins/dsh-token-ledger"
#    dsh.profile.bundles:
#      - "dsh-token-ledger"
```

也可通过 DSH 的插件管理命令启用已安装的 bundle；启用后：
`~/.dsh/profiles/<profile>/package.json` 的 `dsh.profile.bundles` 会追加
`dsh-token-ledger`，依赖以 `link:` 指向插件目录。

启动行为：

- **client 改动**：刷新 GUI 页面即可看到新界面。
- **host 改动**：完全退出 DSH（含托盘）再重启，让 `/query.json`、`/baseline` 等路由生效。
- 刷新后若 `/query.json` 仍 404，页面会自动进入本地统计模式，功能不受影响。

验证接口（`${GUI_ORIGIN}` 为 GUI 地址，端口随宿主重启变化，以打印的 URL 为准）：

```bash
curl "${GUI_ORIGIN}/dsh-token-ledger/health.json"
# {"ok":true,"plugin":"dsh-token-ledger","version":"1.2.0","revision":...,"baselineAt":...}

curl "${GUI_ORIGIN}/dsh-token-ledger/query.json?group=all"
# 带 groups / weeks / months / facets 的 JSON
```

## 源码结构 · Layout

```
dsh-token-ledger/
├── package.json            清单（dsh.bundle.patch / dsh.client / scripts）
├── cordis.patch.yml        Cordis 注册条目
├── lib/
│   ├── index.js            Host：会话事件订阅、账本持久化、缓存/ETag、聚合与 7 条 HTTP 路由
│   └── client.js           Client：侧边栏入口 + 整页统计 UI + 本地回退聚合
├── test/
│   ├── mock-host.mjs       离线 host 测试（含 ETag/304 断言，隔离临时目录）
│   ├── parity.mjs          本地回退 vs 宿主聚合逐字段一致性测试
│   ├── exact.mjs           精确数值回归测试（锁死零缩写 / 零估算）
│   └── _real-check.mjs     可选：真实账本副本冒烟检查，无数据则跳过
├── .github/workflows/ci.yml  GitHub Actions（Node 18/20/22 × ubuntu/windows）
├── CHANGELOG.md
├── LICENSE                 MIT
└── README.md
```

## 测试 · Tests

```bash
cd dsh-token-ledger
npm test
```

`npm test` 等价于：语法检查 + 依次运行四个套件。也可单独运行：

```bash
node test/exact.mjs
node test/mock-host.mjs
node test/parity.mjs
node test/_real-check.mjs
```

| 套件 | 覆盖 |
| --- | --- |
| `mock-host.mjs` | 轮次分桶、reasoning 不重复计、会话隔离、标题事件、历史导入与幂等、重启持久性、reset 语义、回环信任栅栏、7 条路由、两本账在可移动分界点上的完全划分、`group` / 日期 / 周筛选、周 + 月小计四桶字段、**ETag 生成 / 304 空 body / 陈旧标签回退 200 / 不同 URL 独立缓存 / 写入后标签失效** |
| `parity.mjs` | 10 组合成筛选 + 可选的真实账本筛选，逐字段比对 `totals` / `groups` / `sessions` / `models` / `weeks` / `months` / `days` / `facets` / `recentEvents` |
| `exact.mjs` | VM 加载真实 `client.js`，断言十亿级数值按完整位数渲染、小数 token 保留、千分位可无损还原；静态扫描禁止 `compact()` / `1e9` 缩写 / `B` 后缀，并确认 host 唯一的 `Math.round` 只用于 ISO 周计算 |
| `_real-check.mjs` | 可选，只读真实账本副本打印汇总；无本地账本时打印 `SKIPPED` 并正常退出 |

`DSH_TOKEN_LEDGER_REAL=/path/to/ledger.json` 可指定用于可选真实数据检查的账本；
`DSH_HOME` 可覆盖账本根目录。所有测试都在临时目录操作，不写入真实账本。

## 可选成本估算 · Optional cost estimate

**核心 token 数字仍然是零估算**：`input` / `cacheRead` / `cacheWrite` / `output`
全部沿用 provider 上报的原始值。新增的 cost 字段完全 opt-in —— 只有当你自己提供
一张 per-model 价目表时才会出现；否则所有 cost 列为 `null`、UI 隐藏金额、CSV
该列留空。

### 价目表位置

`<DSH_DATA_ROOT>/dsh-token-ledger/prices.json`，具体路径可从 `health.json` 的
`priceTablePath` 字段拿到。

### 文件格式

```jsonc
{
  "_comment": "Optional. Prices in USD per 1M tokens. Delete a key (or the file) to hide cost.",
  "deepseek-chat": { "input": 0.27, "cacheRead": 0.07, "cacheWrite": 0.27, "output": 1.1 },
  "deepseek-reasoner": { "input": 0.55, "cacheRead": 0.14, "cacheWrite": 0.55, "output": 2.19 },
  "some-model-with-flat-rate": 3.0  // 四桶同价
}
```

规则：

- 模型键**大小写不敏感**（内部统一 lowercase）。
- 值可为单个数字（四桶同价）或 `{input, cacheRead, cacheWrite, output}` 四桶单价。
- 单位 **USD / 1M tokens**。
- `_` 开头键与 `$schema` / `$comment` 键作为注释忽略；解析失败的条目计入
  `invalid`，不污染其余有效条目。

### 管理方式

1. **REST**：`GET /dsh-token-ledger/prices.json` 返回 `{path, table, invalid, doc,
   models}`（`doc` 是自带注释的模板，`models` 是账本里出现过的模型名列表）；
   `POST /dsh-token-ledger/prices.json` body `{"prices": {...}}` 原样落盘，传空
   对象 `{}` 即清空（金额列再次消失）。
2. **直接编辑文件**：每次请求都读盘，无需重启宿主。
3. **UI 编辑面板**：当前版本未加，后续补。

### 计算与字段位置

`cost = (input*p.input + cacheRead*p.cacheRead + cacheWrite*p.cacheWrite +
output*p.output) / 1_000_000`。字段出现在：

- `totals.costEstimate` / `totals.costEstimateEvents`
- `groups.before.costEstimate` / `groups.after.costEstimate`
- `sessions[].costEstimate`
- `models[].costEstimate`
- CSV 的 `cost_estimate` 列

无价目表时这些字段均为 `null`、UI 隐藏金额、CSV 该列留空。

## License

[MIT](LICENSE)
