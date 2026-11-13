# Changelog

All notable changes to this project are documented here. Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.3.0

可选成本估算 + CSV 导出。**核心 token 数字仍然是零估算**：`input` /
`cacheRead` / `cacheWrite` / `output` 全部沿用 provider 上报的原始值，本次新增
的 cost 字段完全 opt-in —— 只有当用户自己提供了一张 per-model 价目表时才会出现，
否则所有 cost 列为 `null`、UI 隐藏金额、CSV 该列为空。

- **`/export.csv`**：逐事件导出为 Excel 可读的 UTF-8 CSV（带 BOM）。
  表头固定 `ts,day,session_id,session_title,turn,model,input,cache_read,
  cache_write,output,reasoning,total,provider_cost,cost_estimate,source`；
  含 ETag / 304 短路；`provider_cost` 是 provider 自报花费（绝大多数模型为空），
  `cost_estimate` 仅在价目表加载时填充。
- **`/prices.json`**（GET + POST）：管理可选的 per-model 价目表。
  GET 返回 `{path, table, invalid, doc, models}`，其中 `models` 是账本里出现过
  的模型名列表、`doc` 是自带注释的模板。POST 接受 `{"prices": {...}}` 原样落盘到
  `<dataDir>/prices.json`，传空对象 `{}` 即清空（金额列再次消失）。
  文件格式：键是模型名（大小写不敏感），值可以是单个数字（四桶同价）或
  `{input, cacheRead, cacheWrite, output}` 四桶单价，单位 USD / 1M tokens；
  `_` 开头键与 `$schema` / `$comment` 键作为注释忽略；解析失败的条目计入
  `invalid`，不污染其余有效条目。
- **可选成本估算字段**：`data.json` / `query.json` 的 `totals`、`groups.before` /
  `groups.after`、`sessions[]`、`models[]` 均增加 `costEstimate` /
  `costEstimateEvents` 字段；无价目表时为 `null`。计算公式
  `(input*p.input + cacheRead*p.cacheRead + cacheWrite*p.cacheWrite +
  output*p.output) / 1_000_000`。
- **`health.json`**：新增 `priced`（bool，是否加载了价目表）与 `priceTablePath`
  字段，便于排查价目表是否生效。
- **客户端**：标题栏加「导出 CSV」按钮；筛选范围摘要行在价目表已加载时
  追加 `· 估算成本 $X.XX`（带 `tl-exact` class，与 token 数一致遵循零估算
  排版规则）；无价目表时该提示不出现。
- **版本**：`VERSION` 常量与 `package.json` 同步升到 1.3.0。
- **测试**：四套件全部保持绿；`exact.mjs` 的 `Math.round(` host 侧唯一约束
  （ISO 周算术）与 client 侧禁 `compact(` / `/ 1e(N)` / `.toFixed(N)+"B"` 约束
  均未被新代码触犯。

## 1.2.0

性能与开源发布版本。

- **快照缓存 + ETag / 304**：`data.json` / `query.json` 的聚合结果按 revision
  缓存序列化后的字节，并派生强 `ETag`。客户端带 `If-None-Match` 轮询，数据未变
  时服务端只回一个没有 body 的 304，客户端跳过 `setData`，空闲页面不再每 5 秒
  重算最多 20000 条事件、也不再重复传输整包 JSON。
- **revision**：`buildPayload()` 与 `health.json` 暴露单调递增的 `revision`；
  `generatedAt` 改为每个 revision 冻结的 `snapshotAt`，保证字节稳定。任何写入
  （落盘、会话标题、新轮次开始、分界点移动、历史导入、重置）都会失效缓存。
- **隐藏页签暂停轮询**：`document.hidden` 时跳过定时请求，页签重新可见时立即
  刷新一次，减少后台空转。
- **回退兼容**：`/query.json` 返回 404 时的 `/export.json` 本地聚合路径清除该 URL
  的 ETag，避免旧宿主上残留陈旧标签。
- **可移植性**：全部测试从自身位置解析插件根目录，不再含机器绝对路径；
  `parity.mjs` / `_real-check.mjs` 在没有本地真实账本时优雅跳过。
- **测试**：`mock-host.mjs` 新增 ETag 生成、304 空 body、陈旧标签回退 200、
  不同筛选 URL 独立缓存、写入后标签失效等断言。
- **开源元数据**：`package.json` 补 scripts / repository / keywords / engines；
  新增 MIT `LICENSE`、`.gitignore`、GitHub Actions CI；README 改为中英双语、
  通用安装说明并移除所有本机路径与个人用量数据。

## 1.1.1

- 两本独立账本（之前 / 现在），分界点 `baselineAt` 可移动、读时计算、不改写事件。
- 按天 / ISO 周 / 自然月 / 自定义日期区间与账本维度的全局筛选。
- 四桶精确统计（`input` / `cacheRead` / `cacheWrite` / `output`），
  `reasoningTokens` 作为输出子集单独展示、不重复累加。
- 零估算：全量原始数值、千分位分组，禁用 K/M/B 缩写。
- 侧边栏整页统计 UI，明暗主题跟随宿主；客户端内置与宿主等价的本地聚合回退。
- 回环信任栅栏、原子写账本、20000 事件归档、4000 会话上限。
