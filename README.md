# One-Relay · 个人 AI 网关

**聚合多个 OpenAI 兼容中转站为一个本地端点：双击就跑、AI 助手帮你配置、废站自动踢出局、永远走最快的站。**

[中文](#中文说明) | [English](#english)

---

## 中文说明

### ✨ 特性

- **零依赖单目录**：纯 Node.js 内置模块 + 原生前端，无 npm install、无数据库、无 Docker，装了 Node.js 双击就能跑
- **🤖 AI 助手帮你配置**：把中转站的地址和 key 贴进对话框，AI 自动查出该站支持的模型、生成配置提案，你确认即生效——不用手写 JSON，不用记模型名
- **🥊 废站自动踢**：探活连续失败 + 复验确认真死 → 自动踢出局（不再探测），通知你受影响的模型；手动启用可随时救回
- **⚡ 智能路由**：按实时评分（当日真实延迟 + 成功率 + 探活状态）自动选最快的站；某站慢了自动让位，无需手动调优先级；一键开关回退固定优先级
- **🔄 自动故障转移**：401/402/403/404/424/429/限流/空响应自动换下一个站
- **🛡️ 崩溃自愈**：看护进程自动重启（指数退避）、僵死检测、心跳防僵尸、配置原子写防损坏
- **🖥️ 网页控制台**（全中文）：总览/评分/用量统计（按天分桶）/实时日志/推荐模型实测，深浅色主题，支持流式中断、模型搜索
- **🔒 本地安全**：仅监听 127.0.0.1，Host/Origin 校验，接口不回显完整 key，AI 对话中 key 自动占位符保护

### 🚀 快速开始

1. 安装 [Node.js](https://nodejs.org)（任意现代版本）
2. 双击 `启动路由代理.bat`（或 `start-hidden.vbs`）
3. 右下角托盘出现图标，双击打开控制台 http://127.0.0.1:3099/
4. 按控制台首页的三步引导：配 AI 助手 → 贴第一个站 → 开始用

客户端接入：`Base URL = http://127.0.0.1:3099/v1`，`API Key = sk-router`

### 🤖 AI 助手能做什么

贴资源自动配置（"新站 https://xxx key sk-xxx"）、查状态、探活、单站测试、用量统计、查日志、稳定性测试、调整优先级、启停站点——一句话的事。助手使用独立 API（不占用聚合池），key 全程占位符保护不出境。

### 📁 目录结构

```
router.js            路由核心（故障转移/评分/自动踢/管理API）
supervisor.js        看护进程（自动重启/僵死检测/心跳）
tray.ps1             系统托盘（PowerShell NotifyIcon）
public/              网页控制台（原生三件套）
providers.json       站点配置（首次运行自动生成，热加载）
settings.json        开关与助手配置（autoKick/smartRouting 等）
启动路由代理.bat / 平滑重启.bat / 设为开机自启.bat
```

### 📄 License

[MIT](LICENSE)

---

## English

### A personal AI gateway that aggregates multiple OpenAI-compatible endpoints into one local relay.

**Highlights**

- **Zero-dependency, single folder** — pure Node.js built-ins + vanilla frontend. No npm install, no database, no Docker. If Node.js is installed, just double-click.
- **🤖 AI-powered configuration** — paste an endpoint URL + key into the chat; the built-in assistant auto-discovers available models and generates the config proposal for you to confirm. No JSON editing, no memorizing model IDs.
- **🥊 Auto-kick dead endpoints** — 3 consecutive probe failures + re-verification → kicked out (no longer probed), with a notification listing affected models. Manual re-enable anytime.
- **⚡ Smart routing** — picks the best-scoring endpoint (today's real latency + success rate + probe status) for every request. Slow endpoints step aside automatically. One-click fallback to fixed priority.
- **🔄 Auto failover** across 401/402/403/404/424/429/rate-limit/empty responses.
- **🛡️ Self-healing** — supervisor with exponential-backoff restart, zombie detection, heartbeat, atomic config writes.
- **🖥️ Web console** — overview, per-endpoint scores, daily usage stats, live logs, stability-tested model recommendations; dark/light themes; stream interruption & model search.
- **🔒 Local-only security** — binds to 127.0.0.1, Host/Origin validation, masked keys in every API response, placeholder protection for keys in AI chats.

### Quick Start

1. Install [Node.js](https://nodejs.org)
2. Double-click `start-hidden.vbs` (or `启动路由代理.bat`)
3. Tray icon appears — double-click it to open the console at http://127.0.0.1:3099/
4. Follow the 3-step onboarding guide.

Client setup: `Base URL = http://127.0.0.1:3099/v1`, `API Key = sk-router`

### License

[MIT](LICENSE)
