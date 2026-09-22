# 更新日志（CHANGELOG）

本文件记录 One-Relay 的重要变更，最新在前。更详细的设计说明见 [docs/DESIGN.md](docs/DESIGN.md)。

## 2026-09-22

### 商汤 RPS 限速适配（实测驱动）
- **实测结论**：商汤 `token.sensenova.cn` 的限流是 **RPS（每秒请求数）**，阈值约 **4/秒/账号**（响应体 `{"error":{"message":"rps exhausted"}}`）。实测并发 4 全过、5 临界、6 几乎全 429；串行 120 次/分钟反而不触发——证明不是 RPM/TPM。
- **429 分类型处理**（修复「频繁请求被踢」）：
  - 速率类（`rps`/`rate limit`）→ **秒级冷却 2 秒**，绝不停用（RPS 是秒级窗口，下一秒即恢复）
  - 额度类（quota/余额）→ 保留原有「累计提醒 2 次 → 停用 → 每晚 0 点恢复」
  - 评分新增两项惩罚：`429冷却`、`RPS已满`
- **RPS 节流**：`providers.json` 每站可配可选 `"rps": N`（0/不填=不限）。维护每秒请求窗口，达上限的站在候选排序中**实时垫底**（不排除、保留兜底），发送前计入窗口。
- **面板可见**：Provider 页新增「RPS上限」列，显示 `当前秒已发/上限`（429 冷却中带 ⏳ 标记）；编辑弹窗新增 RPS 输入框（留空=不限）；status 接口新增 `rps`/`rpsNow`/`cooling429` 字段。
- **商汤/商汤1 配 `rps: 4`**。端到端验证：并发 8 个请求商汤独有模型 → **8/8 全成功**（686ms），日志显示精确 **4+4 分派**到两个账号（各等于其 RPS 上限），零 429。对比修复前并发 6 即出 429。

### 英伟达站实测不可用（已删除）
- `integrate.api.nvidia.com`：key 正常（`GET /models` 376ms 返回 82 个模型），但 chat 极慢/不可用——`deepseek-v4.1-flash` 首字节 **22~47 秒**（且正文空），`kimi-k3`/`glm-5.3`/`glm-5.3-flash` 全部 **ECONNRESET**（单测也失败，排除并发因素）。根因：NIM 免费层推理排队严重。因会撞路由 30s 上游超时拖垮请求，用户已删除该站。

## 2026-09-10

### 修复 AI 助手「不好用」两大根因（commit b26eee8）
- **思考吞掉正文**：助手模型 `glm-5.3-flash` 是深度思考型，reasoning 占约 87% 输出，且助手请求 payload 从未设 `max_tokens`（用上游默认小值）→ 思考耗光 token、正文（JSON 工具块 / 配置提案）被截断 → 解析失败 →「加站老是错」。
  - 助手 payload（流式 + 记忆巩固非流式）加 `max_tokens: 8192`。
- **助手不知道路由代理状态**：`configSummary` 只列站名/地址/模型；已增强为每站带「探活通不通 / 停用原因（踢出·限流·手动）/ 评分」+ 阵容总览。
- 按「不关思考、拆开识别」实现：
  - 前端 `streamAssistant` 分开收集 `delta.reasoning_content`（兼容 `reasoning` 字段）与 `delta.content`。
  - 思考折叠成「💭 思考过程」，不混入正文；正文单独用于解析工具块/提案。
  - 后端回传上游时剥离 `reasoning` 字段只传 `role+content`（防 strict 中转站报 UNKNOWN_FIELD）。

### 面板实时化（commit 9ad285b / 1b9ecb8）
- **轮询 → SSE 服务端推送**：后端新增 `/admin/api/events`（event-stream + 250ms 事件合并），4 处埋点（请求/探活/settings 热加载/providers 热加载）；前端 EventSource 监听即时刷新，轮询降为 15s 兜底。
- **优先级 ↑↓ 卡顿 → 乐观更新**：拆纯渲染函数，本地立即换序重绘 + 后台异步提交。

### Provider 页刷新修复（commit f62c730）
- Provider 管理页此前无自动刷新（只切 tab 渲染一次）；纳入 5s 轮询 → 改由 SSE 驱动。
- 「全部探活」按钮从硬等 6s 改轮询 busy 直到完成。

## 2026-08-28

### 工程化补齐
- **测试套件** `tests/run-tests.js`：76 项断言，零依赖，从源码提取纯函数 + mock 注入（`node tests/run-tests.js`）。
- **pre-commit 钩子**：三文件 `node --check` + 跑测试，不通过阻止提交。
- **架构文档** `docs/DESIGN.md`：总览图 / 请求生命周期 / 评分公式 / 故障转移矩阵 / 三层健康防护+断网保护 / 流式 / AI 助手 / 看护自启 / 安全模型 / 数据文件。

## 2026-08-27

### 本机断网误判站挂 — 三重防护（commit 2f596f1）
- 业务请求成功即时纠偏探活快照为「通」；探活结果超 45 分钟不采信惩罚；批量探测 ≥80% 站同时失败判定「本机网络故障」，全员不计连败、不自动踢，只托盘通知。

### 开机自启修复（commit f10d70e）
- 启动项 `路由代理自启.vbs` 原指向已删除的桌面 bat → 重写指到项目 `start-hidden.vbs`。
- `start-hidden.vbs` 加 `%USERPROFILE%\nodejs\node.exe` 候选（防 PATH 首位的第三方 node 失效导致自启静默失败）。

### 开源同步（GitHub `liushunsan3/one-relay`）
- 脱敏清理后被要求"注意脱敏"；因 `git push` 到 github.com:443 被墙，改用 Git Data API 原子提交（脚本 `sync-github.cjs`，本地工具不入库）。

## 2026-08-25

### 路由核心 bug 修复与健壮性
- `shouldFailover`：5xx 一律换站（修裸 502/503 死磕不换站的 bug）。
- 5xx 熔断：连续 3 次 5xx 冷却 3 分钟、评分垫底；上游超时 60s → 30s。
- 429 限流：连续 5 次提醒；当天累计 2 次自动停用（`disabledBy:'quota'`），每晚 0 点自动恢复。
- 局域网访问开关（`bindLan`）：监听 `127.0.0.1` ↔ `0.0.0.0` 运行时热切换（串行化防并发 listen 竞态）；自定义 API Key 密码。
- AI 助手：工具块/记忆块解析健壮化（平衡括号扫描）、支持一轮多工具、长期记忆近似去重、别名映射被禁用的 bug 修复。