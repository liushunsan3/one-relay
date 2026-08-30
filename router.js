/**
 * OpenAI 兼容路由代理（故障转移 + 流式 + Web 管理面板）
 * 由 supervisor.js 看护启动；也可单独 node router.js 调试（此时不做心跳自杀）
 * 业务核心：多 provider 路由、别名映射、速度优先级、自动故障转移、SSE 透传
 * 管理面板：/ 与 /admin/api/*（仅本机，Host/Origin 校验）
 * 注意规范：所有日志禁止输出 key 明文
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const APP_DIR = __dirname;
const TAG = process.env.RP_PORT && process.env.RP_PORT !== '3099' ? process.env.RP_PORT : 'main';
const MY_PORT = parseInt(process.env.RP_PORT || '3099', 10);
const UPSTREAM_TIMEOUT = 600000;
const startedAt = Date.now();

// 全局未捕获异常处理：防止任何遗漏的 Promise rejection 导致进程退出（Node 15+ 默认行为）
process.on('unhandledRejection', (reason) => {
  console.log(`⚠️ 未捕获的 Promise rejection: ${reason instanceof Error ? reason.message : reason}`);
});
process.on('uncaughtException', (err) => {
  console.log(`⚠️ 未捕获的同步异常: ${err.message}`);
});

// ============ 日志环形缓冲（管理面板增量拉取） ============
const LOG_RING_MAX = 1000;
const logRing = [];
let logSeq = 0;
{
  const origLog = console.log;
  console.log = (...args) => {
    const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    origLog(...args);
    logRing.push({ c: ++logSeq, t: Date.now(), line });
    if (logRing.length > LOG_RING_MAX) logRing.shift();
  };
}

// ============ providers 配置 ============
const configPath = path.join(APP_DIR, 'providers.json');
// 首次运行：无配置则生成空模板，引导从面板/AI 助手添加（不崩溃）
if (!fs.existsSync(configPath)) {
  try { atomicWrite(configPath, JSON.stringify([], null, 2)); } catch (e) {}
  console.log('🆕 未检测到 providers.json，已生成空配置：请打开管理面板添加中转站（或直接把地址+key 贴给 AI 助手）');
}
const providerList = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

const PROVIDERS = {};
function loadProviders(list) {
  const map = {};
  for (const p of list) {
    map[p.name] = { baseUrl: p.baseUrl, key: p.key, models: p.models, aliases: p.aliases || {}, enabled: p.enabled !== false };
  }
  return map;
}
Object.assign(PROVIDERS, loadProviders(providerList));

// ============ settings 配置（热加载） ============
const settingsPath = path.join(APP_DIR, 'settings.json');
let settings = {
  apiKey: 'sk-router',
  priority: [],
  assistant: { baseUrl: '', key: '', model: '' },
  probeIntervalMin: 30,
  autoKick: true,       // 废站自动踢（探活3连败+复验确认）
  smartRouting: true,   // 动态选最快站（false 回退固定优先级）
  bindLan: false,       // 局域网访问开关（true 监听 0.0.0.0，同 WiFi 设备可访问；false 仅监听 127.0.0.1）
};
try {
  settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) };
} catch (e) {
  console.log(`settings.json 读取失败，使用默认配置: ${e.message}`);
}
// 首次运行：无 settings 则落盘默认值，方便用户直接编辑
if (!fs.existsSync(settingsPath)) {
  try { atomicWrite(settingsPath, JSON.stringify(settings, null, 2)); } catch (e) {}
  console.log('🆕 已生成默认 settings.json');
}
let settingsReloadTimer = null;
fs.watchFile(settingsPath, { interval: 1000 }, () => {
  clearTimeout(settingsReloadTimer);
  settingsReloadTimer = setTimeout(() => {
    try {
      const fresh = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      settings = { ...settings, ...fresh };
      scheduleProbe();
      applyBindLan(); // bindLan 开关变化 → 运行时切换监听地址
      broadcast('status'); // bindLan/apiKey/优先级等设置变化 → 面板实时刷新
      console.log(`\n⚙️ settings 已热加载: apiKey=*** 优先级=${(settings.priority || []).length} 项\n`);
    } catch (e) {
      console.log(`\n❌ settings 热加载失败（保留旧配置）: ${e.message}\n`);
    }
  }, 2000);
});

function configMtime() {
  try { return fs.statSync(configPath).mtimeMs; } catch (e) { return 0; }
}

// ============ 监听地址（bindLan 局域网访问开关） ============
let currentHost = settings.bindLan === true ? '0.0.0.0' : '127.0.0.1';
function desiredHost() { return settings.bindLan === true ? '0.0.0.0' : '127.0.0.1'; }
// 取局域网 IPv4：优先私有段（家用/办公 WiFi 的 192.168 / 10 / 172.16-31），
// 排除 2.0.0.1、169.254.x.x 这类虚拟网卡/隧道地址（否则同 WiFi 设备拿到错 IP 连不上）
function lanIPv4() {
  try {
    const ifs = os.networkInterfaces();
    const all = [];
    for (const name of Object.keys(ifs)) {
      for (const it of ifs[name] || []) {
        if (it.family === 'IPv4' && !it.internal) all.push(it.address);
      }
    }
    if (!all.length) return null;
    const priv192 = all.find(ip => ip.startsWith('192.168.'));
    if (priv192) return priv192;
    const priv10 = all.find(ip => ip.startsWith('10.'));
    if (priv10) return priv10;
    const priv172 = all.find(ip => /^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip));
    if (priv172) return priv172;
    return all[0]; // 无私有段时回退（纯隧道/云环境）
  } catch (e) {}
  return null;
}
function accessBaseUrl() {
  const host = currentHost === '0.0.0.0' ? (lanIPv4() || '127.0.0.1') : '127.0.0.1';
  return `http://${host}:${MY_PORT}`;
}
let server = null; // http.Server 实例（createServer 处赋值，供 applyBindLan 重绑监听）
let rebinding = false; // 切换进行中标志：串行化 close→listen，防止并发 listen 触发 ERR_SERVER_ALREADY_LISTEN
let pendingHost = null; // 切换期间积累的最新目标，当前切换完成后继续串行处理
function applyBindLan() {
  if (!server) return; // 尚未创建/监听
  const want = desiredHost();
  if (want === currentHost) { if (!rebinding) pendingHost = null; return; }
  if (rebinding) { pendingHost = want; return; }
  doRebind(want);
}
function doRebind(want) {
  rebinding = true;
  const from = currentHost === '0.0.0.0' ? '局域网可访问' : '仅本机';
  currentHost = want;
  console.log(`\n🌐 监听地址切换: ${from} → ${want === '0.0.0.0' ? '局域网可访问' : '仅本机'} (${want}:${MY_PORT})\n`);
  const handleError = (err) => {
    server.removeListener('error', handleError);
    rebinding = false;
    pendingHost = null;
    console.log(`  ⚠️ 重绑监听失败: ${err && (err.code || err.message)}（服务可能停摆，请重启恢复）`);
  };
  server.close(() => {
    server.on('error', handleError);   // listen 失败兜底（EADDRINUSE 等）
    server.listen(MY_PORT, currentHost, () => {
      server.removeListener('error', handleError);
      rebinding = false;
      console.log(`✅ 已重新监听 ${currentHost}:${MY_PORT}`);
      if (pendingHost && pendingHost !== currentHost) {   // 切换期间又积累了新目标 → 继续串行切换
        const next = pendingHost;
        pendingHost = null;
        doRebind(next);
      }
    });
  });
  // 停止接受新连接后尽快释放旧连接，使 close 回调及时触发（切换瞬间中断进行中的流式请求可接受）
  if (typeof server.closeAllConnections === 'function') setTimeout(() => { try { server.closeAllConnections(); } catch (e) {} }, 200);
  else if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
}

// ============ providers 热加载 ============
let reloadTimer = null;
fs.watchFile(configPath, { interval: 1000 }, () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    try {
      const fresh = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (!Array.isArray(fresh) || fresh.length === 0) throw new Error('配置为空或格式不对');
      const next = loadProviders(fresh);
      for (const k of Object.keys(PROVIDERS)) delete PROVIDERS[k];
      Object.assign(PROVIDERS, next);
      providerList.length = 0;
      providerList.push(...fresh);
      // 清理已删站的探活/健康状态（防幽灵行）；统计聚合保留（历史事实）
      const names = new Set(fresh.map(p => p.name));
      for (const n of Object.keys(providerHealth)) if (!names.has(n)) delete providerHealth[n];
      for (const n of Object.keys(probeState)) if (!names.has(n)) delete probeState[n];
      for (const n of Object.keys(PROVIDERS)) computeProviderScore(n); // 配置变化后评分全量重算
      const allModels = [...new Set(Object.values(PROVIDERS).flatMap(p => [...p.models, ...Object.keys(p.aliases)]))];
      broadcast('providers'); broadcast('status'); // 站点增删/启停/kick 等配置变更 → 面板实时刷新
      broadcast('memory'); // changelog 可能新增
      console.log(`\n🔄 配置已热加载: ${fresh.length} 个 provider, ${allModels.length} 个模型\n`);
    } catch (e) {
      console.log(`\n❌ 热加载失败（保留旧配置）: ${e.message}\n`);
    }
  }, 2000);
});

// ============ 故障转移状态 ============
const providerHealth = {};
const MAX_FAILURES = 3;
const HEALTH_CHECK_INTERVAL = 5 * 60 * 1000;

// ============ 模型级健康（供 /v1/models 按实际可用性过滤） ============
const modelHealth = {};
const MODEL_FAIL_THRESHOLD = 2;             // 连续失败 2 次即视为不可用
const MODEL_FAIL_WINDOW = 10 * 60 * 1000;   // 10 分钟内无失败则自动恢复

function markModelFailed(model) {
  if (!model) return;
  const h = modelHealth[model] || (modelHealth[model] = { fails: 0, lastFail: 0 });
  h.fails++;
  h.lastFail = Date.now();
}
function markModelSuccess(model) {
  if (model && modelHealth[model]) { modelHealth[model].fails = 0; modelHealth[model].lastFail = 0; }
}
function isModelUnavailable(model) {
  const h = modelHealth[model];
  if (!h) return false;
  if (Date.now() - h.lastFail > MODEL_FAIL_WINDOW) { h.fails = 0; h.lastFail = 0; return false; }
  return h.fails >= MODEL_FAIL_THRESHOLD;
}

function isProviderHealthy(providerName) {
  const health = providerHealth[providerName];
  if (!health) return true;
  if (Date.now() - health.lastFailTime > HEALTH_CHECK_INTERVAL) {
    health.failures = 0;
    return true;
  }
  return health.failures < MAX_FAILURES;
}

function markProviderFailed(providerName) {
  if (!providerHealth[providerName]) {
    providerHealth[providerName] = { failures: 0, lastFailTime: 0 };
  }
  providerHealth[providerName].failures++;
  providerHealth[providerName].lastFailTime = Date.now();
  console.log(`  ⚠️  ${providerName} 失败次数: ${providerHealth[providerName].failures}/${MAX_FAILURES}`);
}

function markProviderSuccess(providerName) {
  if (providerHealth[providerName]) {
    providerHealth[providerName].failures = 0;
  }
  provider5xx[providerName] = { streak: 0, until: 0 };
  if (provider429[providerName]) provider429[providerName].streak = 0; // 成功一次即清零 429 连击
  // 真实业务成功是最强的健康证明：即时纠偏探活快照为「通」，
  // 防止断网期间的陈旧失败快照长时间把评分压在 ×0.3（最长要等半个探活周期才纠正）
  const pr = probeState[providerName];
  if (pr && pr.ok !== true && !pr.busy) {
    probeState[providerName] = { ...pr, ok: true, err: '', time: Date.now() };
    computeProviderScore(providerName);
  }
}

// ============ 429 限流提醒 + 自动停用/午夜恢复 ============
// 提醒：连续 5 次 429 弹一次通知（10 分钟冷却防刷屏）。
// 停用：当天累计提醒 2 次 → 自动停用该站（额度已用尽，不再白白重试）。
// 恢复：每晚 0 点自动恢复被限流停用的站，并重置当天提醒计数。
const provider429 = {};                    // name -> { streak, lastNotify, notifyCount }
const R429_STREAK_THRESHOLD = 5;           // 连续 5 次 429 触发提醒
const R429_NOTIFY_COOLDOWN = 10 * 60 * 1000; // 同一站 10 分钟内最多提醒一次（防刷屏）
const R429_SUSPEND_AFTER = 2;              // 当天累计提醒达 2 次 → 停用
function markProvider429(providerName) {
  const s = provider429[providerName] || (provider429[providerName] = { streak: 0, lastNotify: 0, notifyCount: 0 });
  s.streak++;
  if (s.streak >= R429_STREAK_THRESHOLD && Date.now() - s.lastNotify > R429_NOTIFY_COOLDOWN) {
    s.lastNotify = Date.now();
    s.notifyCount++;
    const msg = `站点 ${providerName} 连续限流（429），提醒 ${s.notifyCount}/${R429_SUSPEND_AFTER} 次，可能已达免费额度上限`;
    console.log(`  ⏳ ${msg}`);
    sendNotify(msg);
    addChangelog('自动', msg);
    if (s.notifyCount >= R429_SUSPEND_AFTER) suspendProviderForQuota(providerName);
  }
}

// 停用限流站：enabled=false + disabledBy:'quota'（与 auto踢/手动停用区分），记录停用日期供午夜恢复判断
async function suspendProviderForQuota(name) {
  try {
    const list = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const item = list.find(x => x.name === name);
    if (!item || item.enabled === false) return; // 已停用则不重复处理
    item.enabled = false;
    item.disabledBy = 'quota';
    item.quotaSuspendedAt = todayKey();
    if (PROVIDERS[name]) PROVIDERS[name].enabled = false; // 同步内存（不等热加载）
    const err = writeProviders(list);
    if (err) { console.log(`限流停用 ${name} 写入失败: ${err}`); return; }
    computeProviderScore(name);
    addChangelog('自动', `限流提醒达 ${R429_SUSPEND_AFTER} 次，停用 ${name}（今晚 0 点自动恢复）`);
    sendNotify(`站点 ${name} 因连续限流已暂时停用，今晚 0 点后自动恢复`);
    console.log(`  ⏸️ 已限流停用: ${name}（今晚 0 点恢复）`);
  } catch (e) { console.log(`限流停用 ${name} 出错: ${e.message}`); }
}

// 午夜/启动时恢复：只恢复「停用日期早于今天」的限额站（避免同一天内重启误恢复当天刚停的站）
function restoreQuotaSuspended() {
  try {
    const today = todayKey();
    const list = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const restored = [];
    for (const item of list) {
      if (item.disabledBy === 'quota' && item.enabled === false && item.quotaSuspendedAt && item.quotaSuspendedAt !== today) {
        item.enabled = true;
        delete item.disabledBy;
        delete item.quotaSuspendedAt;
        if (PROVIDERS[item.name]) PROVIDERS[item.name].enabled = true;
        restored.push(item.name);
      }
    }
    if (restored.length) {
      writeProviders(list);
      for (const n of restored) computeProviderScore(n);
      addChangelog('自动', `已过 0 点，恢复限流停用的站点：${restored.join('、')}`);
      sendNotify(`🌙 已恢复限流停用的站点：${restored.join('、')}`);
      console.log(`  🌙 已恢复限流停用站点: ${restored.join('、')}`);
    }
    // 重置当天 429 提醒计数（新的一天重新累计）
    for (const k of Object.keys(provider429)) provider429[k] = { streak: 0, lastNotify: 0, notifyCount: 0 };
  } catch (e) { console.log(`恢复限流站出错: ${e.message}`); }
}

// 安排下次午夜触发（本地时区次日 0 点 + 1 秒保险）
function scheduleMidnightReset() {
  const now = new Date();
  const mid = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
  const ms = mid.getTime() - now.getTime();
  setTimeout(() => { restoreQuotaSuspended(); scheduleMidnightReset(); }, ms).unref();
}

// ============ 5xx 熔断（抗「假活站」：探活 GET /models 通、但 POST 请求全 5xx） ============
// 探活基于 /models（GET），抓不到只有对话请求才 503 的站；这里对连续 5xx 的站临时冷却，
// 冷却期内评分打到极低（在候选排序里自动垫底），避免每次请求都再撞一次死站。
const provider5xx = {};                 // name -> { streak, until }
const SXX_STREAK_THRESHOLD = 3;         // 连续 3 次 5xx 触发冷却
const SXX_COOLDOWN_MS = 3 * 60 * 1000;  // 冷却 3 分钟
function markProvider5xx(providerName) {
  const s = provider5xx[providerName] || (provider5xx[providerName] = { streak: 0, until: 0 });
  s.streak++;
  if (s.streak >= SXX_STREAK_THRESHOLD) {
    s.until = Date.now() + SXX_COOLDOWN_MS;
    console.log(`  🧯 ${providerName} 连续 ${s.streak} 次 5xx，冷却 ${SXX_COOLDOWN_MS / 60000} 分钟`);
  }
  computeProviderScore(providerName);
}
function is5xxCooling(providerName) {
  const s = provider5xx[providerName];
  return !!(s && s.until && Date.now() < s.until);
}

// ============ 原子写与托盘通知 ============
function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}
const TRAY_CMD_FILE = path.join(APP_DIR, `tray-cmd-${TAG}.txt`);
function sendNotify(msg) {
  try { fs.appendFileSync(TRAY_CMD_FILE, `notify:${msg}\n`); } catch (e) {}
}
// 清理上次异常退出的 .tmp 残留
try {
  for (const f of fs.readdirSync(APP_DIR)) {
    if (f.endsWith('.tmp')) { try { fs.unlinkSync(path.join(APP_DIR, f)); } catch (e) {} }
  }
} catch (e) {}

function shouldFailover(statusCode, body) {
  if (statusCode === 400 || statusCode === 401 || statusCode === 402 || statusCode === 403 || statusCode === 424 || statusCode === 429) return true;
  if (statusCode === 404) return true;
  // 5xx 一律换站：上游服务端错误（502/503/500 等）不管 body 有没有关键词都该转移，
  // 否则像干巴巴 503 这种会被当作「不可转移」原样返回，导致死磕同一个挂掉的站
  if (statusCode >= 500) return true;
  const text = (body || '').toLowerCase();
  const keywords = ['quota', 'insufficient', 'balance', 'payment required', 'rate limit',
    'over quota', '额度', '余额', '付款', '超出', '限流', 'no available channel',
    'service temporarily unavailable', 'unavailable', 'model not found', 'model_not_found'];
  return keywords.some(kw => text.includes(kw));
}

// 模型级错误（站还活着、但该模型本身不可用）：用于动态从可用模型列表剔除
function isModelLevelError(statusCode, body, validCompletion) {
  if (statusCode === 424 || statusCode === 404) return true;
  if (statusCode >= 200 && statusCode < 300 && !validCompletion) return true; // 200 但空响应
  const text = (body || '').toLowerCase();
  return text.includes('model not found') || text.includes('model_not_found') || text.includes('service temporarily unavailable');
}

// ============ 请求体清洗 ============
function sanitizeBody(parsed, realModel) {
  const out = { model: realModel };

  let messages = Array.isArray(parsed.messages) ? parsed.messages.map(fixMessage) : [];
  if (parsed.system !== undefined) {
    let sysText = '';
    if (typeof parsed.system === 'string') sysText = parsed.system;
    else if (Array.isArray(parsed.system)) {
      sysText = parsed.system.map(b => (typeof b === 'string' ? b : (b && b.text) || '')).join('\n\n');
    }
    if (sysText) messages = [{ role: 'system', content: sysText }, ...messages];
  }
  out.messages = messages;

  if (typeof parsed.stream === 'boolean') out.stream = parsed.stream;
  // 请求流式 usage（token 统计依赖：OpenAI 标准，不兼容的站会忽略该字段）
  if (out.stream === true) out.stream_options = { include_usage: true };
  if (parsed.temperature !== undefined) out.temperature = parsed.temperature;
  if (parsed.top_p !== undefined) out.top_p = parsed.top_p;
  if (typeof parsed.stop === 'string' || Array.isArray(parsed.stop)) out.stop = parsed.stop;
  if (parsed.presence_penalty !== undefined) out.presence_penalty = parsed.presence_penalty;
  if (parsed.frequency_penalty !== undefined) out.frequency_penalty = parsed.frequency_penalty;
  if (parsed.max_tokens !== undefined) out.max_tokens = Math.min(Number(parsed.max_tokens) || 8192, 32768);
  if (Array.isArray(parsed.tools) && parsed.tools.length > 0) out.tools = parsed.tools.map(fixTool);
  if (parsed.tool_choice !== undefined) out.tool_choice = parsed.tool_choice;
  if (parsed.response_format !== undefined) out.response_format = parsed.response_format;
  if (Array.isArray(parsed.stop_sequences) && out.stop === undefined) out.stop = parsed.stop_sequences;

  return out;
}

function fixMessage(msg) {
  if (!msg || typeof msg !== 'object') return { role: 'user', content: String(msg) };
  const fixed = { ...msg };
  if (Array.isArray(fixed.content)) {
    const parts = fixed.content.map(b => {
      if (typeof b === 'string') return b;
      if (b && b.type === 'text' && typeof b.text === 'string') return b.text;
      return '';
    }).filter(s => s.length > 0);
    if (parts.length > 0 && fixed.content.every(b => typeof b === 'string' || (b && b.type === 'text'))) {
      fixed.content = parts.join('\n');
    }
  }
  if (typeof fixed.content !== 'string' && !Array.isArray(fixed.content)) {
    fixed.content = JSON.stringify(fixed.content);
  }
  return fixed;
}

function fixTool(tool) {
  if (!tool || typeof tool !== 'object') return tool;
  if (tool.input_schema && !tool.function) {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema,
      }
    };
  }
  return tool;
}

// ============ 路由逻辑 ============
function findProviders(modelName) {
  const name = (modelName || '').toLowerCase();
  const matches = [];
  for (const [providerName, p] of Object.entries(PROVIDERS)) {
    if (p.enabled === false) continue; // 手动禁用的站跳过
    const alias = Object.entries(p.aliases).find(([k]) => k.toLowerCase() === name);
    if (alias) {
      matches.push({ provider: providerName, config: p, realModel: alias[1] });
      continue;
    }
    if (p.models.some(m => m.toLowerCase() === name)) {
      matches.push({ provider: providerName, config: p, realModel: name });
    }
  }
  return matches;
}

function sortCandidates(matches) {
  const pr = settings.priority || [];
  // 智能路由：按评分降序选当前最快可用站（同分用固定优先级 tiebreaker）
  if (settings.smartRouting !== false) {
    return [...matches].sort((a, b) => {
      const sa = (providerScores[a.provider] || {}).score ?? -1;
      const sb = (providerScores[b.provider] || {}).score ?? -1;
      if (sb !== sa) return sb - sa;
      const pa = pr.indexOf(a.provider);
      const pb = pr.indexOf(b.provider);
      return (pa === -1 ? 999 : pa) - (pb === -1 ? 999 : pb);
    });
  }
  // 固定优先级（传统模式，settings.smartRouting=false 时回退）
  return [...matches].sort((a, b) => {
    const pa = pr.indexOf(a.provider);
    const pb = pr.indexOf(b.provider);
    return (pa === -1 ? 999 : pa) - (pb === -1 ? 999 : pb);
  });
}

// ============ 站点评分（智能路由依据；评分错不影响主流程） ============
const providerScores = {}; // name -> { score, detail, ms }
function computeProviderScore(name) {
  try {
    const p = PROVIDERS[name];
    if (!p || p.enabled === false) { providerScores[name] = { score: -1, detail: '停用/踢出' }; return; }
    const probe = probeState[name];
    const probedOk = probe && probe.ok;
    let score = 0;
    const detail = [];
    // ① 探活基础分 40
    if (probedOk) { score += 40; detail.push('探活+40'); }
    // ② 成功率 40：当日分桶，样本≥5 用真实值；不足按乐观 70%（防新站/凌晨饿死；恰好样本全败用真实值）
    const b = stats[todayKey()];
    const cell = b && b.byProvider[name];
    let rate = 0.7;
    if (cell && cell.reqs >= 5) rate = cell.ok / cell.reqs;
    score += rate * 40;
    detail.push(`成功率${Math.round(rate * 100)}%+${Math.round(rate * 40)}`);
    // ③ 延迟分 20：当日有真实请求用请求平均延迟（比探活延迟准），否则探活延迟
    let lat = null;
    if (cell && cell.reqs > 0) lat = cell.ms / cell.reqs;
    else if (probedOk) lat = probe.ms;
    if (lat != null) {
      const d = Math.max(0, (2000 - lat) / 2000) * 20;
      score += d;
      detail.push(`延迟${Math.round(lat)}ms+${Math.round(d)}`);
    }
    // ④ 探活不通：总分 ×0.3 封顶（刚挂的站不被历史高分误选）。
    //    但结果超过 45 分钟（1.5 个探活周期）视为过期数据不采信——断网期间的陈旧失败不该一直压分
    if (probe && !probe.busy && !probe.ok && Date.now() - (probe.time || 0) < 45 * 60 * 1000) { score *= 0.3; detail.push('探活挂×0.3'); }
    // ⑤ 5xx 冷却中：探活可能仍绿（GET /models 通），但对话请求全 5xx，直接压到极低分垫底
    if (is5xxCooling(name)) { score = Math.min(score, 1); detail.push('5xx冷却'); }
    providerScores[name] = { score: Math.round(score), detail: detail.join(' '), ms: lat == null ? null : Math.round(lat) };
  } catch (e) {
    providerScores[name] = { score: 0, detail: '评分出错' };
  }
}

// ============ 发送请求（支持流式透传） ============
function sendRequest(options, body) {
  return new Promise((resolve, reject) => {
    const transport = options.protocol === 'https:' ? https : http;
    const req = transport.request(options, (proxyRes) => {
      const contentType = proxyRes.headers['content-type'] || '';
      if (proxyRes.statusCode === 200 && contentType.includes('text/event-stream')) {
        resolve({ statusCode: proxyRes.statusCode, headers: proxyRes.headers, stream: proxyRes });
        return;
      }
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        resolve({ statusCode: proxyRes.statusCode, headers: proxyRes.headers, body: data });
      });
    });

    req.setTimeout(UPSTREAM_TIMEOUT, () => {
      req.destroy(new Error('upstream timeout'));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function isValidCompletion(body) {
  if (!body) return false;
  if (body.includes('"choices":null') || body.includes('"choices":[]')) return false;
  return true;
}

function buildOptions(cand, upstreamPath, targetBody) {
  const baseClean = cand.config.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  const pathClean = upstreamPath.startsWith('/v1/') ? upstreamPath : upstreamPath.replace(/^\//, '');
  const targetUrl = new URL(baseClean + pathClean);
  return {
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cand.config.key}`,
      'Content-Length': Buffer.byteLength(targetBody),
    },
    protocol: targetUrl.protocol,
    agent: targetUrl.protocol === 'https:' ? httpsAgent : httpAgent,
  };
}

const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 10 });

// ============ 用量统计（按天分桶）+ 请求历史 ============
const statsPath = path.join(APP_DIR, 'stats.json');
let stats = {};      // { 'YYYY-MM-DD': { byProvider:{}, byModel:{}, clientReqs, clientOk } }
let reqHistory = []; // 最近 200 条上游尝试
try {
  const saved = JSON.parse(fs.readFileSync(statsPath, 'utf-8'));
  stats = saved.stats || {};
  reqHistory = saved.history || [];
  // 历史数据归一：旧版本 byModel 分桶大小写不敏感缺失，同一模型出现过大小写不同的双行，合并到小写 key
  for (const day of Object.values(stats)) {
    if (!day || !day.byModel) continue;
    for (const k of Object.keys(day.byModel)) {
      const lk = k.toLowerCase();
      if (k === lk) continue;
      const target = day.byModel[lk] || (day.byModel[lk] = day.byModel[k]);
      const s = day.byModel[k];
      if (target !== s) {
        target.reqs += s.reqs; target.ok += s.ok; target.fail += s.fail; target.ms += s.ms;
        target.tin += s.tin; target.tout += s.tout; target.cached += s.cached;
      }
      delete day.byModel[k];
    }
  }
} catch (e) { /* 首次运行 */ }

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function todayBucket() {
  const k = todayKey();
  if (!stats[k]) stats[k] = { byProvider: {}, byModel: {}, clientReqs: 0, clientOk: 0 };
  return stats[k];
}
function ensureCell(map, name) {
  if (!map[name]) map[name] = { reqs: 0, ok: 0, fail: 0, ms: 0, tin: 0, tout: 0, cached: 0 };
  return map[name];
}
// 从 usage 提取缓存命中 token（OpenAI 标准字段，部分站不返回）
function cachedTokens(usage) {
  try {
    return (usage && usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || 0;
  } catch (e) { return 0; }
}
function recordAttempt(model, provider, ms, code, ok, stream, usage) {
  const b = todayBucket();
  const p = ensureCell(b.byProvider, provider);
  p.reqs++; ok ? p.ok++ : p.fail++; p.ms += ms;
  if (usage) { p.tin += usage.prompt_tokens || 0; p.tout += usage.completion_tokens || 0; p.cached += cachedTokens(usage); }
  const m = ensureCell(b.byModel, String(model || 'unknown').toLowerCase()); // 小写归一，避免大小写不同拆成两个桶
  m.reqs++; ok ? m.ok++ : m.fail++; m.ms += ms;
  if (usage) { m.tin += usage.prompt_tokens || 0; m.tout += usage.completion_tokens || 0; m.cached += cachedTokens(usage); }
  reqHistory.push({ t: Date.now(), model, provider, ms: Math.round(ms), code, ok, stream: !!stream });
  if (reqHistory.length > 200) reqHistory.splice(0, reqHistory.length - 200);
  computeProviderScore(provider); // 评分随请求实时更新
  scheduleStatsSave();
  broadcast('status'); broadcast('providers'); broadcast('stats'); // 面板实时刷新：评分/请求历史/用量统计
}
function recordClientResult(ok) {
  const b = todayBucket();
  b.clientReqs++;
  if (ok) b.clientOk++;
  scheduleStatsSave();
}
function recordStreamTokens(provider, model, usage) {
  if (!usage) return;
  const b = todayBucket();
  const p = ensureCell(b.byProvider, provider);
  p.tin += usage.prompt_tokens || 0; p.tout += usage.completion_tokens || 0; p.cached += cachedTokens(usage);
  const m = ensureCell(b.byModel, String(model || 'unknown').toLowerCase()); // 小写归一，与 recordAttempt 同桶
  m.tin += usage.prompt_tokens || 0; m.tout += usage.completion_tokens || 0; m.cached += cachedTokens(usage);
  scheduleStatsSave();
}
let statsTimer = null;
function scheduleStatsSave() {
  if (statsTimer) return;
  statsTimer = setTimeout(() => {
    statsTimer = null;
    try { fs.writeFileSync(statsPath, JSON.stringify({ stats, history: reqHistory })); } catch (e) {}
  }, 30000);
}
// 只保留最近 60 天分桶
setInterval(() => {
  const keys = Object.keys(stats).sort();
  while (keys.length > 60) delete stats[keys.shift()];
}, 3600 * 1000).unref();

function summarizeStats(range) {
  const keys = Object.keys(stats).sort().reverse();
  const use = range === 'today' ? keys.slice(0, 1) : range === 'week' ? keys.slice(0, 7) : keys;
  const byProvider = {}, byModel = {};
  let clientReqs = 0, clientOk = 0;
  for (const k of use) {
    const b = stats[k];
    if (!b) continue;
    clientReqs += b.clientReqs || 0;
    clientOk += b.clientOk || 0;
    for (const [n, c] of Object.entries(b.byProvider || {})) {
      const t = ensureCell(byProvider, n);
      t.reqs += c.reqs; t.ok += c.ok; t.fail += c.fail; t.ms += c.ms; t.tin += c.tin; t.tout += c.tout;
    }
    for (const [n, c] of Object.entries(b.byModel || {})) {
      const t = ensureCell(byModel, n);
      t.reqs += c.reqs; t.ok += c.ok; t.fail += c.fail; t.ms += c.ms; t.tin += c.tin; t.tout += c.tout;
    }
  }
  return { days: use, byProvider, byModel, clientReqs, clientOk };
}

// ============ 探活（与故障转移计数完全隔离，仅展示） ============
const probeState = {}; // name -> { ok, ms, err, time, busy }
let probeTimer = null;
function scheduleProbe() {
  if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
  const min = Math.max(1, Number(settings.probeIntervalMin) || 30);
  probeTimer = setInterval(() => runProbeAll(), min * 60 * 1000);
  probeTimer.unref();
}
function httpGetJson(url, headers, timeoutMs) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const transport = u.protocol === 'https:' ? https : http;
    const started = Date.now();
    const req = transport.get(url, { headers, timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', c => { data += c; if (data.length > 10000000) req.destroy(); }); // 10MB 上限，容纳 OpenRouter 690KB 大站列表
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, ms: Date.now() - started, body: data }));
      res.resume();
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, status: 0, ms: Date.now() - started, err: e.message }));
  });
}
// 纯探测：发请求更新探活快照，不做踢出判定
async function probeOnce(name) {
  const p = PROVIDERS[name];
  if (!p || p.enabled === false) return null; // 已踢出/停用：不再探测
  probeState[name] = { ...(probeState[name] || {}), busy: true };
  const t0 = Date.now();
  const r = await sniffModels(p.baseUrl, p.key); // 复用路径嗅探，避免 /v1/v1 双拼
  probeState[name] = {
    ok: r.ok, ms: Date.now() - t0,
    err: r.ok ? '' : r.err,
    time: Date.now(), busy: false,
  };
  computeProviderScore(name); // 评分随探活实时更新
  broadcast('providers'); broadcast('status'); // 面板实时刷新：探活/评分
  return r;
}

// 单站探测入口（手动触发用）：探测 + 正常连败/踢出判定
async function probeOne(name) {
  const r = await probeOnce(name);
  if (r) await handleProbeResult(name, r, false);
}

// 探测结果处理：连续失败计数与自动踢；netDown=本机网络故障时不计连败（防断网把好站全误杀）
async function handleProbeResult(name, r, netDown) {
  if (r.ok) { probeFailStreak[name] = 0; return; }
  if (netDown) { console.log(`  📡 本机网络疑似故障，${name} 本轮不计探活连败`); return; }
  probeFailStreak[name] = (probeFailStreak[name] || 0) + 1;
  if (probeFailStreak[name] >= 3 && settings.autoKick !== false) {
    try {
      const again = await sniffModels(PROVIDERS[name].baseUrl, PROVIDERS[name].key); // 复验
      if (!again.ok) await kickProvider(name);
      else probeFailStreak[name] = 0; // 复验活了：重置计数
    } catch (e) { console.log(`踢出检查出错(${name}): ${e.message}`); }
  }
}

const probeFailStreak = {}; // 连续探活失败计数（内存态，重启重数）

// 踢出废站：enabled=false + disabledBy:auto + 通知（含受影响模型）+ 记录历史
async function kickProvider(name) {
  try {
    const before = availableModels();
    const list = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const item = list.find(x => x.name === name);
    if (!item || item.enabled === false) return;
    item.enabled = false;
    item.disabledBy = 'auto';
    // 同步内存（不等热加载），保证受影响模型即时算对
    if (PROVIDERS[name]) PROVIDERS[name].enabled = false;
    const after = availableModels();
    const lost = before.filter(m => !after.includes(m));
    const lostNote = lost.length ? `，受影响模型：${lost.slice(0, 8).join('、')}${lost.length > 8 ? ' …' : ''}` : '';
    const err = writeProviders(list);
    if (err) { console.log(`踢出 ${name} 写入失败: ${err}`); return; }
    probeFailStreak[name] = 0;
    delete probeState[name]; // 停止探活展示（杜绝「已踢出+探活绿」矛盾）
    computeProviderScore(name); // 评分归 -1（UI 不显示旧正分）
    addChangelog('自动', `踢出废站 ${name}（探活连续失败+复验确认）${lostNote}`);
    sendNotify(`站点 ${name} 已自动踢出${lostNote}。可在 Provider 页手动启用或一键清理`);
    console.log(`  🥊 已自动踢出废站: ${name}${lostNote}`);
  } catch (e) { console.log(`踢出 ${name} 出错: ${e.message}`); }
}
// 全量探测：并发跑完 → 若 ≥80% 站同时失败（≥3站）判定为本机网络故障，本轮全员不计连败、不踢
async function runProbeAll() {
  const names = Object.keys(PROVIDERS);
  const results = await Promise.all(names.map(async n => ({ n, r: await probeOnce(n) })));
  const valid = results.filter(x => x.r);
  const fails = valid.filter(x => !x.r.ok).length;
  const netDown = valid.length >= 3 && fails / valid.length >= 0.8;
  if (netDown) {
    const msg = `📡 本机网络疑似故障（${valid.length} 个站中 ${fails} 个探活失败），本轮全部不计连败、不自动踢`;
    console.log(`\n${msg}\n`);
    sendNotify(msg);
    addChangelog('自动', msg);
  }
  for (const { n, r } of results) if (r) await handleProbeResult(n, r, netDown);
}

// ============ 模型列表探测（多路径嗅探，供助手与表单用） ============
function normalizeBase(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}
async function sniffModels(rawBase, key) {
  const b = normalizeBase(rawBase);
  if (!/^https?:\/\//.test(b)) return { ok: false, err: '地址必须以 http:// 或 https:// 开头' };
  // 路径候选：baseUrl 含 /v1（如 https://openrouter.ai/api/v1）时优先 b+/models，避免拼出 /v1/v1 双拼
  const paths = /\/v\d+$/.test(b) ? [b + '/models', b + '/v1/models'] : [b + '/v1/models', b + '/models'];
  let lastStatus = 0, lastErr = '';
  for (const u of paths) {
    const r = await httpGetJson(u, { Authorization: `Bearer ${key}` }, 12000);
    if (r.ok) {
      try {
        const j = JSON.parse(r.body);
        const ids = (j.data || j.models || []).map(x => x.id || x.name || String(x)).filter(Boolean);
        return { ok: true, models: ids, via: u.replace(/\/models$/, ''), count: ids.length };
      } catch (e) { lastErr = '响应不是有效 JSON'; }
    } else {
      lastStatus = r.status; lastErr = r.err || '';
    }
  }
  let err;
  if (lastStatus === 401 || lastStatus === 403) err = 'key 无效或无权限';
  else if (lastStatus === 404) err = '未找到模型列表端点（路径不对）';
  else if (lastStatus === 0) err = `网络不通（${lastErr}）`;
  else err = `HTTP ${lastStatus}`;
  return { ok: false, err };
}

// ============ 记忆库（自愈） ============
const memoryPath = path.join(APP_DIR, 'memory.json');
let memory = { changelog: [], stash: [], preferences: [], diary: [], longterm: [] };
try {
  const m = JSON.parse(fs.readFileSync(memoryPath, 'utf-8'));
  memory = {
    changelog: m.changelog || [],
    stash: m.stash || [],
    preferences: m.preferences || [],
    diary: m.diary || [],
    longterm: m.longterm || [],
  };
} catch (e) {
  try { fs.renameSync(memoryPath, `${memoryPath}.broken-${Date.now()}`); } catch (e2) {}
  console.log('memory.json 损坏已隔离，重建空记忆库');
}
function saveMemory() {
  if (memory.changelog.length > 200) memory.changelog.splice(0, memory.changelog.length - 200);
  if (memory.stash.length > 20) memory.stash.splice(0, memory.stash.length - 20);
  if (memory.diary.length > 100) memory.diary.splice(0, memory.diary.length - 100);
  if (memory.longterm.length > 50) memory.longterm.splice(0, memory.longterm.length - 50);
  try { atomicWrite(memoryPath, JSON.stringify(memory, null, 2)); } catch (e) {}
}
function addChangelog(source, detail) {
  memory.changelog.push({
    time: new Date().toLocaleString('zh-CN', { hour12: false }),
    source, detail,
  });
  saveMemory();
}

// ============ providers.json 写入（校验 + .bak 轮换3份 + 未知字段保留） ============
function validateProviders(list) {
  if (!Array.isArray(list) || list.length === 0) return '配置必须是非空数组';
  const names = new Set();
  for (const p of list) {
    if (!p || typeof p.name !== 'string' || !p.name.trim()) return '存在缺少 name 的 provider';
    if (names.has(p.name)) return `provider 名称重复: ${p.name}`;
    names.add(p.name);
    if (typeof p.baseUrl !== 'string' || !/^https?:\/\//.test(p.baseUrl)) return `${p.name}: baseUrl 必须是 http(s) 地址`;
    if (typeof p.key !== 'string' || !p.key) return `${p.name}: 缺少 key`;
    if (!Array.isArray(p.models) || p.models.length === 0) return `${p.name}: models 必须是非空数组`;
    if (p.aliases && typeof p.aliases !== 'object') return `${p.name}: aliases 必须是对象`;
  }
  return null;
}
function backupProviders() {
  try {
    const rot = (a, b) => { try { fs.renameSync(configPath + a, configPath + b); } catch (e) {} };
    rot('.bak2', '.bak3');
    rot('.bak1', '.bak2');
    rot('.bak', '.bak1');
    fs.copyFileSync(configPath, configPath + '.bak');
  } catch (e) {}
}
function writeProviders(list) {
  const err = validateProviders(list);
  if (err) return err;
  backupProviders();
  atomicWrite(configPath, JSON.stringify(list, null, 2));
  return null; // 热加载 2 秒后自动生效
}
function maskKey(key) {
  const t = String(key || '');
  if (!t) return '';
  return t.length <= 8 ? '***' : t.slice(0, 3) + '***' + t.slice(-4);
}
function maskProvider(p) {
  return { ...p, key: maskKey(p.key) };
}

// ============ AI 助手 ============
const ASSISTANT_SYSTEM = `你是「中转站配置助手」，服务于运行在本机的 AI 路由代理（聚合多个 OpenAI 兼容中转站，对外提供统一 /v1 接口），只负责配置相关事务。

## 职责
1. 解析用户贴来的中转站资源（地址、key 占位符、模型信息），生成 providers.json 变更提案
2. 管理和回忆配置记忆（用户偏好、变更历史、未应用的暂存资源）
3. 回答配置相关问题（哪个模型在哪个站、优先级、故障转移逻辑等）

## 变更提案协议（严格遵守）
- 先用中文简要说明，再输出一个 json 代码块，内容为操作数组（支持一次多个操作）：
\`\`\`json
[{"action":"add","provider":{"name":"站标识","baseUrl":"https://...","key":"{{KEY_1}}","models":["模型A","模型B"],"aliases":{"统一别名":"真实模型名"},"enabled":true}}]
\`\`\`
- action 取值：add（新增）/ update（更新，需输出完整对象，把不变字段的原值带上）/ delete（删除，只需 name）
- baseUrl 只能来自用户消息原文，禁止编造或修改域名
- models 只能来自用户提供的列表或系统自动探测结果，禁止编造；信息不全时先追问
- 新站的常用对话模型应尽量映射到现有统一别名（如 glm-5.2、glm-5.2-0815、deepseek-v4-flash），保持客户端无感
- key 一律使用 {{KEY_n}} 占位符（真实 key 由本地系统保管，你看不到也不需要）

## 记忆协议
- 需要记住用户偏好或事实时，在回复末尾单独一行输出：{"memory":{"remember":"要点"}}
- 每轮最多保存一条记忆

## 可用工具
只有当用户明确要求执行操作（检测/查询/测试/调整/启停等）时才调用工具；普通问题直接用文字回答，不要为了"显得有用"而主动调用工具。
调用时：先一句话说明要做什么，再在回复末尾输出工具块（系统执行后把结果回传，你再据此总结）。需要连续做多件事时，可以一次输出多个工具块（每个单独成行，按顺序执行）：
- 查询模型的配置情况（type: model 查该模型配置在哪些站、别名映射；site 查站点连通；target 填站名或模型名。注意：只查配置和探活结果，不发测试对话，禁止向用户声称"实测"）：{"tool":"check","type":"model","target":"glm-5.2"}
- 查看服务状态（哪些站挂了、可用/推荐模型、重启次数）：{"tool":"status"}
- 探测全部站点连通性：{"tool":"probe"}
- 测试单个站（需指定站名）：{"tool":"test","name":"站名"}
- 查看用量统计（range 可选 today/week/all）：{"tool":"stats","range":"today"}
- 查看最近日志（n 可选条数，默认30）：{"tool":"logs","n":30}
- 调整站点优先级（action: top 置顶/bottom 置底/up 上移/down 下移）：{"tool":"priority","name":"站名","action":"top"}
- 启用或停用某站（enabled: true 启用/false 停用，停用后路由不再走此站但配置保留）：{"tool":"toggle","name":"站名","enabled":false}
其他情况不要输出工具块。

## 行为规范
- 配置、运维、检测相关任务优先完成；对无关话题简短友好地回应即可，不必生硬拒绝
- 回答用中文，自然简洁，不确定就追问`;

function configSummary() {
  const lines = [];
  for (const [name, p] of Object.entries(PROVIDERS)) {
    const alias = Object.keys(p.aliases).length ? ' 别名:' + JSON.stringify(p.aliases) : '';
    lines.push(`- ${name} | ${p.baseUrl} | 模型: ${p.models.join(', ')}${alias}${p.enabled === false ? ' | [已禁用]' : ''} | key: 已配置（保密）`);
  }
  lines.push(`优先级（快→慢）: ${(settings.priority || []).join(' → ') || '（默认顺序）'}`);
  return lines.join('\n');
}
function memorySummary() {
  let s = '';
  if (memory.longterm.length) {
    s += '### 长期记忆（海马体）\n' + memory.longterm.slice(-20).map(x => `- [${x.category || '事实'}] ${x.fact}`).join('\n') + '\n';
  }
  if (memory.diary.length) {
    s += '### 近期日记\n' + memory.diary.slice(-5).map(d => `- ${d.time} ${d.summary}`).join('\n') + '\n';
  }
  if (memory.preferences.length) s += '### 用户偏好\n' + memory.preferences.map(x => `- ${x}`).join('\n') + '\n';
  if (memory.changelog.length) s += '### 最近变更历史\n' + memory.changelog.slice(-10).map(c => `- ${c.time} [${c.source}] ${c.detail}`).join('\n') + '\n';
  if (memory.stash.length) s += '### 未应用的暂存资源（可提醒用户处理）\n' + memory.stash.map(x => `- ${x.time} ${x.summary}`).join('\n');
  return s || '（暂无记忆）';
}
function assistantFriendlyError(status, errText) {
  if (status === 401 || status === 403) return `助手 API key 无效或无权限（HTTP ${status}）`;
  if (status === 402) return '助手 API 欠费（HTTP 402）';
  if (status === 404) return `助手 API 地址或模型名不对（HTTP 404）`;
  if (status === 429) return '助手 API 限流，稍后再试（HTTP 429）';
  if (status === 0) return `助手 API 网络不通（${errText || '超时'}）`;
  return `助手 API 异常（HTTP ${status}）`;
}
function handleAssistant(req, res, body) {
  const a = settings.assistant || {};
  if (!a.baseUrl || !a.key || !a.model) {
    sendJSON(res, 400, { error: '助手 API 未配置，请先在「AI 助手」页填写地址、key 和模型' });
    return;
  }
  let parsed;
  try { parsed = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }
  const history = (Array.isArray(parsed.history) ? parsed.history : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content)
    .slice(-20);

  const sys = `${ASSISTANT_SYSTEM}\n\n## 当前配置实时摘要（以此为准）\n${configSummary()}\n\n## 配置记忆\n${memorySummary()}`;
  const messages = [{ role: 'system', content: sys }, ...history];

  const base = normalizeBase(a.baseUrl).replace(/\/v1$/, '');
  const target = new URL(base + '/v1/chat/completions');
  const payload = JSON.stringify({ model: a.model, messages, stream: true });
  const transport = target.protocol === 'https:' ? https : http;
  const upReq = transport.request({
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: target.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${a.key}`,
      'Content-Length': Buffer.byteLength(payload),
    },
    timeout: 180000,
  }, (upRes) => {
    if (upRes.statusCode !== 200 || !(upRes.headers['content-type'] || '').includes('event-stream')) {
      let data = '';
      upRes.on('data', c => { data += c; });
      upRes.on('end', () => {
        sendJSON(res, 502, { error: assistantFriendlyError(upRes.statusCode, data.slice(0, 200)) });
      });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    upRes.pipe(res);
    res.on('close', () => { if (!upRes.destroyed) upRes.destroy(); });
  });
  upReq.on('timeout', () => upReq.destroy(new Error('timeout')));
  upReq.on('error', (e) => {
    try { sendJSON(res, 502, { error: assistantFriendlyError(0, e.message) }); } catch (e2) {}
  });
  upReq.write(payload);
  upReq.end();
}

// ============ 海马体记忆巩固 ============
const CONSOLIDATE_SYSTEM = `你是记忆巩固器（海马体）。把用户与助手的对话总结成日记，并提取值得长期记住的信息。只输出 JSON，不要任何其他文字或解释：

{"diary":{"summary":"一句话总结这次对话做了什么","keypoints":["最多3个要点"]},"longterm":[{"fact":"值得长期记住的事实或偏好","category":"偏好|事实|任务"}]}

要求：
- diary.summary 精简一句话；keypoints 最多 3 条
- longterm 只提取跨会话仍有价值的信息（用户偏好、习惯、重要决定、待办），去重、不记琐碎闲聊
- 没有值得长期记的，longterm 返回空数组 []
- 严格输出合法 JSON，不要用 markdown 代码块包裹`;

// 非流式调助手 API，返回完整文本（供记忆巩固用，不复用 handleAssistant 的流式逻辑）
function callAssistantNonStream(messages) {
  return new Promise((resolve, reject) => {
    const a = settings.assistant || {};
    if (!a.baseUrl || !a.key || !a.model) { reject(new Error('助手 API 未配置')); return; }
    const base = normalizeBase(a.baseUrl).replace(/\/v1$/, '');
    const target = new URL(base + '/v1/chat/completions');
    const payload = JSON.stringify({ model: a.model, messages, stream: false });
    const transport = target.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${a.key}`,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 180000,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`助手 API HTTP ${res.statusCode}`)); return; }
        try {
          const j = JSON.parse(data);
          const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          resolve(content || '');
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// 从助手回复里提取 JSON（容错：去掉 markdown 代码块包裹/前后杂字）
function extractJSON(text) {
  let t = String(text || '').trim();
  const m = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) t = m[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

// 长期记忆近似去重：精确相同，或新事实与旧事实互为子串（近义扩写/缩写，取较长者留存）
function isDuplicateFact(fact) {
  const norm = s => String(s || '').replace(/\s+/g, '').toLowerCase();
  const nf = norm(fact);
  if (!nf) return true;
  for (const x of memory.longterm) {
    const nx = norm(x.fact);
    if (nx === nf) return true;
    if (nx.length >= 8 && nf.length >= 8 && (nx.includes(nf) || nf.includes(nx))) {
      // 新的更长 → 用新的替换旧的（保留信息量更大的版本），并视为已存在
      if (nf.length > nx.length) x.fact = fact;
      return true;
    }
  }
  return false;
}

// 巩固：把一段对话总结成日记 + 长期记忆（失败返回 ok:false，不阻塞调用方）
async function handleConsolidate(req, res, body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }
  const history = (Array.isArray(parsed.history) ? parsed.history : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content);
  if (history.length === 0) return sendJSON(res, 400, { error: '没有可总结的对话' });

  const messages = [
    { role: 'system', content: CONSOLIDATE_SYSTEM },
    { role: 'user', content: '请总结以下对话：\n\n' + history.map(m => `${m.role === 'user' ? '用户' : '助手'}：${m.content}`).join('\n\n') },
  ];
  try {
    const raw = await callAssistantNonStream(messages);
    const result = extractJSON(raw);
    let diaryAdded = 0, longtermAdded = 0;
    if (result.diary && result.diary.summary) {
      memory.diary.push({
        time: new Date().toLocaleString('zh-CN', { hour12: false }),
        summary: String(result.diary.summary),
        keypoints: Array.isArray(result.diary.keypoints) ? result.diary.keypoints.slice(0, 3).map(String) : [],
      });
      diaryAdded = 1;
    }
    if (Array.isArray(result.longterm)) {
      for (const item of result.longterm) {
        if (!item || !item.fact) continue;
        const fact = String(item.fact);
        if (isDuplicateFact(fact)) continue; // 近似去重：精确相同 / 一方包含另一方
        memory.longterm.push({
          time: new Date().toLocaleString('zh-CN', { hour12: false }),
          fact,
          category: String(item.category || '事实'),
          source: 'consolidate',
        });
        longtermAdded++;
      }
    }
    saveMemory();
    console.log(`🧠 记忆巩固完成：日记+${diaryAdded}，长期记忆+${longtermAdded}`);
    sendJSON(res, 200, { ok: true, diaryAdded, longtermAdded });
  } catch (e) {
    console.log('记忆巩固失败:', e.message);
    sendJSON(res, 200, { ok: false, error: e.message });
  }
}

// ============ 管理面板基础设施（仅本机 + 防 DNS rebinding） ============
// SSE 实时推送：面板事件发生时主动推给浏览器，替代固定间隔轮询（轮询仍保留作兜底）
const sseClients = new Set();   // 活跃的 SSE 响应流
const sseTimers = {};           // type -> timeout（事件合并 debounce）
function broadcast(type, data) {
  if (sseTimers[type]) return;  // 250ms 内同类事件合并，防请求高峰期刷屏
  sseTimers[type] = setTimeout(() => {
    sseTimers[type] = null;
    for (const res of sseClients) {
      try { res.write(`event: ${type}\ndata: ${JSON.stringify(data || {})}\n\n`); } catch (e) {}
    }
  }, 250);
}
function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 5 * 1024 * 1024) req.destroy(); });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}
function adminAllowed(req) {
  const host = String(req.headers.host || '').toLowerCase();
  const okHost = [`127.0.0.1:${MY_PORT}`, `localhost:${MY_PORT}`];
  if (!okHost.includes(host)) return false;
  const org = req.headers.origin || req.headers.referer || '';
  if (org && !new RegExp(`^https?://(127\\.0\\.0\\.1|localhost)(:\\d+)?`).test(org)) return false;
  return true;
}
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
function serveStatic(res, file) {
  fs.readFile(path.join(PUBLIC_DIR, file), (e, data) => {
    if (e) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}
function readRunState() {
  try { return JSON.parse(fs.readFileSync(path.join(APP_DIR, `run-state-${TAG}.json`), 'utf-8')); } catch (e) { return {}; }
}
function allModelsSorted() {
  return [...new Set(Object.values(PROVIDERS).flatMap(p => [...p.models, ...Object.keys(p.aliases)]))].sort();
}
// 实际可用模型：站级（探活通且未被剔除）+ 模型级（未连续失败）双重过滤
function isProviderUsable(name) {
  const p = PROVIDERS[name];
  if (!p || p.enabled === false) return false;
  if (!isProviderHealthy(name)) return false;
  const probe = probeState[name];
  if (!probe || probe.busy) return true; // 未探活/探测中，先乐观列为可用
  return probe.ok;
}
function availableModels() {
  const models = new Set();
  for (const [name, p] of Object.entries(PROVIDERS)) {
    if (!isProviderUsable(name)) continue;
    for (const m of p.models) if (!isModelUnavailable(m)) models.add(m);
    for (const a of Object.keys(p.aliases)) if (!isModelUnavailable(a)) models.add(a);
  }
  return [...models].sort();
}
// ============ 模型稳定性测试（推荐模型由实测动态产生，绝不硬编码） ============
const VENDORS = {
  'deepseek': 'DeepSeek', 'glm': '智谱', 'qwen': '通义千问', 'step': '阶跃星辰',
  'grok': 'xAI', 'hy3': '腾讯混元', 'kimi': '月之暗面', 'minimax': 'MiniMax',
  'llama': 'Meta', 'gemma': 'Google', 'mistral': 'Mistral', 'sensenova': '星辰',
};
function vendorOf(model) {
  const m = String(model || '').toLowerCase();
  for (const [k, v] of Object.entries(VENDORS)) if (m.includes(k)) return v;
  return '';
}
// 某模型有多少个健康站能提供（直接 models 或 alias 映射）
function redundantCount(model) {
  const m = String(model || '').toLowerCase();
  let n = 0;
  for (const [name, p] of Object.entries(PROVIDERS)) {
    if (!isProviderUsable(name)) continue;
    if (p.models.some(x => x.toLowerCase() === m)) { n++; continue; }
    if (Object.keys(p.aliases).some(a => a.toLowerCase() === m)) n++;
  }
  return n;
}

const stability = { running: false, results: {}, lastTest: 0 };
// 推荐模型 = 今天真实使用过的模型（零测活）：成功率≥80%，按平均延迟升序
// 数据来源：stats 当天分桶的 byModel（真实业务流量，绝非测试请求）
function computeRecommended() {
  const b = stats[todayKey()] || {};
  const rec = [];
  for (const m of availableModels()) {
    const cell = (b.byModel && b.byModel[String(m).toLowerCase()]) || null; // 读侧同用小写 key
    if (!cell || cell.reqs < 1) continue; // 今天没实际用过的模型无数据，暂不推荐
    const rate = cell.ok / cell.reqs;
    if (rate < 0.8) continue; // 成功率低于 80% 的不推荐
    const avgMs = Math.round(cell.ms / cell.reqs);
    rec.push({
      alias: m,
      vendor: vendorOf(m),
      ms: avgMs,
      redundant: redundantCount(m),
      note: `今天用 ${cell.reqs} 次，成功率 ${Math.round(rate * 100)}%，平均 ${avgMs}ms`,
      available: true,
    });
  }
  return rec.sort((a, b) => (a.ms || 0) - (b.ms || 0)); // 延迟低优先
}
// 可用模型 = 探活通 + 最近实测跑通（没实测过时回退候选池，防重启后空列表）
function verifiedModels() {
  if (!stability.lastTest || Object.keys(stability.results).length === 0) return availableModels();
  const models = new Set();
  for (const m of availableModels()) {
    const r = stability.results[m];
    if (r && r.ok >= 1 && r.fail === 0) models.add(m);
  }
  return [...models].sort();
}

async function runStabilityTest() {
  // 因上游测活检测封号政策，稳定性测试已禁用（不再发送任何测试请求）
  stability.running = false;
  stability.lastTest = Date.now();
  console.log('🧪 稳定性测试已禁用（上游测活检测封号政策）');
}

// ============ apply（AI/手动变更应用，批量） ============
async function handleApply(req, res, body) {
  let parsed;
  try { parsed = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }
  const ops = Array.isArray(parsed.ops) ? parsed.ops : [];
  if (ops.length === 0) return sendJSON(res, 400, { error: '缺少操作列表' });

  // 从磁盘读真源（而非内存，避免热加载时序问题）
  let list;
  try { list = JSON.parse(fs.readFileSync(configPath, 'utf-8')); } catch (e) {
    return sendJSON(res, 500, { error: `providers.json 读取失败: ${e.message}` });
  }
  const results = [];
  const applied = [];
  const appliedNames = [];
  for (const op of ops) {
    const action = op.action, np = op.provider || {};
    const idx = list.findIndex(p => p.name === np.name);
    if (action === 'add') {
      if (idx >= 0) { results.push(`${np.name}: 已存在同名站，如需修改请用 update`); continue; }
      const item = { ...np };
      if (!item.aliases) item.aliases = {};
      if (item.enabled === undefined) item.enabled = true;
      list.push(item);
      applied.push(`新增 ${np.name}（${(np.models || []).length} 个模型）`);
      appliedNames.push(np.name);
    } else if (action === 'update') {
      if (idx < 0) { results.push(`${np.name || '?'}: 不存在，无法更新`); continue; }
      const merged = { ...list[idx], ...np };   // 未知字段保留
      if (!np.key || String(np.key).includes('***')) merged.key = list[idx].key; // key 脱敏/空 = 不变
      if (np.enabled === true) delete merged.disabledBy; // 重新启用：清除自动踢标记
      list[idx] = merged;
      applied.push(`更新 ${np.name}`);
      appliedNames.push(np.name);
    } else if (action === 'delete') {
      if (idx < 0) { results.push(`${np.name || '?'}: 不存在，无法删除`); continue; }
      list.splice(idx, 1);
      applied.push(`删除 ${np.name}`);
      // 同步清理优先级表（防残留死条目）
      try {
        const st = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        if (Array.isArray(st.priority)) {
          st.priority = st.priority.filter(n => n !== np.name);
          fs.writeFileSync(settingsPath, JSON.stringify(st, null, 2));
        }
      } catch (e) {}
    } else {
      results.push(`未知 action: ${action}`);
    }
  }
  if (applied.length === 0) return sendJSON(res, 400, { error: results.join('；') || '没有可应用的操作' });

  const err = writeProviders(list);
  if (err) return sendJSON(res, 400, { error: err });
  addChangelog(parsed.source || 'AI', applied.join('；'));
  // 应用成功 → 清掉对应 stash
  const names = new Set(ops.map(o => o.provider && o.provider.name).filter(Boolean));
  memory.stash = memory.stash.filter(s => !names.has(s.name));
  saveMemory();
  console.log(`  ✅ 已应用变更（${parsed.source === '手动' ? '手动' : 'AI'}）: ${applied.join('；')}`);
  // 新站/更新站即时探活：死站当场垫底，不进路由坑人
  for (const n of appliedNames) {
    if (PROVIDERS[n]) setTimeout(() => { probeOne(n).catch(() => {}); }, 1500);
  }
  sendJSON(res, 200, { ok: true, applied, skipped: results });
}

// ============ 管理路由分发 ============
async function handleAdmin(req, res, reqUrl) {
  const p = reqUrl.pathname;
  const m = req.method;

  // SSE 事件流：面板 EventSource 挂在这里接收实时事件（status/providers/stats/memory）
  if (m === 'GET' && p === '/admin/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (m === 'GET' && p === '/admin/api/status') {
    const providers = Object.entries(PROVIDERS).map(([name, cfg]) => ({
      name, baseUrl: cfg.baseUrl, keyMasked: maskKey(cfg.key), models: cfg.models,
      aliases: cfg.aliases, enabled: cfg.enabled !== false,
      disabledBy: (providerList.find(x => x.name === name) || {}).disabledBy || null,
      score: providerScores[name] || null,
      failures: providerHealth[name] ? providerHealth[name].failures : 0,
      quarantined: providerHealth[name] ? !isProviderHealthy(name) : false,
      probe: probeState[name] || null,
      availableModels: [...new Set([...cfg.models, ...Object.keys(cfg.aliases)])].filter(m => !isModelUnavailable(m)),
    }));
    const a = settings.assistant || {};
    sendJSON(res, 200, {
      port: MY_PORT,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      models: verifiedModels(),
      recommended: computeRecommended(),
      kickedCount: providerList.filter(p => p.disabledBy === 'auto').length,
      providers,
      runState: readRunState(),
      baseUrl: `${accessBaseUrl()}/v1`,
      bindLan: settings.bindLan === true,
      lanIP: currentHost === '0.0.0.0' ? (lanIPv4() || '') : '',
      apiKeyMasked: maskKey(settings.apiKey),
      assistant: { baseUrl: a.baseUrl, keyMasked: maskKey(a.key), model: a.model || '' },
      probeIntervalMin: settings.probeIntervalMin,
    });
    return;
  }

  if (m === 'GET' && p === '/admin/api/providers') {
    sendJSON(res, 200, { mtime: configMtime(), list: providerList.map(maskProvider) });
    return;
  }
  if (m === 'PUT' && p === '/admin/api/providers') {
    const body = await readBody(req);
    let parsed;
    try { parsed = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }
    if (parsed.mtime && parsed.mtime < configMtime()) {
      return sendJSON(res, 409, { error: '配置已被其他页面修改，请刷新后重试' });
    }
    const oldByName = {};
    for (const op of providerList) oldByName[op.name] = op;
    const list = (parsed.list || []).map(np => {
      const old = oldByName[np.name];
      const merged = { ...old, ...np };   // 未知字段保留
      if (!np.key || String(np.key).includes('***')) merged.key = old ? old.key : '';
      // 手动启停标记：手动停用=manual（一键清理不删）；手动启用清除标记（恢复参与自动判定）
      if (old && old.enabled !== false && np.enabled === false) merged.disabledBy = 'manual';
      if (old && old.enabled === false && np.enabled === true) delete merged.disabledBy;
      return merged;
    });
    const err = writeProviders(list);
    if (err) return sendJSON(res, 400, { error: err });
    addChangelog('手动', '保存 provider 配置');
    sendJSON(res, 200, { ok: true });
    return;
  }

  if (m === 'GET' && p === '/admin/api/settings') {
    const s = { ...settings, assistant: { ...(settings.assistant || {}) } };
    s.apiKey = maskKey(settings.apiKey);
    if (s.assistant) s.assistant.key = maskKey(settings.assistant.key);
    sendJSON(res, 200, s);
    return;
  }
  if (m === 'PUT' && p === '/admin/api/settings') {
    const body = await readBody(req);
    let fresh;
    try { fresh = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }
    const old = JSON.parse(JSON.stringify(settings));
    // key 类字段：空或含 *** → 保留旧值
    if (!fresh.apiKey || String(fresh.apiKey).includes('***')) fresh.apiKey = old.apiKey;
    if (fresh.assistant) {
      if (!fresh.assistant.key || String(fresh.assistant.key).includes('***')) {
        fresh.assistant.key = (old.assistant && old.assistant.key) || '';
      }
      fresh.assistant = { ...old.assistant, ...fresh.assistant };
    }
    const merged = { ...old, ...fresh };
    try { atomicWrite(settingsPath, JSON.stringify(merged, null, 2)); } catch (e) {
      return sendJSON(res, 500, { error: `写入失败: ${e.message}` });
    }
    const changedKey = fresh.apiKey !== old.apiKey;
    sendJSON(res, 200, { ok: true, changedKey });
    return;
  }

  if (p === '/admin/api/memory') {
    if (m === 'GET') { sendJSON(res, 200, memory); return; }
    if (m === 'PUT') {
      const body = await readBody(req);
      let op;
      try { op = JSON.parse(body); } catch { return sendJSON(res, 400, { error: 'Invalid JSON' }); }
      if (op.op === 'addPreference' && op.text) memory.preferences.push(String(op.text));
      else if (op.op === 'editPreference' && Number.isInteger(op.index) && op.text) memory.preferences[op.index] = String(op.text);
      else if (op.op === 'delPreference' && Number.isInteger(op.index)) memory.preferences.splice(op.index, 1);
      else if (op.op === 'delStash' && Number.isInteger(op.index)) memory.stash.splice(op.index, 1);
      else if (op.op === 'addStash' && op.item) memory.stash.push(op.item);
      else if (op.op === 'delDiary' && Number.isInteger(op.index)) memory.diary.splice(op.index, 1);
      else if (op.op === 'delLongterm' && Number.isInteger(op.index)) memory.longterm.splice(op.index, 1);
      else if (op.op === 'clearAll') memory = { changelog: [], stash: [], preferences: [], diary: [], longterm: [] };
      else return sendJSON(res, 400, { error: '未知操作' });
      saveMemory();
      sendJSON(res, 200, memory);
      return;
    }
    sendJSON(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  if (m === 'POST' && p === '/admin/api/test') {
    const body = await readBody(req);
    let { name } = {};
    try { ({ name } = JSON.parse(body)); } catch (e) {}
    const p2 = PROVIDERS[name];
    if (!p2) return sendJSON(res, 404, { error: `站 ${name} 不存在` });
    const t0 = Date.now();
    const r = await sniffModels(p2.baseUrl, p2.key);
    sendJSON(res, 200, { name, ok: r.ok, ms: Date.now() - t0, status: r.ok ? 200 : 0, err: r.ok ? '' : r.err });
    return;
  }

  // 灵活检测：type=site 测站点连通；type=model 测某模型在各站的真实可用性
  if (m === 'POST' && p === '/admin/api/check') {
    const body = await readBody(req);
    let { type, target } = {};
    try { ({ type, target } = JSON.parse(body)); } catch (e) {}
    if (!target) return sendJSON(res, 400, { error: '缺少 target' });
    if (type === 'model') {
      const cands = findProviders(target);
      if (cands.length === 0) return sendJSON(res, 404, { error: `模型 ${target} 未配置在任何站` });
      // 因上游测活检测封号政策，不再发真实请求测模型，只返回配置信息
      const results = cands.map(cand => ({
        provider: cand.provider, realModel: cand.realModel,
        note: '已配置（探活判定）',
      }));
      return sendJSON(res, 200, { type: 'model', target, results });
    }
    // 默认 type=site
    const p2 = PROVIDERS[target];
    if (!p2) return sendJSON(res, 404, { error: `站 ${target} 不存在` });
    const t0 = Date.now();
    const r = await sniffModels(p2.baseUrl, p2.key);
    return sendJSON(res, 200, { type: 'site', target, ok: r.ok, ms: Date.now() - t0, err: r.ok ? '' : r.err });
  }

  if (m === 'POST' && p === '/admin/api/probe') {
    const body = await readBody(req);
    let name = 'all';
    try { ({ name = 'all' } = JSON.parse(body)); } catch (e) {}
    if (name === 'all') {
      runProbeAll();
      sendJSON(res, 200, { started: 'all' });
    } else {
      await probeOne(name);
      sendJSON(res, 200, probeState[name] || { err: '站不存在' });
    }
    return;
  }

  if (m === 'POST' && p === '/admin/api/probe-models') {
    const body = await readBody(req);
    let { baseUrl, key, name } = {};
    try { ({ baseUrl, key, name } = JSON.parse(body)); } catch (e) {}
    // key 留空且指定了已有站 → 用已保存的 key（方便编辑表单自动拉模型）
    if (!key && name && PROVIDERS[name] && PROVIDERS[name].baseUrl === baseUrl) {
      key = PROVIDERS[name].key;
    }
    if (!baseUrl) return sendJSON(res, 400, { error: '缺少 baseUrl' });
    if (!key) return sendJSON(res, 400, { error: '缺少 key（新站请填写，已有站可留空自动使用保存的 key）' });
    const r = await sniffModels(baseUrl, key);
    // 因上游测活检测封号政策，不再发真实请求实测模型，只返回探活列表供参考
    sendJSON(res, r.ok ? 200 : 400, r);
    return;
  }

  if (p === '/admin/api/stability-test') {
    if (m === 'POST') {
      if (stability.running) return sendJSON(res, 200, { running: true });
      runStabilityTest().catch(e => { console.log('稳定性测试出错:', e.message); stability.running = false; });
      return sendJSON(res, 200, { running: true });
    }
    if (m === 'GET') {
      return sendJSON(res, 200, { running: stability.running, lastTest: stability.lastTest, results: stability.results, recommended: computeRecommended() });
    }
  }

  if (m === 'POST' && p === '/admin/api/priority') {
    const body = await readBody(req);
    let { name, action } = {};
    try { ({ name, action } = JSON.parse(body)); } catch (e) {}
    if (!name || !['up', 'down', 'top', 'bottom'].includes(action)) {
      return sendJSON(res, 400, { error: '需要 name 和 action（up/down/top/bottom）' });
    }
    try {
      const st = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      let prio = Array.isArray(st.priority) ? [...st.priority] : [];
      let i = prio.indexOf(name);
      if (i < 0) { prio.push(name); i = prio.length - 1; }
      prio.splice(i, 1);
      if (action === 'top') prio.unshift(name);
      else if (action === 'bottom') prio.push(name);
      else if (action === 'up') prio.splice(Math.max(0, i - 1), 0, name);
      else if (action === 'down') prio.splice(Math.min(prio.length, i + 1), 0, name);
      st.priority = prio;
      atomicWrite(settingsPath, JSON.stringify(st, null, 2));
      addChangelog('AI', `调整优先级：${name} → ${action}`);
      console.log(`  ✅ 调整优先级（AI）: ${name} ${action}`);
      sendJSON(res, 200, { ok: true, priority: prio });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (m === 'POST' && p === '/admin/api/toggle-provider') {
    const body = await readBody(req);
    let { name, enabled } = {};
    try { ({ name, enabled } = JSON.parse(body)); } catch (e) {}
    if (!name || typeof enabled !== 'boolean') return sendJSON(res, 400, { error: '需要 name 和 enabled（布尔）' });
    try {
      const list = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const item = list.find(x => x.name === name);
      if (!item) return sendJSON(res, 404, { error: `站 ${name} 不存在` });
      item.enabled = enabled;
      const err = writeProviders(list);
      if (err) return sendJSON(res, 400, { error: err });
      addChangelog('AI', `${enabled ? '启用' : '停用'} ${name}`);
      console.log(`  ✅ ${enabled ? '启用' : '停用'} ${name}（AI）`);
      sendJSON(res, 200, { ok: true });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (m === 'GET' && p === '/admin/api/stats') {
    const range = reqUrl.searchParams.get('range') || 'all';
    sendJSON(res, 200, { ...summarizeStats(range), history: reqHistory.slice(-100).reverse() });
    return;
  }

  if (m === 'GET' && p === '/admin/api/logs') {
    const cursor = parseInt(reqUrl.searchParams.get('cursor') || '0', 10);
    const items = cursor > 0 ? logRing.filter(l => l.c > cursor) : logRing.slice(-200);
    sendJSON(res, 200, { cursor: logSeq, items });
    return;
  }

  if (m === 'POST' && p === '/admin/api/apply') {
    const body = await readBody(req);
    return handleApply(req, res, body);
  }

  if (m === 'POST' && p === '/admin/api/assistant') {
    const body = await readBody(req);
    return handleAssistant(req, res, body);
  }

  if (m === 'POST' && p === '/admin/api/consolidate') {
    const body = await readBody(req);
    return handleConsolidate(req, res, body);
  }

  sendJSON(res, 404, { error: 'Not Found' });
}

// ============ supervisor 心跳检测（supervisor 死亡则自杀，防残留占端口） ============
const heartbeatFile = path.join(APP_DIR, `heartbeat-${TAG}.txt`);
setInterval(() => {
  try {
    const beat = parseInt(fs.readFileSync(heartbeatFile, 'utf-8').trim(), 10);
    if (Date.now() - beat > 30000) {
      console.log('supervisor 心跳超时，router 自动退出');
      process.exit(0);
    }
  } catch (e) { /* 心跳文件不存在（单独调试模式），不退出 */ }
}, 10000).unref();

// ============ HTTP 代理主服务 ============
let clientSeq = 0;
server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${currentHost}:${MY_PORT}`);
  const reqPath = reqUrl.pathname;
  const method = req.method;

  // 管理面板请求不打业务日志（轮询会刷屏）
  if (!reqPath.startsWith('/admin/')) {
    console.log(`${method} ${reqPath}`);
  }

  // ---- 静态管理页 ----
  if (method === 'GET' && (reqPath === '/' || reqPath === '/index.html')) { serveStatic(res, 'index.html'); return; }
  if (method === 'GET' && (reqPath === '/app.js' || reqPath === '/style.css')) { serveStatic(res, reqPath.slice(1)); return; }

  // ---- 管理 API（仅本机） ----
  if (reqPath.startsWith('/admin/')) {
    if (!adminAllowed(req)) { sendJSON(res, 403, { error: '禁止访问' }); return; }
    handleAdmin(req, res, reqUrl).catch(e => {
      try { sendJSON(res, 500, { error: e.message }); } catch (e2) {}
    });
    return;
  }

  if (method !== 'POST' && method !== 'GET') {
    res.writeHead(405);
    res.end('Method Not Allowed');
    return;
  }

  if (method === 'GET' && reqPath === '/v1/models') {
    const auth = req.headers.authorization || '';
    if (settings.apiKey && auth !== `Bearer ${settings.apiKey}`) {
      return sendJSON(res, 401, { error: { message: 'API Key 无效', type: 'auth_error' } });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: verifiedModels().map(m2 => ({ id: m2, object: 'model' }))
    }));
    return;
  }

  if (!reqPath.startsWith('/v1/')) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  // apiKey 校验（默认 sk-router 与现有客户端一致）
  const auth = req.headers.authorization || '';
  if (settings.apiKey && auth !== `Bearer ${settings.apiKey}`) {
    return sendJSON(res, 401, { error: { message: 'API Key 无效（在管理面板「设置」中配置）', type: 'auth_error' } });
  }

  // Anthropic 端点统一转成 OpenAI chat/completions
  let upstreamPath = reqPath;
  if (reqPath === '/v1/messages' || reqPath === '/v1/input_messages') {
    upstreamPath = '/v1/chat/completions';
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end('Invalid JSON');
      return;
    }

    const modelName = parsed.model || '';
    const clientId = ++clientSeq;
    const candidates = sortCandidates(findProviders(modelName)).filter(c => isProviderHealthy(c.provider));
    const tryList = candidates.length > 0 ? candidates : sortCandidates(findProviders(modelName));

    if (tryList.length === 0) {
      const available = availableModels();
      const preview = available.slice(0, 20).join(', ') + (available.length > 20 ? ` …（共 ${available.length} 个）` : '');
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: `模型 "${modelName}" 未找到。可用: ${preview}`,
          type: 'model_not_found',
        }
      }));
      recordClientResult(false);
      return;
    }

    let lastError = null;

    for (const cand of tryList) {
      const targetBody = JSON.stringify(sanitizeBody(parsed, cand.realModel));
      const opts = buildOptions(cand, upstreamPath, targetBody);
      const aliasNote = cand.realModel !== modelName ? ` (${modelName} → ${cand.realModel})` : '';
      console.log(`  → ${cand.provider} ${opts.hostname}${opts.path}${aliasNote}`);

      const t0 = Date.now();
      let result;
      try {
        result = await sendRequest(opts, targetBody);
      } catch (e) {
        markProviderFailed(cand.provider);
        markProvider5xx(cand.provider); // 网络错误/超时同样计入 5xx 熔断
        console.log(`  ✗ ${cand.provider} 网络错误: ${e.message}`);
        recordAttempt(modelName, cand.provider, Date.now() - t0, 502, false, false, null);
        lastError = { statusCode: 502, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: { message: `${cand.provider}: ${e.message}`, type: 'proxy_error' } }) };
        continue;
      }

  if (result.stream) {
    markProviderSuccess(cand.provider);
    markModelSuccess(modelName);
    console.log(`  ✅ ${cand.provider} [stream] model=${modelName}`);
    recordClientResult(true);
    res.writeHead(result.statusCode, result.headers);
    const stream = result.stream;
    // 流式 usage 解析：只保留尾部 chunk，在流结束时解析一次（避免每个 chunk 全量扫描占满主线程，
    // opus/thinking 等长流会产生海量 chunk，逐块扫描会拖垮主线程导致健康检查超时误判僵尸）
    let usageTail = '';
    stream.on('data', (chunk) => {
      usageTail = (usageTail + chunk.toString('utf8')).slice(-16384); // 只留尾部 16KB
    });
    function parseUsageFromTail() {
      let searchFrom = usageTail.length;
      for (;;) {
        const idx = usageTail.lastIndexOf('"usage"', searchFrom);
        if (idx < 0) return;
        searchFrom = idx - 1;
        const start = usageTail.indexOf('{', idx);
        if (start < 0) continue;
        let depth = 0, end = -1;
        for (let i = start; i < usageTail.length; i++) {
          if (usageTail[i] === '{') depth++;
          else if (usageTail[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
        }
        if (end <= 0) continue;
        try {
          const u = JSON.parse(usageTail.slice(start, end));
          if (u && (u.prompt_tokens || u.completion_tokens)) { recordStreamTokens(cand.provider, modelName, u); return; }
        } catch (e) {}
      }
    }
    // 流式延迟 = 完整流式时长（end 或客户端断开 close 都记录，只记一次）
    let streamRecorded = false;
    const recordStream = () => {
      if (streamRecorded) return;
      streamRecorded = true;
      try { parseUsageFromTail(); } catch (e) {}
      recordAttempt(modelName, cand.provider, Date.now() - t0, 200, true, true, null);
    };
    stream.on('end', recordStream);
    stream.on('close', recordStream);
    stream.pipe(res);
    // 客户端断开 → 销毁上游连接（修复连接泄漏挤爆连接池的问题）
    res.on('close', () => { if (!stream.destroyed) stream.destroy(); });
    return;
  }

      let usage = null;
      if (result.statusCode >= 200 && result.statusCode < 300) {
        try { usage = (JSON.parse(result.body).usage) || null; } catch (e) {}
      }
      recordAttempt(modelName, cand.provider, Date.now() - t0, result.statusCode, result.statusCode >= 200 && result.statusCode < 300 && isValidCompletion(result.body), false, usage);

      if (result.statusCode >= 200 && result.statusCode < 300) {
        if (!isValidCompletion(result.body)) {
          markProviderFailed(cand.provider);
          markModelFailed(modelName);
          console.log(`  🔄 ${cand.provider} [200但空响应] 换下一个provider...`);
          lastError = result;
          continue;
        }
        markProviderSuccess(cand.provider);
        markModelSuccess(modelName);
        console.log(`  ✅ ${cand.provider} [${result.statusCode}] model=${modelName}`);
        res.writeHead(result.statusCode, result.headers);
        res.end(result.body);
        recordClientResult(true);
        return;
      }

      if (shouldFailover(result.statusCode, result.body)) {
        markProviderFailed(cand.provider);
        if (result.statusCode >= 500) markProvider5xx(cand.provider); // 5xx 熔断计数
        if (result.statusCode === 429) markProvider429(cand.provider); // 429 限流连击提醒
        if (isModelLevelError(result.statusCode, result.body, isValidCompletion(result.body))) {
          markModelFailed(modelName);
        }
        console.log(`  🔄 ${cand.provider} [${result.statusCode}] 换下一个provider...`);
        lastError = result;
        continue;
      }

      console.log(`  ⚠️ ${cand.provider} [${result.statusCode}] 不可转移错误，原样返回`);
      res.writeHead(result.statusCode, result.headers);
      res.end(result.body);
      recordClientResult(result.statusCode < 500);
      return;
    }

    console.log(`  💥 所有provider都失败 (尝试了${tryList.length}个)`);
    recordClientResult(false);
    if (lastError) {
      res.writeHead(lastError.statusCode, lastError.headers);
      res.end(lastError.body);
    } else {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'all providers failed', type: 'proxy_error' } }));
    }
    } catch (e) { console.log('! 请求处理异常:', e.message); }
  });
});

server.listen(MY_PORT, currentHost, () => {
  const mode = currentHost === '0.0.0.0' ? `局域网可访问（${lanIPv4() || '未知IP'}）` : '仅本机';
  console.log(`\n✅ 路由代理已启动（故障转移 + 流式支持 + 管理面板）`);
  console.log(`   监听: ${currentHost}:${MY_PORT}（${mode}）`);
  console.log(`   接口地址: ${accessBaseUrl()}/v1`);
  console.log(`   管理面板: ${accessBaseUrl()}/`);
  console.log(`   API Key: ${maskKey(settings.apiKey)}（管理面板可改）`);
  console.log(`   配置文件: ${configPath}`);
  console.log(`\n📋 已加载 ${providerList.length} 个 provider:`);
  for (const p of providerList) {
    console.log(`   ${p.name}: ${p.baseUrl} (${p.models.length} 个模型)`);
  }
  console.log(`\n📦 去重后配置模型 ${allModelsSorted().length} 个，当前可用 ${availableModels().length} 个`);
  scheduleProbe();
  setTimeout(runProbeAll, 3000); // 启动 3 秒后先探活一轮
  restoreQuotaSuspended(); // 启动时先恢复「昨天限流停用」的站（防服务在 0 点后重启漏恢复）
  scheduleMidnightReset(); // 安排每晚 0 点恢复限流停用站
  // 稳定性测试改为手动触发（总览页「测试稳定性」按钮），不再自动跑，防忙碌时健康检查超时误判僵尸重启
});
