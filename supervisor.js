/**
 * 看护进程（supervisor）：启动并守护 router.js
 * - 崩溃自动重启（指数退避；连续启动失败 5 次停止，可从托盘手动重启恢复）
 * - 僵死检测（每 30s 健康检查，连续 3 次失败强杀重启）
 * - 托盘管理（tray.ps1，被杀自动重拉；托盘启动失败不影响服务）
 * - 单实例锁（端口被占提示后退出，防双开）
 * - 心跳文件（router / 托盘检测不到心跳即自杀，防止 supervisor 死后残留僵尸占端口）
 * - 日志落盘（logs\ 按天滚动，保留最近 7 天，写失败静默不影响服务）
 * 测试实例：设环境变量 RP_PORT=3199 后运行（运行时文件名带端口隔离）
 */
const { spawn, exec } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const APP_DIR = __dirname;
const PORT = parseInt(process.env.RP_PORT || '3099', 10);
const TAG = PORT === 3099 ? 'main' : String(PORT);
const STATE_FILE = path.join(APP_DIR, `run-state-${TAG}.json`);
const HEARTBEAT_FILE = path.join(APP_DIR, `heartbeat-${TAG}.txt`);
const TRAY_CMD_FILE = path.join(APP_DIR, `tray-cmd-${TAG}.txt`);
const LOG_DIR = path.join(APP_DIR, 'logs');

const state = {
  restarts: 0,        // router 崩溃重启次数
  zombieRestarts: 0,  // 僵死强杀重启次数
  startFails: 0,      // 连续启动失败次数（进程存活<5s视为启动失败）
  stopped: false,     // 连续失败达到上限后停止自动重启
  startedAt: Date.now(),
  lastRestartAt: 0,
  routerStartedAt: 0,
};

let routerProc = null;
let trayProc = null;
let shuttingDown = false;

// ============ 运行状态 ============
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) { /* 忽略 */ }
}

// ============ 日志落盘 ============
function logFileName() {
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `router-${TAG === 'main' ? '' : TAG + '-'}${ymd}.log`;
}
function appendLog(text) {
  try { fs.appendFileSync(path.join(LOG_DIR, logFileName()), text); } catch (e) { /* 磁盘满/被锁不能影响服务 */ }
}
function cleanOldLogs() {
  try {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(LOG_DIR)) {
      const m = f.match(/(\d{4})-(\d{2})-(\d{2})\.log$/);
      if (m && new Date(m[1], m[2] - 1, m[3]).getTime() < cutoff) {
        try { fs.unlinkSync(path.join(LOG_DIR, f)); } catch (e) {}
      }
    }
  } catch (e) {}
}

// 子进程输出：加本地时间戳 → 控制台 + 日志文件（按行缓冲）
function pipeOutput(proc) {
  let buf = '';
  const handle = (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      const out = `[${ts}] ${line}\n`;
      process.stdout.write(out);
      appendLog(out);
    }
  };
  proc.stdout.on('data', handle);
  proc.stderr.on('data', handle);
}

// ============ 进程树清理 ============
function killTree(pid, cb) {
  if (!pid) { if (cb) cb(); return; }
  exec(`taskkill /PID ${pid} /T /F`, () => { if (cb) cb(); });
}

// ============ 托盘 ============
function notify(msg) {
  try { fs.appendFileSync(TRAY_CMD_FILE, `notify:${msg}\n`); } catch (e) {}
}
function openBrowser() {
  exec(`start "" "http://127.0.0.1:${PORT}/"`, (e) => {
    if (e) console.log(`[supervisor] 打开浏览器失败: ${e.message}`);
  });
}
function startTray() {
  if (shuttingDown) return;
  try {
    trayProc = spawn('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(APP_DIR, 'tray.ps1'), '-Port', String(PORT),
    ], { cwd: APP_DIR, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    console.log(`[supervisor] 托盘启动失败（服务继续运行）: ${e.message}`);
    return;
  }
  let buf = '';
  trayProc.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const cmd = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!cmd) continue;
      if (cmd === 'open') openBrowser();
      else if (cmd === 'restart') manualRestart();
      else if (cmd === 'quit') shutdown();
    }
  });
  trayProc.stderr.on('data', (d) => console.log(`[tray] ${d.toString('utf8').trim()}`));
  trayProc.on('exit', (code) => {
    if (shuttingDown) return;
    console.log(`[supervisor] 托盘进程退出(code=${code})，2 秒后重拉`);
    setTimeout(startTray, 2000);
  });
  console.log(`[supervisor] 托盘已启动 pid=${trayProc.pid}`);
}

// ============ router 子进程 ============
const BACKOFFS = [1000, 5000, 15000, 60000];
let backoffIdx = 0;

function startRouter() {
  if (shuttingDown || state.stopped) return;
  routerProc = spawn(process.execPath, ['router.js'], {
    cwd: APP_DIR,
    env: { ...process.env, RP_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.routerStartedAt = Date.now();
  saveState();
  pipeOutput(routerProc);
  console.log(`[supervisor] router 已启动 pid=${routerProc.pid}`);
  routerProc.on('exit', (code, signal) => {
    if (shuttingDown) return;
    const livedMs = Date.now() - state.routerStartedAt;
    if (livedMs < 5000) state.startFails++; else state.startFails = 0;

    if (state.startFails >= 5) {
      state.stopped = true;
      saveState();
      console.log(`[supervisor] 连续 ${state.startFails} 次启动失败，停止自动重启。修复配置后请从托盘菜单选「重启服务」`);
      notify('连续启动失败已停止重启，请检查配置文件（providers.json / settings.json），修复后从托盘菜单重启服务');
      return;
    }

    state.restarts++;
    state.lastRestartAt = Date.now();
    const wait = BACKOFFS[Math.min(backoffIdx, BACKOFFS.length - 1)];
    backoffIdx++;
    saveState();
    console.log(`[supervisor] router 退出(code=${code} sig=${signal})，${wait / 1000} 秒后自动重启`);
    notify(`服务异常退出，${wait / 1000} 秒后自动重启（第 ${state.restarts} 次）`);
    setTimeout(startRouter, wait);
  });
}

// 托盘「重启服务」/ 僵死后手动恢复：清零失败状态重新拉起
function manualRestart() {
  console.log('[supervisor] 手动重启服务');
  state.stopped = false;
  state.startFails = 0;
  backoffIdx = 0;
  if (routerProc && routerProc.exitCode === null) {
    killTree(routerProc.pid); // exit 回调会自动重启
  } else {
    startRouter();
  }
}

// ============ 僵死检测 ============
let healthFails = 0;
function readApiKey() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'settings.json'), 'utf8'));
    return s.apiKey || '';
  } catch (e) { return ''; }
}
setInterval(() => {
  if (state.stopped || shuttingDown || !routerProc || routerProc.exitCode !== null) return;
  let settled = false;
  const req = http.get({
    host: '127.0.0.1', port: PORT, path: '/v1/models',
    headers: { Authorization: `Bearer ${readApiKey()}` },
    timeout: 8000,
  }, (res) => { res.resume(); if (!settled) { settled = true; healthFails = 0; } });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', () => {
    if (settled) return;
    settled = true;
    healthFails++;
    if (healthFails >= 4) {
      healthFails = 0;
      state.zombieRestarts++;
      saveState();
      console.log('[supervisor] 健康检查连续 4 次失败，判定僵死，强杀重启');
      notify('服务无响应，已强制重启');
      killTree(routerProc.pid);
    }
  });
}, 30000);

// ============ 心跳（router/托盘据此判断 supervisor 是否存活） ============
setInterval(() => {
  try { fs.writeFileSync(HEARTBEAT_FILE, String(Date.now())); } catch (e) {}
}, 5000);

// ============ 整树退出 ============
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[supervisor] 退出：清理全部子进程');
  try { fs.appendFileSync(TRAY_CMD_FILE, 'quit\n'); } catch (e) {}
  killTree(routerProc && routerProc.pid, () => {
    setTimeout(() => {
      if (trayProc) killTree(trayProc.pid);
      for (const f of [HEARTBEAT_FILE, TRAY_CMD_FILE]) {
        try { fs.unlinkSync(f); } catch (e) {}
      }
      process.exit(0);
    }, 1500);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ============ 单实例锁 + 启动 ============
function checkSingleInstance(cb) {
  let settled = false;
  const done = (inUse) => { if (!settled) { settled = true; cb(inUse); } };
  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/v1/models', timeout: 2000 }, (res) => {
    res.resume(); done(true);
  });
  req.on('timeout', () => { req.destroy(); done(false); });
  req.on('error', () => done(false));
}

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}
cleanOldLogs();
try { fs.writeFileSync(HEARTBEAT_FILE, String(Date.now())); } catch (e) {}
saveState();

checkSingleInstance((inUse) => {
  if (inUse) {
    console.log(`[supervisor] 端口 ${PORT} 已被占用（路由代理可能已在运行），本次启动退出`);
    exec(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('路由代理已在运行（端口 ${PORT}），无需重复启动。','路由代理',0,64)"`);
    process.exit(0);
  }
  console.log(`[supervisor] 看护进程启动 pid=${process.pid} 管理端口=${PORT}`);
  startRouter();
  startTray();
});
