# Changelog

All notable changes to this project are documented here. Versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
