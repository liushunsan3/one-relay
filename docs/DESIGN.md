# One-Relay 架构设计

> 面向维护者的技术设计文档。用户向导见 [README.md](../README.md) 与 [使用说明.md](../使用说明.md)。
> 本文与代码同步维护；核心机制改动时请同步更新对应小节。

## 1. 系统总览

```
                          ┌────────────────────────────────────────────┐
 客户端(ZCode/dsh/手机App)  │              router.js (Node 常驻)          │
        │                  │                                            │
        │ /v1/chat...      │  ┌──────────┐   ┌──────────────────────┐   │
        ├─────────────────▶│  │ 鉴权 sk-* │──▶│ 路由: 找候选→评分排序  │   │
        │                  │  └──────────┘   └──────────┬───────────┘   │
        │                  │        ┌───────────────────┴───────────┐   │
        │◀─── 流式/非流式 ──│        │ 逐站尝试 → 失败判定 → 换下一个   │   │
        │                  │        └───────────────────┬───────────┘   │
 管理面板(浏览器)           │  ┌──────────┐   ┌──────────▼───────────┐   │
        ├─ / 静态页        │  │ 用量统计   │   │ 上游站 ×N (OpenAI兼容)│   │
        └─ /admin/api/*   │  │ 探活/评分  │   └──────────────────────┘   │
                           │  │ 记忆库    │                              │
                           │  └──────────┘                              │
                           └───────▲────────────────────────────────────┘
                                   │ spawn/健康检查/心跳
                           ┌───────┴────────┐
                           │ supervisor.js   │ 指数退避重启·僵死强杀·托盘
                           └────────────────┘
```

- **零依赖**：纯 Node 内置模块 + 原生前端三件套，无 npm install、无数据库。
- **配置即数据**：所有站点配置在 `providers.json`，开关在 `settings.json`，均热加载（watchFile + 2s 防抖）。
- **单实例**：同一端口只允许一个 supervisor（启动探测端口占用）。

## 2. 请求生命周期

1. **鉴权**：`Authorization: Bearer <settings.apiKey>`，不匹配返回 401。
2. **路径归一**：`/v1/messages`、`/v1/input_messages`（Anthropic 风格）统一转 `/v1/chat/completions`。
3. **找候选**（`findProviders`）：所有「models 含该模型名」或「aliases 别名映射到它」的**启用**站入围。
4. **排序**（`sortCandidates`）：
   - 智能路由开（`settings.smartRouting`）：按 `providerScores` 实时评分降序，同分按 settings.priority 固定顺序。
   - 智能路由关：纯固定优先级。
5. **逐站尝试**：清洗请求体（`sanitizeBody`）→ 发请求 → 按结果走 §4 的判定。全败时返回最后一次的错误。

## 3. 站点评分（智能路由核心）

`computeProviderScore`，每次请求/探活后实时重算：

```
总分 = 探活分(40) + 成功率分(40) + 延迟分(20)    → 再乘惩罚系数
       │              │               │
       │              │               └─ 当日平均耗时: max(0,(2000-ms)/2000)*20
       │              └─ 当日成功率*40；样本<5 按 70% 乐观估计(防饿死)
       └─ 最近一次探活 GET /models 通过 +40
```

| 惩罚 | 条件 | 目的 |
|---|---|---|
| ×0.3 | 探活失败（结果 45 分钟内才采信） | 刚挂的站不被历史高分误选；过期失败快照不持续压分 |
| 压到 ≤1 | 5xx 熔断冷却中（§5.2） | 假活站自动垫底 |
| −1 | 停用/被踢/限流停用 | 彻底出局 |

## 4. 故障转移矩阵

`shouldFailover(statusCode, body)` 决定「换下一个站」还是「原样返回」：

| 输入 | 动作 |
|---|---|
| 400/401/402/403/404/424/429 | 换站 |
| **任何 5xx（含裸 502/503）** | 换站（2026-08 修复：不再要求 body 带关键词） |
| body 含 quota/余额/限流/no available channel/model not found 等关键词 | 换站（任意状态码） |
| 200 但 choices 空/非法（`isValidCompletion`） | 换站 |
| 其余 | 原样返回 |

换站同时按 §5 记账：`markProviderFailed`（隔离计数）、5xx 加熔断计数、429 加限流计数、模型级错误另计 `markModelFailed`（10 分钟内 2 连败将该模型从可用列表临时摘除）。

## 5. 三层健康防护 + 断网保护

| 层 | 触发 | 动作 | 恢复 |
|---|---|---|---|
| 5.1 探活 | 每 `probeIntervalMin`(默认30) 分钟 GET 各站 /models | 展示 + 评分输入；**真实请求成功会即时把探活快照纠偏为通** | — |
| 5.2 5xx 熔断 | 连续 3 次 5xx/网络错误（`markProvider5xx`） | 冷却 3 分钟，评分垫底 | 冷却到期自动；成功即清零 |
| 5.3 autoKick | 探活连续 3 次失败 + 当轮复验仍失败 | 写盘 `enabled:false, disabledBy:'auto'` + 托盘通知 | 面板手动启用 |
| 5.4 断网保护 | 一轮批量探活中 ≥80% 站同时失败（≥3 站） | 判定本机网络故障：**全员不计连败、不踢**，仅通知 | 下一轮自动 |
| 5.5 429 限流 | 连续 5 次 429 → 提醒（10 分钟冷却）；当天累计 2 次提醒 | 提醒 1 次纯通知；2 次 → `disabledBy:'quota'` 停用 | **每晚 0 点**及启动时自动恢复（按 `quotaSuspendedAt` 日期判断，当天重启不误恢复） |

> 设计原则：**单站死**才动 5.2/5.3；**本机网络故障**（5.4）绝不误杀好站——断网 ≥90 分钟会把所有站探活 3 连败+复验全失败，没有 5.4 就会全军覆没。

## 6. 流式处理（SSE）

- 上游返回 `text/event-stream` 时直接 `pipe` 透传给客户端，不缓冲。
- **usage 统计**：只在流结束时解析尾部 16KB 的 `usage` 字段（opus 等长流 chunk 海量，逐块全量扫描会拖垮主线程 → 曾致健康检查超时误判僵死）。
- 客户端断开 → 销毁上游连接（防连接泄漏挤爆 keep-alive 池）。
- 流式时长 = 完整流时长（end/close 都记，只记一次）。

## 7. AI 助手架构

```
用户输入 ──▶ 前端 key 占位符保护(sk-→{{KEY_n}})
        ──▶ POST /admin/api/assistant (后端纯转发到独立助手API, 流式)
        ──▶ 前端解析回复: scanJsonObjects(平衡括号提取JSON)
             ├─ {"memory":{"remember":...}} → 存偏好(每轮最多1条)
             ├─ {"tool":...}                → 工具循环执行(toolDepth≤6), 结果以
             │   check/status/probe/test/stats/logs/priority/toggle  [系统工具结果]回传续聊
             └─ ```json 操作数组```          → 提案卡(add/update/delete)
                                             ├─ baseUrl 防编造: 必须出现在用户消息或与现有站一致
                                             └─ 用户点「应用」→ POST /admin/api/apply
```

- **记忆巩固（海马体）**：每满 6 轮真实用户发言自动调 `callAssistantNonStream` 总结 → diary + longterm（近似去重：互为子串取长者）。
- 安全底线：真实 key 永不进入对话（占位符在 apply 时由前端 keyMap 回填）；日志不落 key 明文。

## 8. 看护与自启链路

```
开机 → Startup\路由代理自启.vbs → start-hidden.vbs
       (node 查找: 项目内嵌→%USERPROFILE%\nodejs→Program Files→PATH)
     → supervisor.js
        ├─ spawn router.js（崩溃重启: 退避1s/5s/15s/60s；连续5次启动失败停机等手动）
        ├─ 每30s 健康检查 GET /v1/models（连续4次失败→僵死强杀重启）
        ├─ 每5s 写心跳文件（router/托盘心跳超时自杀，防僵尸占端口）
        └─ tray.ps1 托盘（通知气泡/打开面板/重启/退出；被杀自动重拉）
```

平滑重启 = 杀 supervisor 树 → wscript 重拉（等价重新部署）；`平滑重启.bat` 为手动入口。

## 9. 安全模型

| 面 | 措施 |
|---|---|
| 监听 | 默认仅 `127.0.0.1`；`settings.bindLan` 开关切 `0.0.0.0`（运行时 server.close+listen 串行热切换，含并发竞态防护与 listen error 兜底） |
| 管理 API | `adminAllowed`：Host 必须 127.0.0.1/localhost + Origin/Referer 校验（防 DNS rebinding / 跨站）——**局域网开启后管理面板仍仅本机可达** |
| key 存储 | providers.json / settings.json 均 gitignore；git 历史从未含 key；API 响应一律 `maskKey`（首3+***+尾4） |
| 助手对话 | key 占位符保护，真实 key 不出境 |
| 日志 | 永不输出 key 明文（代码规范） |

## 10. 数据文件

| 文件 | 内容 | 寿命 |
|---|---|---|
| providers.json | 站点配置（写时校验 + 3 份 .bak 轮换 + 原子写） | 永久 |
| settings.json | apiKey/priority/assistant/probeIntervalMin/autoKick/smartRouting/bindLan | 永久 |
| stats.json | 按天分桶用量（byProvider/byModel/client）+ 最近 200 条请求历史 | 60 天 |
| memory.json | changelog/stash/preferences/diary/longterm（损坏自动隔离重建） | 分区限长 |
| logs/router-*.log | supervisor 落盘日志 | 7 天 |
| run-state/heartbeat/tray-cmd-*.json | 进程间协作状态 | 运行时 |

## 11. 测试与发布

- `node tests/run-tests.js`：76 项断言。策略是从源码提取纯函数 + mock 注入（router.js 是常驻服务不能 require），被测函数改名/删除会直接报 not found 防漂移。
- `.git/hooks/pre-commit`：三文件语法检查 + 跑测试，不通过阻止提交。
- GitHub 同步：`push` 域被墙，走 Git Data API 原子提交（`node sync-github.cjs "msg"`，本地工具不入库）。
- 发布包：`make-release.bat`（白名单复制，绝不带 key 与个人数据）。
