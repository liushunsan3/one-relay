/* 路由代理控制台前端（全中文，无框架） */
'use strict';

/* ============ 基础工具 ============ */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtTime(ts) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}
function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}
function fmtDur(sec) {
  if (sec < 60) return sec + ' 秒';
  if (sec < 3600) return Math.floor(sec / 60) + ' 分钟';
  if (sec < 86400) return Math.floor(sec / 3600) + ' 小时 ' + Math.floor((sec % 3600) / 60) + ' 分';
  return Math.floor(sec / 86400) + ' 天 ' + Math.floor((sec % 86400) / 3600) + ' 小时';
}

let connOk = null;
function setConn(ok) {
  if (connOk === ok) return;
  connOk = ok;
  const b = $('#connBadge');
  b.textContent = ok ? '● 服务正常' : '● 服务不可达';
  b.className = 'badge ' + (ok ? 'on' : 'off');
  $('#offlineBanner').classList.toggle('hidden', ok);
}

async function api(path, opts = {}) {
  try {
    const r = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    setConn(true);
    if (!r.ok) throw new Error(j.error || j.message || `HTTP ${r.status}`);
    return j;
  } catch (e) {
    if (e instanceof TypeError) { setConn(false); throw new Error('网络不通（服务可能正在重启）'); }
    throw e;
  }
}

/* ============ toast / 确认框 / 模态 ============ */
function toast(msg, type = '') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.remove(), 3500);
}
function openModal(html) {
  $('#modalBody').innerHTML = html;
  $('#modalRoot').classList.remove('hidden');
}
function closeModal() { $('#modalRoot').classList.add('hidden'); }
$('#modalRoot').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeModal(); });

function confirmDlg(title, text, danger = false) {
  return new Promise((resolve) => {
    openModal(`
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(text)}</p>
      <div class="m-actions">
        <button class="btn" id="cfNo">取消</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" id="cfYes">确定</button>
      </div>`);
    $('#cfNo').onclick = () => { closeModal(); resolve(false); };
    $('#cfYes').onclick = () => { closeModal(); resolve(true); };
  });
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(
    () => toast('已复制到剪贴板', 'ok'),
    () => toast('复制失败', 'err')
  );
}

/* ============ 主题 ============ */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('rp_theme', t);
}
{
  const saved = localStorage.getItem('rp_theme');
  if (saved) applyTheme(saved);
  else if (matchMedia('(prefers-color-scheme: dark)').matches) applyTheme('dark');
}
$('#themeBtn').onclick = () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
};

/* ============ Tab 切换 ============ */
let activeTab = 'overview';
$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  activeTab = btn.dataset.tab;
  $$('#tabs button').forEach(b => b.classList.toggle('active', b === btn));
  $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + activeTab));
  if (activeTab === 'providers') renderProviders();
  if (activeTab === 'assistant') refreshMemory();
});

/* ============ 总览 ============ */
let lastStatus = null;
async function refreshStatus() {
  try {
    const s = await api('/admin/api/status');
    lastStatus = s;
    renderStatus(s);
  } catch (e) { /* 轮询容错 */ }
}
function renderStatus(s) {
  // 首次运行引导（无任何站点时显示 3 步上手）
  const guide = $('#setupGuide');
  if (s.providers.length === 0) {
    guide.innerHTML = `
      <h3>👋 欢迎使用路由代理 —— 三步上手</h3>
      <div class="kv">
        <span class="k">第 1 步</span><span>到「🤖 AI 助手」页填一次助手 API（OpenAI 兼容地址+key+模型），以后配置全靠对话</span>
        <span class="k">第 2 步</span><span>把中转站资源贴给 AI 助手（例：<code class="mono">https://api.example.com key sk-xxx</code>），它会自动查出该站支持的模型并生成配置</span>
        <span class="k">第 3 步</span><span>点「✔ 应用」——完事！自动探活、自动评分、永远走最快的站</span>
      </div>
      <p class="hint">没有助手 API？也可以去「Provider 管理」页手动新增（同样只需地址+key，点「自动获取模型列表」）。首次使用建议先点「设为开机自启」。</p>`;
    guide.classList.remove('hidden');
  } else {
    guide.classList.add('hidden');
  }
  const rs = s.runState || {};
  $('#statusCard').innerHTML = `
    <h3>⚙️ 服务状态</h3>
    <div class="kv">
      <span class="k">监听端口</span><span class="mono">${s.port}</span>
      <span class="k">运行时长</span><span>${fmtDur(s.uptime)}</span>
      <span class="k">崩溃自动重启</span><span>${rs.restarts ?? 0} 次</span>
      <span class="k">僵死强制重启</span><span>${rs.zombieRestarts ?? 0} 次</span>
      ${rs.stopped ? '<span class="k" style="color:var(--bad)">自动重启</span><span style="color:var(--bad)">已停止（配置错误），请从托盘「重启服务」恢复</span>' : ''}
      <span class="k">探活间隔</span><span>${s.probeIntervalMin} 分钟</span>
      <span class="k">Provider</span><span>${s.providers.length} 个站 / ${s.models.length} 个模型</span>
      ${s.kickedCount > 0 ? `<span class="k" style="color:var(--bad)">已踢出</span><span style="color:var(--bad)">${s.kickedCount} 个废站（Provider 页可清理/恢复）</span>` : ''}
    </div>`;

  $('#accessCard').innerHTML = `
    <h3>🔌 接入信息（客户端填这些）</h3>
    <div class="kv">
      <span class="k">Base URL</span>
      <span class="mono"><button class="btn sm ghost copy-btn" data-copy="${s.baseUrl}">复制</button>${s.baseUrl}</span>
      <span class="k">API Key</span>
      <span class="mono"><button class="btn sm ghost copy-btn" data-copy="__ASKKEY__">显示</button>${s.apiKeyMasked} <button class="btn sm" data-action="changeKey">🔑 修改密码</button></span>
      <span class="k">局域网访问</span>
      <span>${s.bindLan ? '✅ 已开启（同 WiFi 可用）' : '🔒 仅本机'} <button class="btn sm ${s.bindLan ? '' : 'primary'}" data-action="toggleLan">${s.bindLan ? '关闭' : '开启局域网'}</button></span>
    </div>
    ${s.bindLan && s.lanIP ? `<p class="hint">局域网设备接入：<span class="mono">http://${escapeHtml(s.lanIP)}:${s.port}/v1</span>（key 同上）。手机连不上就到 Windows 防火墙放行 ${s.port} 端口（TCP 入站）。</p>` : ''}
    <p class="hint">ZCode / dsh 等客户端按此配置；key 点「显示」后从设置页复制完整值。开启局域网前建议先把 key 改成自己的密码。</p>`;

  // 健康表
  const rows = s.providers.map(p => {
    const probe = p.probe;
    const kickTag = p.enabled === false
      ? (p.disabledBy === 'auto' ? '<span class="tag tag-bad">已踢出</span> ' : p.disabledBy === 'quota' ? '<span class="tag tag-warn">限流停用(0点恢复)</span> ' : '<span class="tag tag-muted">已停用</span> ')
      : '';
    const probeCell = p.enabled === false ? '—'
      : !probe ? '<span class="dot idle"></span>未测'
      : probe.busy ? '<span class="spin">◌</span>探测中'
      : probe.ok ? `<span class="dot ok"></span>通（${probe.ms}ms）`
      : `<span class="dot bad"></span>不通（${escapeHtml(probe.err || '?')}）`;
    return `<tr>
      <td>${kickTag}<b>${escapeHtml(p.name)}</b></td>
      <td class="wrap mono">${escapeHtml(p.baseUrl)}</td>
      <td>${p.models.length}</td>
      <td>${p.quarantined ? '<span style="color:var(--bad)">已剔除(' + p.failures + '/3)</span>' : p.failures ? p.failures + '/3' : '正常'}</td>
      <td>${probeCell}</td>
      <td>${probe ? fmtClock(probe.time) : '—'}</td>
    </tr>`;
  }).join('');
  $('#healthTable').innerHTML = `<thead><tr><th>站点</th><th>地址</th><th>模型数</th><th>失败计数</th><th>探活</th><th>探活时间</th></tr></thead><tbody>${rows}</tbody>`;

  $('#modelCount').textContent = s.models.length;
  // 推荐模型清单（由稳定性测试动态产生）
  const rec = (s.recommended || []).map(r => {
    return `<span class="chip rec-ok" title="${escapeHtml(r.note)} · 点击复制模型名" data-copy="${escapeHtml(r.alias)}">⭐ ${escapeHtml(r.alias)}<span class="rec-vendor"> ${escapeHtml(r.vendor)}</span></span>`;
  }).join('');
  $('#recommendedModels').innerHTML = rec
    ? `<div class="rec-title">⭐ 推荐模型（今天实际使用，按延迟排序）</div><div>${rec}</div>`
    : `<div class="rec-title">⭐ 推荐模型</div><div class="hint">今天还没用过模型。你真实使用时系统自动记录（零测活），用过后这里会按成功率+延迟推荐。</div>`;
  renderModelGroups();
}

/* 模型分组渲染（支持关键词即时过滤；搜索框与 5 秒轮询共用） */
let modelKeyword = '';
function renderModelGroups() {
  const s = lastStatus;
  if (!s) return;
  const groups = {};
  for (const p of s.providers) {
    if (p.enabled === false) continue;
    if (p.quarantined) continue;
    if (p.probe && !p.probe.busy && !p.probe.ok) continue; // 探活失败的站跳过
    const items = p.availableModels || [];
    if (items.length) groups[p.name] = items;
  }
  const kw = modelKeyword.trim().toLowerCase();
  let html = '';
  for (const [name, items] of Object.entries(groups)) {
    const filtered = kw
      ? items.filter(m => m.toLowerCase().includes(kw) || name.toLowerCase().includes(kw))
      : items;
    if (!filtered.length) continue;
    html += `<div class="model-group">
      <div class="gtitle">${escapeHtml(name)}（${filtered.length}）</div>
      ${filtered.map(m => `<span class="chip">${escapeHtml(m)}</span>`).join('')}
    </div>`;
  }
  $('#modelGroups').innerHTML = html
    || (kw ? `<div class="hint">没有匹配「${escapeHtml(modelKeyword.trim())}」的模型</div>` : '<div class="hint">暂无可用模型</div>');
}
$('#modelSearch').addEventListener('input', (e) => { modelKeyword = e.target.value; renderModelGroups(); });
$('#tab-overview').addEventListener('click', async (e) => {
  const actionBtn = e.target.closest('[data-action]');
  if (actionBtn) {
    const act = actionBtn.dataset.action;
    if (act === 'toggleLan') { actionBtn.disabled = true; await toggleLan(); actionBtn.disabled = false; return; }
    if (act === 'changeKey') { await changeApiKey(); return; }
  }
  const btn = e.target.closest('.copy-btn');
  if (btn) {
    if (btn.dataset.copy === '__ASKKEY__') { toast('完整 key 请到「Provider 管理」编辑框或 settings.json 查看', ''); return; }
    copyText(btn.dataset.copy);
    return;
  }
  const chip = e.target.closest('[data-copy].rec-ok');
  if (chip) { copyText(chip.dataset.copy); toast(`已复制模型名 ${chip.dataset.copy}`, 'ok'); }
});

/* 局域网访问开关（settings 热加载约 2 秒后切换监听地址） */
async function toggleLan() {
  try {
    const cur = lastStatus ? lastStatus.bindLan === true : false;
    const next = !cur;
    await api('/admin/api/settings', { method: 'PUT', body: { bindLan: next } });
    if (next) {
      toast('已开启局域网访问（约 2 秒生效）。同 WiFi 设备用你的 API Key 即可访问，请确需 key 已改成自己的密码；手机连不上记得放行 Windows 防火墙端口。', 'ok');
    } else {
      toast('已关闭局域网访问，恢复仅本机可访问（约 2 秒生效）', 'ok');
    }
    setTimeout(() => refreshStatus(), 2500);
  } catch (e) { toast(e.message, 'err'); }
}

/* 修改访问密钥（API Key，可自定义密码） */
async function changeApiKey() {
  openModal(`
    <h3>🔑 修改访问密钥（API Key / 密码）</h3>
    <p class="hint">客户端连接本代理用的密码。留空则自动生成随机 key；保存后立即生效，旧客户端需改用新 key。</p>
    <div class="form-grid">
      <label>新密钥<input id="newKey" placeholder="留空 = 随机生成"></label>
    </div>
    <div class="m-actions">
      <button class="btn" id="ckCancel">取消</button>
      <button class="btn primary" id="ckSave">保存</button>
    </div>`);
  $('#ckCancel').onclick = closeModal;
  $('#ckSave').onclick = async () => {
    let nk = $('#newKey').value.trim();
    if (!nk) nk = 'sk-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
    try {
      await api('/admin/api/settings', { method: 'PUT', body: { apiKey: nk } });
      closeModal();
      try { await navigator.clipboard.writeText(nk); toast(`密钥已更新并复制到剪贴板：${nk}（旧客户端需改用新 key）`, 'ok'); }
      catch (e) { toast(`密钥已更新：${nk}（旧客户端需改用新 key）`, 'ok'); }
      setTimeout(() => refreshStatus(), 1500);
    } catch (e) { toast(e.message, 'err'); }
  };
}

/* ============ Provider 管理 ============ */
let providersCache = null;   // GET /admin/api/providers
let settingsCache = null;    // GET /admin/api/settings

async function renderProviders() {
  try {
    const [pv, st] = await Promise.all([api('/admin/api/providers'), api('/admin/api/settings')]);
    providersCache = pv;
    settingsCache = st;
    const prio = st.priority || [];
    const status = lastStatus;
    const rows = pv.list.map(p => {
      const enabled = p.enabled !== false;
      const probe = status && status.providers.find(x => x.name === p.name);
      const pc = p.enabled === false ? '—' : (probe && probe.probe ? (probe.probe.ok ? '✅' : '❌') : '·');
      const statusTag = p.enabled === false
        ? (p.disabledBy === 'auto' ? ' <span class="tag tag-bad">已踢出</span>' : p.disabledBy === 'quota' ? ' <span class="tag tag-warn">限流停用</span>' : ' <span class="tag tag-muted">已停用</span>')
        : '';
      const insecure = /^http:\/\//.test(p.baseUrl) ? ' ⚠️<span class="hint">明文</span>' : '';
      const pi = prio.indexOf(p.name);
      // 评分来自 /admin/api/status（providers 接口不带 score）；status 每 5s 轮询已有缓存
      const sc = (status && status.providers.find(x => x.name === p.name) || {}).score;
      const scoreCell = (sc && typeof sc.score === 'number' && sc.score >= 0)
        ? `<span class="progress" title="${escapeHtml(sc.detail || '')}"><i class="${sc.score >= 70 ? 'p-hi' : sc.score >= 40 ? 'p-mid' : 'p-lo'}" style="--p:${Math.max(0, Math.min(100, sc.score))}%"></i></span> ${sc.score}`
        : enabled ? '计算中…' : '—';
      return `<tr>
        <td><b>${escapeHtml(p.name)}</b>${statusTag}</td>
        <td class="wrap mono">${escapeHtml(p.baseUrl)}${insecure}</td>
        <td>${p.models.length}</td>
        <td title="${sc ? escapeHtml(sc.detail || '') : ''}">${scoreCell}</td>
        <td><label class="chk"><input type="checkbox" data-toggle="${escapeHtml(p.name)}" ${enabled ? 'checked' : ''}></label></td>
        <td>${pc}</td>
        <td>${pi >= 0 ? pi + 1 : '-'}</td>
        <td>
          <button class="btn sm" data-up="${escapeHtml(p.name)}" title="优先级上移">↑</button>
          <button class="btn sm" data-down="${escapeHtml(p.name)}" title="优先级下移">↓</button>
        </td>
        <td>
          <button class="btn sm" data-edit="${escapeHtml(p.name)}">编辑</button>
          <button class="btn sm" data-test="${escapeHtml(p.name)}">测试</button>
          <button class="btn sm danger" data-del="${escapeHtml(p.name)}">删除</button>
        </td>
      </tr>`;
    }).join('');
    $('#providerTable').innerHTML = `<thead><tr><th>站点</th><th>地址</th><th>模型数</th><th>评分</th><th>启用</th><th>探活</th><th>优先级</th><th>调整</th><th>操作</th></tr></thead><tbody>${rows}</tbody>`;
    // 智能路由开关状态同步
    const smartOn = st.smartRouting !== false;
    const sb = $('#smartRoutingBtn');
    sb.textContent = smartOn ? '⚡ 智能路由：开' : '⚡ 智能路由：关';
    sb.classList.toggle('primary', smartOn);
    $('#routingHint').textContent = smartOn
      ? '智能路由开启：自动选评分最高的站（优先级仅作同分参考）'
      : '固定优先级模式：越靠前越优先（点击 ↑↓ 调整）';
  } catch (e) {
    $('#providerTable').innerHTML = `<tbody><tr><td>加载失败：${escapeHtml(e.message)}</td></tr></tbody>`;
  }
}

$('#tab-providers').addEventListener('change', async (e) => {
  const name = e.target.dataset.toggle;
  if (!name) return;
  const list = JSON.parse(JSON.stringify(providersCache.list));
  const item = list.find(p => p.name === name);
  if (!item) return;
  item.enabled = e.target.checked;
  try {
    await api('/admin/api/providers', { method: 'PUT', body: { mtime: providersCache.mtime, list } });
    toast(item.enabled ? `已启用 ${name}` : `已停用 ${name}（路由不再走此站）`, 'ok');
    renderProviders();
  } catch (err) { toast(err.message, 'err'); }
});

$('#tab-providers').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const name = btn.dataset.edit || btn.dataset.test || btn.dataset.del || btn.dataset.up || btn.dataset.down;
  if (!name) return;

  if (btn.dataset.edit) return openProviderModal(name);
  if (btn.dataset.up || btn.dataset.down) {
    const prio = [...(settingsCache.priority || [])];
    const i = prio.indexOf(name);
    if (i < 0) { prio.push(name); }
    const j = btn.dataset.up ? Math.max(0, i - 1) : Math.min(prio.length - 1, i + 1);
    if (i >= 0) prio.splice(i, 1);
    prio.splice(Math.max(0, j - (i < 0 ? 1 : 0)), 0, name);
    try {
      await api('/admin/api/settings', { method: 'PUT', body: { priority: prio } });
      renderProviders();
    } catch (err) { toast(err.message, 'err'); }
    return;
  }
  if (btn.dataset.test) {
    btn.disabled = true; btn.textContent = '测试中…';
    try {
      const r = await api('/admin/api/test', { method: 'POST', body: { name } });
      toast(r.ok ? `${name} 连通，延迟 ${r.ms}ms` : `${name} 不通：${r.err}`, r.ok ? 'ok' : 'err');
    } catch (err) { toast(err.message, 'err'); }
    renderProviders();
    return;
  }
  if (btn.dataset.del) {
    if (!(await confirmDlg('删除中转站', `确定删除「${name}」？该站的模型将从路由中移除（有 .bak 备份可恢复）。`, true))) return;
    const list = providersCache.list.filter(p => p.name !== name);
    try {
      await api('/admin/api/providers', { method: 'PUT', body: { mtime: providersCache.mtime, list } });
      toast(`已删除 ${name}`, 'ok');
      renderProviders();
    } catch (err) { toast(err.message, 'err'); }
  }
});

$('#addProviderBtn').onclick = () => openProviderModal(null);
$('#probeAllBtn').onclick = async () => {
  toast('已开始全部探活…');
  await api('/admin/api/probe', { method: 'POST', body: { name: 'all' } }).catch(() => {});
  // 轮询直到所有站探完（busy 消失）或超时，替代硬等 6 秒（探活异步，常常 6 秒没跑完显得像没反应）
  for (let i = 0; i < 15; i++) {
    await sleep(1000);
    try {
      const s = await api('/admin/api/status');
      if (!s.providers.some(p => p.probe && p.probe.busy)) break;
    } catch (e) {}
  }
  renderProviders();
  refreshStatus();
};

// 智能路由开关（切换后 settings 热加载约 2 秒生效）
$('#smartRoutingBtn').onclick = async () => {
  try {
    const cur = settingsCache ? settingsCache.smartRouting !== false : true;
    await api('/admin/api/settings', { method: 'PUT', body: { smartRouting: !cur } });
    toast(`智能路由已${!cur ? '开启' : '关闭（回退固定优先级）'}`, 'ok');
    renderProviders();
  } catch (e) { toast(e.message, 'err'); }
};

// 一键清理废站（只删自动踢出的，手动停用不受影响）
$('#cleanKickedBtn').onclick = async () => {
  try {
    const pv = await api('/admin/api/providers');
    const kicked = pv.list.filter(p => p.disabledBy === 'auto');
    if (!kicked.length) { toast('没有被自动踢出的站', ''); return; }
    if (!(await confirmDlg('一键清理废站', `将删除 ${kicked.length} 个被自动踢出的站：${kicked.map(p => p.name).join('、')}。手动停用的站不受影响，配置有备份可恢复。`, true))) return;
    const list = pv.list.filter(p => p.disabledBy !== 'auto');
    await api('/admin/api/providers', { method: 'PUT', body: { mtime: pv.mtime, list } });
    toast(`已清理 ${kicked.length} 个废站`, 'ok');
    renderProviders();
    refreshStatus();
  } catch (e) { toast(e.message, 'err'); }
};

function openProviderModal(name) {
  const p = name ? providersCache.list.find(x => x.name === name) : null;
  const aliases = p ? Object.entries(p.aliases || {}) : [];
  openModal(`
    <h3>${p ? '编辑' : '新增'}中转站</h3>
    <div class="form-grid">
      <label>站名（唯一标识）<input id="fName" value="${p ? escapeHtml(p.name) : ''}" placeholder="如 myapi"></label>
      <label>Base URL<input id="fBase" value="${p ? escapeHtml(p.baseUrl) : ''}" placeholder="https://api.example.com（可不带 /v1）"></label>
      <label>API Key<input id="fKey" type="password" placeholder="${p ? '留空保持不变（当前 ' + escapeHtml(p.key) + '）' : 'sk-...'}"></label>
      <label>模型列表（每行一个）
        <textarea id="fModels" rows="6" placeholder="每行一个模型名，或点下方按钮自动获取">${p ? p.models.join('\n') : ''}</textarea>
      </label>
      <div class="inline">
        <button id="fFetch" class="btn">🔍 自动获取模型列表（用上方地址和 key）</button>
        <span class="hint" id="fFetchNote"></span>
      </div>
      <div id="fCheckboxArea" class="f-model-list" style="display:none"></div>
      <label>别名映射（统一别名 → 该站真实模型名）
        <div id="fAliasRows">${aliases.map(([k, v]) => aliasRowHtml(k, v)).join('') || '<span class="hint">无</span>'}</div>
        <button id="fAddAlias" class="btn sm" type="button">＋ 加一行</button>
      </label>
      <label class="chk"><input type="checkbox" id="fEnabled" ${!p || p.enabled !== false ? 'checked' : ''}> 启用（停用后路由不再走此站，配置保留）</label>
    </div>
    <div class="m-actions">
      <button class="btn" id="fCancel">取消</button>
      <button class="btn primary" id="fSave">保存</button>
    </div>`);

  $('#fAddAlias').onclick = () => {
    const holder = $('#fAliasRows');
    if (holder.querySelector('.hint')) holder.innerHTML = '';
    holder.insertAdjacentHTML('beforeend', aliasRowHtml('', ''));
  };
  $('#fAliasRows').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-delalias]');
    if (btn) btn.closest('.alias-row').remove();
  });
  $('#fFetch').onclick = async () => {
    const btn = $('#fFetch');
    btn.disabled = true;
    $('#fFetchNote').textContent = '探测中…';
    try {
      const r = await api('/admin/api/probe-models', {
        method: 'POST',
        body: { baseUrl: $('#fBase').value.trim(), key: $('#fKey').value.trim(), name: p ? p.name : undefined },
      });
      if (r.ok) {
        // 渲染可滑动勾选列表 + 全选/取消全选按钮
        const area = $('#fCheckboxArea');
        area.innerHTML =
          `<div style="display:flex;gap:8px;padding:6px 10px;border-bottom:2px solid var(--border);position:sticky;top:0;background:var(--card);z-index:1">
            <button class="btn sm" id="fSelectAll">全选</button>
            <button class="btn sm" id="fDeselectAll">取消全选</button>
            <span class="hint" style="margin-left:auto;align-self:center">已选 <b id="fSelCount">${r.count}</b> / ${r.count}</span>
          </div>` +
          r.models.map((m, idx) =>
            `<label class="f-model-row"><input type="checkbox" class="f-model-cb" checked data-idx="${idx}"> <span class="mono">${escapeHtml(m)}</span><span class="hint" style="margin-left:auto">#${idx + 1}</span></label>`
          ).join('');
        area.style.display = 'block';
        const updateCount = () => {
          const total = area.querySelectorAll('.f-model-cb').length;
          const sel = area.querySelectorAll('.f-model-cb:checked').length;
          $('#fSelCount').textContent = sel;
        };
        const syncToTextarea = () => {
          const checked = [...area.querySelectorAll('.f-model-cb:checked')].map(c => r.models[parseInt(c.dataset.idx)]);
          const manual = $('#fModels').value.split('\n').map(s => s.trim()).filter(s => s && !r.models.includes(s));
          $('#fModels').value = [...checked, ...manual].join('\n');
        };
        area.addEventListener('change', () => { updateCount(); syncToTextarea(); });
        $('#fSelectAll').onclick = () => { area.querySelectorAll('.f-model-cb').forEach(cb => cb.checked = true); updateCount(); syncToTextarea(); };
        $('#fDeselectAll').onclick = () => { area.querySelectorAll('.f-model-cb').forEach(cb => cb.checked = false); updateCount(); syncToTextarea(); };
        $('#fFetchNote').innerHTML = `✅ 获取到 <b>${r.count}</b> 个模型`;
      } else {
        $('#fFetchNote').textContent = `❌ ${r.error || r.err}`;
      }
    } catch (err) { $('#fFetchNote').textContent = `❌ ${err.message}`; }
    btn.disabled = false;
  };
  $('#fCancel').onclick = closeModal;
  $('#fSave').onclick = async () => {
    const btn = $('#fSave');
    btn.disabled = true;
    const list = JSON.parse(JSON.stringify(providersCache.list));
    const aliasRows = $$('#fAliasRows .alias-row');
    const aliases = {};
    for (const row of aliasRows) {
      const k = row.querySelector('.ak').value.trim();
      const v = row.querySelector('.av').value.trim();
      if (k && v) aliases[k] = v;
    }
    const item = {
      name: $('#fName').value.trim(),
      baseUrl: $('#fBase').value.trim().replace(/\/+$/, ''),
      key: $('#fKey').value.trim(),
      models: $('#fModels').value.split('\n').map(s => s.trim()).filter(Boolean),
      aliases,
      enabled: $('#fEnabled').checked,
    };
    if (!item.name || !item.baseUrl || !item.models.length) { toast('站名、地址、模型列表不能为空', 'err'); btn.disabled = false; return; }
    const idx = list.findIndex(x => x.name === item.name);
    if (p && idx >= 0) {
      const merged = { ...list[idx], ...item };
      if (!item.key) merged.key = list[idx].key;
      list[idx] = merged;
    } else {
      if (idx >= 0) { toast(`已存在同名站「${item.name}」，请换名字或用编辑`, 'err'); btn.disabled = false; return; }
      list.push(item);
    }
    try {
      await api('/admin/api/providers', { method: 'PUT', body: { mtime: providersCache.mtime, list } });
      toast('已保存，配置热加载约 2 秒后生效', 'ok');
      closeModal();
      renderProviders();
    } catch (err) { toast(err.message, 'err'); btn.disabled = false; }
  };
}
function aliasRowHtml(k, v) {
  return `<div class="alias-row">
    <input class="input ak" placeholder="统一别名 如 glm-5.2" value="${escapeHtml(k)}">
    <span class="eq">→</span>
    <input class="input av" placeholder="真实模型名" value="${escapeHtml(v)}">
    <button class="btn sm danger" type="button" data-delalias="1">✕</button>
  </div>`;
}

/* ============ AI 助手 ============ */
const CHAT_KEY = 'rp_chat_v1';
const KEYMAP_KEY = 'rp_keymap_v1';
let chatStore = [];
let keyMap = {};
try {
  chatStore = JSON.parse(localStorage.getItem(CHAT_KEY) || '[]');
  keyMap = JSON.parse(localStorage.getItem(KEYMAP_KEY) || '{}');
} catch (e) {}
function persistChat() {
  if (chatStore.length > 100) chatStore.splice(0, chatStore.length - 100);
  localStorage.setItem(CHAT_KEY, JSON.stringify(chatStore));
  localStorage.setItem(KEYMAP_KEY, JSON.stringify(keyMap));
}

const KEY_RE = /sk-[A-Za-z0-9_\-\.]{8,}/g;
function maskKeys(text) {
  const found = [];
  const masked = text.replace(KEY_RE, (k) => {
    if (!found.includes(k)) found.push(k);
    return `{{KEY_${found.indexOf(k) + 1}}}`;
  });
  for (let i = 0; i < found.length; i++) keyMap[`{{KEY_${i + 1}}}`] = found[i];
  persistChat();
  return { masked, found };
}
function fillKeys(text) {
  return String(text || '').replace(/\{\{KEY_\d+\}\}/g, (m) => keyMap[m] || m);
}

// 流式渲染节流：每动画帧最多重绘一次（避免每个 SSE chunk 全量重绘卡顿）
let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => { renderScheduled = false; renderChat(); });
}
function renderChat() {
  const box = $('#chatBox');
  const streaming = assistantAbort !== null; // 流式中
  box.innerHTML = chatStore.map((m, idx) => {
    if (m.role === 'sysline') return `<div class="sysline">${escapeHtml(m.content)}</div>`;
    // 工具结果虽以 user 角色注入（便于回传 AI），但不是用户发言：渲染成可折叠的系统块，不占用户气泡
    if (m.role === 'user' && String(m.content).startsWith('[系统工具结果]')) {
      const payload = String(m.content).slice('[系统工具结果]'.length).trim();
      return `<details class="tool-result"><summary>🔧 工具结果</summary><pre>${escapeHtml(payload)}</pre></details>`;
    }
    const body = m.role === 'assistant' ? renderMarkdown(m.content) : escapeHtml(m.content);
    const cursor = (streaming && idx === chatStore.length - 1 && m.role === 'assistant') ? '<span class="cursor-blink">▍</span>' : '';
    return `<div class="msg ${m.role}"><div class="who">${m.role === 'user' ? '我' : '助手'}</div><div class="body">${body}${cursor}</div></div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}

// 行内格式：code / 加粗 / 斜体（先转义）
function renderInline(text) {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*\s])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>');
}
// 代码块：带语言标签 + 复制按钮
function renderCodeBlock(lang, code) {
  const id = 'cp' + Math.random().toString(36).slice(2, 8);
  const langTag = lang ? `<span class="code-lang">${escapeHtml(lang)}</span>` : '';
  return `<div class="code-block"><div class="code-head">${langTag}<button class="btn sm ghost copy-btn" data-copy-id="${id}">复制</button></div><pre><code id="${id}">${escapeHtml(code)}</code></pre></div>`;
}
// 块级渲染：标题/分隔线/引用/列表/表格/段落
function renderBlocks(text) {
  const lines = text.split('\n');
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    // 标题
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { html += `<h${h[1].length}>${renderInline(h[2])}</h${h[1].length}>`; i++; continue; }
    // 分隔线
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { html += '<hr>'; i++; continue; }
    // 引用
    if (/^\s*>\s?/.test(line)) {
      const q = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      html += `<blockquote>${renderInline(q.join('<br>'))}</blockquote>`;
      continue;
    }
    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++; }
      html += '<ul>' + items.map(x => `<li>${renderInline(x)}</li>`).join('') + '</ul>';
      continue;
    }
    // 有序列表
    if (/^\s*\d+[.、]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.、]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+[.、]\s+/, '')); i++; }
      html += '<ol>' + items.map(x => `<li>${renderInline(x)}</li>`).join('') + '</ol>';
      continue;
    }
    // 表格（下一行是 |---| 分隔行）
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const cells = (s) => s.split('|').map(x => x.trim()).filter(x => x !== '');
      const header = cells(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|')) { rows.push(cells(lines[i])); i++; }
      html += '<table><thead><tr>' + header.map(h2 => `<th>${renderInline(h2)}</th>`).join('') + '</tr></thead><tbody>'
        + rows.map(r => '<tr>' + r.map(c => `<td>${renderInline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>';
      continue;
    }
    // 段落：合并连续普通文本行
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim()
      && !/^(#{1,4}\s|[-*+]\s|\d+[.、]\s|>|```|\s*[-*]{3,})/.test(lines[i])
      && !(lines[i].includes('|') && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] || ''))) {
      para.push(lines[i]); i++;
    }
    html += `<p>${renderInline(para.join('<br>'))}</p>`;
  }
  return html;
}
function renderMarkdown(text) {
  const t = String(text || '');
  let html = '';
  const re = /```(\w*)\n?([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = re.exec(t)) !== null) {
    html += renderBlocks(t.slice(last, m.index));
    html += renderCodeBlock(m[1], m[2]);
    last = re.lastIndex;
  }
  html += renderBlocks(t.slice(last));
  return html;
}
$('#chatBox').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy-id]');
  if (btn) copyText(document.getElementById(btn.dataset.copyId).textContent);
});

/* 助手配置区 */
function checkAssistantSetup() {
  const a = lastStatus && lastStatus.assistant;
  const setup = $('#assistantSetup'), main = $('#assistantMain');
  if (a && a.baseUrl) {
    setup.classList.add('hidden');
    main.classList.remove('hidden');
  } else {
    setup.classList.remove('hidden');
    main.classList.add('hidden');
    $('#asBaseUrl').value = a ? a.baseUrl : '';
    $('#asModel').value = a ? a.model : '';
  }
}
$('#assistantConfigBtn').onclick = () => {
  $('#assistantSetup').classList.remove('hidden');
  const a = lastStatus && lastStatus.assistant;
  if (a) { $('#asBaseUrl').value = a.baseUrl || ''; $('#asModel').value = a.model || ''; }
};
$('#asFetchModels').onclick = async () => {
  const btn = $('#asFetchModels');
  btn.disabled = true;
  try {
    const r = await api('/admin/api/probe-models', { method: 'POST', body: { baseUrl: $('#asBaseUrl').value.trim(), key: $('#asKey').value.trim() } });
    if (r.ok) {
      $('#asModel').innerHTML = r.models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
      toast(`获取到 ${r.count} 个模型`, 'ok');
    } else toast(r.error || r.err, 'err');
  } catch (e) { toast(e.message, 'err'); }
  btn.disabled = false;
};
$('#asSave').onclick = async () => {
  const model = $('#asModel').value;
  if (!model) { toast('请先拉取并选择模型', 'err'); return; }
  try {
    await api('/admin/api/settings', {
      method: 'PUT',
      body: { assistant: { baseUrl: $('#asBaseUrl').value.trim(), key: $('#asKey').value.trim(), model } },
    });
    toast('助手 API 已保存', 'ok');
    await refreshStatus();
    checkAssistantSetup();
  } catch (e) { toast(e.message, 'err'); }
};

// 从 URL 提取站名：取域名里最有辨识度的一段（跳过 api/www/v1 等通用前缀），
// 避免 api.xiaomimimo.com、api.openai.com 都被取成 "api" 而重名
function extractName(url) {
  const m = String(url || '').match(/https?:\/\/([^\/]+)/);
  if (!m) return 'new-site';
  const parts = m[1].split('.').filter(Boolean);
  if (parts.length <= 1) return parts[0] || 'new-site';
  const generic = new Set(['api', 'www', 'app', 'gateway', 'gw', 'proxy', 'openai', 'v1', 'chat']);
  // 去掉末尾 TLD（com/cn/net/org/io/ai 等），从剩余里挑第一个非通用词
  const tlds = new Set(['com', 'cn', 'net', 'org', 'io', 'ai', 'co', 'top', 'app', 'dev', 'xyz']);
  const body = parts[parts.length - 1] && tlds.has(parts[parts.length - 1]) ? parts.slice(0, -1) : parts;
  const pick = body.find(x => !generic.has(x.toLowerCase()));
  return pick || body[body.length - 1] || body[0] || 'new-site';
}

// 发送对话
let assistantBusy = false;
$('#chatSend').onclick = () => {
  if (assistantAbort) { assistantAbort.abort(); return; } // 流式中点击 = 停止
  sendChat();
};
$('#chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendChat();
});

async function sendChat() {
  if (assistantBusy) { toast('助手正在回复，请稍候', ''); return; }
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  // 多标签页同步：发送前重读最新聊天记录与 keyMap（另一标签页可能已更新）
  try {
    chatStore = JSON.parse(localStorage.getItem(CHAT_KEY) || '[]');
    keyMap = JSON.parse(localStorage.getItem(KEYMAP_KEY) || '{}');
  } catch (e) {}
  input.value = '';
  $('#keyProtectNote').classList.add('hidden');
  toolDepth = 0; // 重置工具调用深度

  const { masked, found } = maskKeys(text);
  chatStore.push({ role: 'user', content: masked });
  renderChat();

  // 自动探测模型列表（消息含地址和 key 时）
  let finalText = masked;
  const urlMatch = masked.match(/https?:\/\/[^\s，,、'"）)\]}]+/);
  if (urlMatch && found.length) {
    chatStore.push({ role: 'sysline', content: `🔍 正在自动探测 ${urlMatch[0]} 支持的模型…` });
    renderChat();
    const probeBase = urlMatch[0];
    try {
      const r = await api('/admin/api/probe-models', { method: 'POST', body: { baseUrl: probeBase, key: found[0] } });
      if (r.ok) {
        // 直接弹应用确认框（跳过 AI 对话，一步到位）
        openModal(`
          <h3>➕ 新增中转站 — ${escapeHtml(extractName(probeBase))}</h3>
          <div class="form-grid">
            <label>站名<input id="amName" value="${escapeHtml(extractName(probeBase))}" placeholder="唯一标识名"></label>
            <label>地址<input id="amBase" value="${escapeHtml(probeBase)}" readonly class="input"></label>
            <label>API Key<input id="amKey" type="password" value="${escapeHtml(found[0])}" readonly class="input"></label>
            <label>模型（勾选要添加的，${r.count} 个声明）
              <div id="amModels" style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:6px">
                ${r.models.map(m => `<label style="display:block;margin:2px 0"><input type="checkbox" class="am-model" checked value="${escapeHtml(m)}"> ${escapeHtml(m)}</label>`).join('')}
              </div>
            </label>
          </div>
          <div class="m-actions">
            <button class="btn" id="amCancel">取消</button>
            <button class="btn primary" id="amConfirm">确认添加</button>
          </div>`);
        $('#amCancel').onclick = closeModal;
        $('#amConfirm').onclick = async () => {
          const models = [...document.querySelectorAll('.am-model:checked')].map(c => c.value);
          if (!models.length) { toast('请至少勾选一个模型', 'err'); return; }
          const name = $('#amName').value.trim();
          if (!name) { toast('请输入站名', 'err'); return; }
          try {
            await api('/admin/api/apply', { method: 'POST', body: { ops: [{ action: 'add', provider: { name, baseUrl: probeBase, key: found[0], models, aliases: {} } }], source: '手动' } });
            toast(`✅ 已添加 ${name}（${models.length} 个模型）`, 'ok');
            closeModal();
            refreshStatus();
          } catch (e) { toast(e.message, 'err'); }
        };
        // 不再继续发给 AI 对话
        return;
      } else {
        chatStore.push({ role: 'sysline', content: `❌ 探测失败：${r.error || r.err}` });
        finalText = masked + `\n\n[系统自动探测失败：${r.error || r.err}，请如实告知用户并让其检查地址/key，禁止编造模型列表]`;
      }
    } catch (e) {
      chatStore.push({ role: 'sysline', content: `❌ 探测失败：${e.message}` });
    }
    // 把末条 user 消息替换为带探测注记的版本（AI 需要）
    for (let i = chatStore.length - 1; i >= 0; i--) {
      if (chatStore[i].role === 'user') { chatStore[i].content = finalText; break; }
    }
    renderChat();
  }

  if (found.length) {
    $('#keyProtectNote').textContent = `🔒 已检测到 ${found.length} 处 key，已替换为占位符保护（真实 key 仅保存在本页）`;
    $('#keyProtectNote').classList.remove('hidden');
  }

  // 流式请求（抽成 streamAssistant，供工具循环复用）
  assistantBusy = true;
  const sendBtn = $('#chatSend');
  sendBtn.textContent = '⏹ 停止';
  sendBtn.classList.add('btn-stop'); // 流式期间可点击停止（入口 handler 检测 assistantAbort）
  const history = chatStore.filter(m => m.role === 'user' || m.role === 'assistant').slice(-20);
  const fullText = await streamAssistant(history);
  sendBtn.textContent = '发送';
  sendBtn.classList.remove('btn-stop');
  sendBtn.disabled = true; // 后处理（工具执行/提案）期间禁用
  await handleAssistantReply(fullText);
  sendBtn.disabled = false;
  assistantBusy = false;
  maybeAutoConsolidate(); // 每满10轮后台自动巩固记忆（海马体）
}

/* 海马体记忆巩固：把对话总结成日记 + 提取长期记忆 */
let lastConsolidatedIndex = 0; // 已巩固到的 chatStore 索引（只总结新增对话，防重复）
async function consolidateChat(history, silent) {
  try {
    const r = await api('/admin/api/consolidate', { method: 'POST', body: { history } });
    if (r.ok) {
      if (silent) {
        chatStore.push({ role: 'sysline', content: `🧠 已自动巩固记忆（长期记忆 +${r.longtermAdded}）` });
      } else {
        toast(`已总结进记忆库：日记 +${r.diaryAdded}，长期记忆 +${r.longtermAdded}`, 'ok');
      }
      return true;
    }
    if (!silent) toast(r.error || '总结失败', 'err');
  } catch (e) {
    if (!silent) toast('总结失败：' + e.message, 'err');
  }
  return false;
}
function maybeAutoConsolidate() {
  const newMsgs = chatStore.slice(lastConsolidatedIndex).filter(m => m.role === 'user' || m.role === 'assistant');
  // 只统计「真实用户发言」：工具执行结果虽然以 user 角色注入（便于回传给 AI），但不是用户说的话，
  // 不能计入巩固触发计数——否则用户一句话触发 2-3 次工具往返就被当成 6 轮，过早巩固几乎没内容的对话
  const newUserCount = chatStore.slice(lastConsolidatedIndex)
    .filter(m => m.role === 'user' && !String(m.content).startsWith('[系统工具结果]')).length;
  // 满 6 轮真实用户发言即巩固一次（原为 10，偏晚：长对话里前面的要点容易被 20 条历史窗口挤掉没记进记忆）
  if (newUserCount >= 6) {
    lastConsolidatedIndex = chatStore.length; // 先记索引，防并发重复触发
    consolidateChat(newMsgs, true).then(ok => {
      if (ok) { persistChat(); renderChat(); refreshMemory(); }
      else { lastConsolidatedIndex = Math.max(0, chatStore.length - newMsgs.length); } // 失败回退索引，下轮重试
    });
  }
}

// 发起一轮助手对话（流式渲染到新 assistant 消息），返回完整回复文本
// 中断时返回值末尾带 [[INTERRUPTED]] 标记（调用方据此跳过块解析）
let assistantAbort = null;
async function streamAssistant(history) {
  const aiMsg = { role: 'assistant', content: '' };
  chatStore.push(aiMsg);
  renderChat();
  assistantAbort = new AbortController();
  let interrupted = false;
  try {
    const resp = await fetch('/admin/api/assistant', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history }),
      signal: assistantAbort.signal,
    });
    setConn(true);
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      aiMsg.content = `⚠️ ${j.error || '请求失败（HTTP ' + resp.status + '）'}`;
    } else {
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            const delta = j.choices && j.choices[0] && j.choices[0].delta;
            if (delta && delta.content) aiMsg.content += delta.content;
          } catch (e) {}
        }
        scheduleRender();
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      interrupted = true;
      aiMsg.content += '\n\n⏹ 已停止';
    } else {
      aiMsg.content = `⚠️ 助手连接失败：${e.message}`;
      setConn(false);
    }
  }
  assistantAbort = null;
  persistChat();
  renderChat();
  return interrupted ? aiMsg.content + '\n[[INTERRUPTED]]' : aiMsg.content;
}

/* 从文本里扫出所有「完整平衡」的 JSON 对象（跳过字符串内的花括号，容忍嵌套/转义）。
   比正则 [^}]* 稳健：工具参数带嵌套对象或值里含 } 时不会被截断。*/
function scanJsonObjects(text) {
  const out = [];
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) break; // 未闭合：后面不会再有完整对象
    const chunk = s.slice(i, end + 1);
    try { out.push({ obj: JSON.parse(chunk), raw: chunk }); } catch (e) {}
    i = end; // 跳过已消费部分
  }
  return out;
}

/* 回复后处理：记忆块 + 工具块（可多个） + 提案卡 */
async function handleAssistantReply(fullText) {
  // 中断的半截回复不解析块（防误存记忆/误弹提案）
  if (fullText.includes('[[INTERRUPTED]]')) return;

  const objs = scanJsonObjects(fullText);

  // 记忆块：{"memory":{"remember":"..."}}（引号安全，不再要求独占一行）
  for (const { obj } of objs) {
    const remember = obj && obj.memory && obj.memory.remember;
    if (remember) {
      try {
        await api('/admin/api/memory', { method: 'PUT', body: { op: 'addPreference', text: String(remember) } });
        chatStore.push({ role: 'sysline', content: `🧠 助手记住了：「${remember}」` });
        renderChat();
      } catch (e) {}
      break; // 每轮最多存一条
    }
  }

  // 工具块：{"tool":"..."}（支持一轮里多个工具，按出现顺序依次执行）
  const toolObjs = objs.filter(({ obj }) => obj && typeof obj.tool === 'string');
  if (toolObjs.length) {
    for (const { obj } of toolObjs) {
      const handler = toolHandlers[obj.tool];
      if (handler) {
        await handler(obj);
      } else {
        chatStore.push({ role: 'sysline', content: `⚠️ 未知工具：${obj.tool}` });
        renderChat();
      }
    }
    return; // 工具执行后由 runTool 内部回传结果续聊，不再解析提案
  }

  // json 提案块（支持多个）
  const blocks = [];
  const re = /```json\s*\n?([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(fullText)) !== null) blocks.push(m[1]);
  const ops = [];
  for (const b of blocks) {
    try {
      const j = JSON.parse(b);
      if (Array.isArray(j)) ops.push(...j);
      else if (j && j.action) ops.push(j);
    } catch (e) {}
  }
  if (ops.length) {
    await addProposals(ops);
  }
}

/* 工具：sleep 供探测等使用（稳定性测试已下线，改由真实使用数据推荐） */
function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

/* 通用工具执行：取结果 → 回传给 AI 总结（带递归深度限制） */
let toolDepth = 0;
async function runTool(label, fetchResult) {
  if (toolDepth >= 6) {
    chatStore.push({ role: 'sysline', content: '⚠️ 工具调用过多已停止，请改用手动操作' });
    renderChat();
    return;
  }
  toolDepth++;
  chatStore.push({ role: 'sysline', content: `🔧 ${label}…` });
  renderChat();
  try {
    const result = await fetchResult();
    chatStore.push({ role: 'user', content: `[系统工具结果] ${result}` });
    renderChat();
    const history = chatStore.filter(m => m.role === 'user' || m.role === 'assistant').slice(-20);
    const full = await streamAssistant(history);
    await handleAssistantReply(full);
  } catch (e) {
    chatStore.push({ role: 'sysline', content: `❌ ${label}失败：${e.message}` });
    renderChat();
  }
  toolDepth--;
}

async function runStatusTool() {
  await runTool('正在查看服务状态', async () => {
    const s = await api('/admin/api/status');
    const lines = [`服务已运行 ${fmtDur(s.uptime)}，${s.providers.length} 个站，${s.models.length} 个可用模型`];
    const bad = s.providers.filter(p => p.probe && !p.probe.busy && !p.probe.ok);
    lines.push(bad.length ? `不可用站：${bad.map(p => `${p.name}（${p.probe.err}）`).join('、')}` : '所有站探活正常');
    const rec = s.recommended || [];
    if (rec.length) lines.push(`推荐模型：${rec.map(r => `${r.alias}（${r.note}）`).join('、')}`);
    return lines.join('\n');
  });
}

async function runProbeTool() {
  await runTool('正在探测全部站点', async () => {
    await api('/admin/api/probe', { method: 'POST', body: { name: 'all' } });
    // 轮询直到所有站探完（busy 全部消失）或超时 25s，替代固定 sleep 9s（站少不空等、站多不早退）
    let s;
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      s = await api('/admin/api/status');
      if (!s.providers.some(p => p.probe && p.probe.busy)) break;
    }
    return s.providers.map(p => {
      const pr = p.probe;
      const st = !pr ? '未测' : pr.busy ? '探测中' : pr.ok ? `通（${pr.ms}ms）` : `不通（${pr.err}）`;
      return `${p.name}：${st}`;
    }).join('\n');
  });
}

async function runTestTool(args) {
  const name = args && args.name;
  if (!name) {
    chatStore.push({ role: 'sysline', content: '⚠️ 请指定站名，如 {"tool":"test","name":"modelscope"}' });
    renderChat();
    return;
  }
  await runTool(`正在测试 ${name}`, async () => {
    const r = await api('/admin/api/test', { method: 'POST', body: { name } });
    return r.ok ? `${name} 连通，延迟 ${r.ms}ms` : `${name} 不通：${r.err}`;
  });
}

async function runStatsTool(args) {
  const range = (args && args.range) || 'today';
  await runTool(`正在查询用量统计（${range}）`, async () => {
    const s = await api('/admin/api/stats?range=' + range);
    const byProvider = Object.entries(s.byProvider).map(([n, c]) => {
      const rate = c.reqs ? `${Math.round(c.ok / c.reqs * 100)}%` : '-';
      const avg = c.reqs ? `${Math.round(c.ms / c.reqs)}ms` : '-';
      return `${n}：${c.reqs}次 成功率${rate} 平均${avg}`;
    }).join('；');
    const rate = s.clientReqs ? `${Math.round(s.clientOk / s.clientReqs * 100)}%` : '-';
    return `客户端请求 ${s.clientReqs} 次，成功率 ${rate}\n${byProvider || '暂无数据'}`;
  });
}

async function runLogsTool(args) {
  const n = (args && args.n) || 30;
  await runTool('正在查看最近日志', async () => {
    const r = await api('/admin/api/logs?cursor=0');
    const items = r.items.slice(-n);
    return items.map(l => `[${fmtClock(l.t)}] ${l.line}`).join('\n') || '暂无日志';
  });
}

async function runPriorityTool(args) {
  const { name, action } = args || {};
  if (!name || !action) {
    chatStore.push({ role: 'sysline', content: '⚠️ 需要站名和方向，如 {"tool":"priority","name":"modelscope","action":"top"}' });
    renderChat();
    return;
  }
  await runTool(`正在调整 ${name} 优先级（${action}）`, async () => {
    const r = await api('/admin/api/priority', { method: 'POST', body: { name, action } });
    return `已调整，当前优先级顺序：${r.priority.join(' → ')}`;
  });
}

async function runToggleTool(args) {
  const { name, enabled } = args || {};
  if (!name || typeof enabled !== 'boolean') {
    chatStore.push({ role: 'sysline', content: '⚠️ 需要站名和 enabled，如 {"tool":"toggle","name":"modelscope","enabled":false}' });
    renderChat();
    return;
  }
  await runTool(`正在${enabled ? '启用' : '停用'} ${name}`, async () => {
    await api('/admin/api/toggle-provider', { method: 'POST', body: { name, enabled } });
    return `${name} 已${enabled ? '启用' : '停用'}`;
  });
}

const toolHandlers = {
  'check': runCheckTool,
  'status': runStatusTool,
  'probe': runProbeTool,
  'test': runTestTool,
  'stats': runStatsTool,
  'logs': runLogsTool,
  'priority': runPriorityTool,
  'toggle': runToggleTool,
};

// 灵活检测：type=model 测某模型在各站真实可用性；type=site 测站点连通
async function runCheckTool(args) {
  const { type, target } = args || {};
  if (!target) {
    chatStore.push({ role: 'sysline', content: '⚠️ 需要检测目标，如 {"tool":"check","type":"model","target":"glm-5.2"}' });
    renderChat();
    return;
  }
  await runTool(`正在检测${type === 'model' ? '模型 ' : '站点 '}${target}`, async () => {
    const r = await api('/admin/api/check', { method: 'POST', body: { type: type || 'site', target } });
    if (r.type === 'model') {
      const lines = r.results.map(x => `${x.provider}：已配置（真实模型 ${x.realModel}${x.note ? '，' + x.note : ''}）`);
      return `模型 ${target} 配置在 ${r.results.length} 个站：\n${lines.join('\n')}`;
    }
    return r.ok ? `站点 ${target} 连通，延迟 ${r.ms}ms` : `站点 ${target} 不通：${r.err}`;
  });
}

/* 提案渲染与应用 */
function normUrl(u) { return String(u || '').trim().replace(/\/+$/, '').toLowerCase(); }
async function addProposals(ops) {
  // baseUrl 幻觉校验：必须出现在用户历史消息中
  const userTexts = chatStore.filter(x => x.role === 'user').map(x => x.content).join('\n');
  let providersNow = [];
  try { providersNow = (await api('/admin/api/providers')).list; } catch (e) {}

  const box = $('#chatBox');
  for (const op of ops) {
    const p = op.provider || {};
    const exists = providersNow.find(x => x.name === p.name);
    // baseUrl 幻觉校验：出现在用户消息中 OK；或与「已存在同名站」的现有 baseUrl 一致也 OK
    // （update/delete 已有站时，AI 按协议回带原 baseUrl，它本就不在本轮聊天里，不能当编造拦掉——否则改别名/改模型全被禁用）
    const urlOk = !p.baseUrl
      || userTexts.includes(p.baseUrl)
      || userTexts.includes(p.baseUrl.replace(/\/+$/, ''))
      || (exists && normUrl(exists.baseUrl) === normUrl(p.baseUrl));
    const card = document.createElement('div');
    card.className = 'proposal';
    card.dataset.name = p.name || '';
    const models = Array.isArray(p.models) ? p.models : [];
    const modelChecks = models.length > 50
      ? `<div class="hint">模型较多（${models.length} 个），默认全选</div><div class="model-checks" data-expanded="0" style="display:none">${models.map((mm, i) => `<label><input type="checkbox" class="pm" checked value="${escapeHtml(mm)}">${escapeHtml(mm)}</label>`).join('')}</div><button class="btn sm" data-expand="1">显示全部模型</button>`
      : models.map(mm => `<label><input type="checkbox" class="pm" checked value="${escapeHtml(mm)}">${escapeHtml(mm)}</label>`).join('');
    card.innerHTML = `
      <div class="p-head">
        <b>${op.action === 'add' ? '➕ 新增' : op.action === 'update' ? '✏️ 更新' : op.action === 'delete' ? '🗑️ 删除' : op.action}：${escapeHtml(p.name || '?')}</b>
        ${exists && op.action === 'add' ? '<span class="diff-warn">⚠️ 已存在同名站</span>' : ''}
        ${!urlOk ? '<span class="diff-warn">⚠️ 地址不在你发送的内容中（疑似编造），禁止应用</span>' : ''}
      </div>
      <div class="p-body">
        ${p.baseUrl ? `<div>地址：<span class="mono">${escapeHtml(p.baseUrl)}</span></div>` : ''}
        ${p.key ? `<div>key：<span class="mono">${escapeHtml(p.key)}</span>（应用时自动回填真实值）</div>` : ''}
        ${models.length ? `<div style="margin-top:6px">模型（${models.length} 个，可取消勾选）：</div><div class="model-checks">${modelChecks}</div>` : ''}
        ${p.aliases && Object.keys(p.aliases).length ? `<div style="margin-top:6px">别名：${Object.entries(p.aliases).map(([k, v]) => `<span class="chip">${escapeHtml(k)} → ${escapeHtml(v)}</span>`).join('')}</div>` : ''}
        ${exists && op.action === 'update' ? diffSummary(exists, p) : ''}
      </div>
      <div class="p-actions">
        <button class="btn primary" data-apply ${(!urlOk || (exists && op.action === 'add')) ? 'disabled' : ''}>✔ 应用此变更</button>
        <button class="btn" data-ignore>✖ 忽略</button>
        <span class="hint">应用后新站优先级排最后，可到「Provider 管理」调整</span>
      </div>`;
    card._op = op;
    box.appendChild(card);
    box.scrollTop = box.scrollHeight;

    // stash 暂存（add/update）
    if ((op.action === 'add' || op.action === 'update') && p.name) {
      api('/admin/api/memory', { method: 'PUT', body: { op: 'addStash', item: { time: fmtTime(Date.now()), name: p.name, summary: `${op.action === 'add' ? '新增' : '更新'} ${p.baseUrl || ''}（${models.length} 模型）` } } }).catch(() => {});
    }
  }
}
function diffSummary(oldP, newP) {
  const fields = ['baseUrl', 'enabled'];
  const lines = [];
  for (const f of fields) {
    if (newP[f] !== undefined && String(oldP[f]) !== String(newP[f])) {
      lines.push(`<div>${f}：<span class="diff-del">${escapeHtml(oldP[f])}</span> → <span class="diff-add">${escapeHtml(newP[f])}</span></div>`);
    }
  }
  const om = (oldP.models || []).join(',');
  const nm = (newP.models || []).join(',');
  if (om !== nm) {
    const added = (newP.models || []).filter(x => !(oldP.models || []).includes(x));
    const removed = (oldP.models || []).filter(x => !(newP.models || []).includes(x));
    if (added.length) lines.push(`<div>新增模型：<span class="diff-add">${added.map(escapeHtml).join('、')}</span></div>`);
    if (removed.length) lines.push(`<div>移除模型：<span class="diff-del">${removed.map(escapeHtml).join('、')}</span></div>`);
  }
  return lines.length ? `<div style="margin-top:8px;border-top:1px dashed var(--border);padding-top:6px">${lines.join('')}</div>` : '';
}

$('#chatBox').addEventListener('click', async (e) => {
  const expandBtn = e.target.closest('[data-expand]');
  if (expandBtn) {
    const box2 = expandBtn.closest('.p-body').querySelector('.model-checks[data-expanded]');
    box2.style.display = 'block';
    expandBtn.remove();
    return;
  }
  const btn = e.target.closest('button[data-apply], button[data-ignore]');
  if (!btn) return;
  const card = btn.closest('.proposal');
  const op = card._op;
  if (btn.dataset.ignore !== undefined) {
    const name = card.dataset.name;
    card.remove();
    if (name) {
      try {
        const mem = await api('/admin/api/memory');
        const idx = mem.stash.findIndex(s => s.name === name);
        if (idx >= 0) await api('/admin/api/memory', { method: 'PUT', body: { op: 'delStash', index: idx } });
      } catch (err) {}
    }
    return;
  }
  // 应用
  btn.disabled = true;
  btn.textContent = '应用中…';
  // 多标签页同步：应用前重读最新 keyMap（另一标签页可能刚保存过 key）
  try { keyMap = JSON.parse(localStorage.getItem(KEYMAP_KEY) || '{}'); } catch (e) {}
  const finalOp = JSON.parse(JSON.stringify(op));
  if (finalOp.provider) {
    finalOp.provider.key = fillKeys(finalOp.provider.key);
    const checked = [...card.querySelectorAll('.pm:checked')].map(c => c.value);
    if (checked.length && Array.isArray(finalOp.provider.models)) finalOp.provider.models = checked;
  }
  try {
    const r = await api('/admin/api/apply', { method: 'POST', body: { ops: [finalOp], source: 'AI' } });
    toast(`已应用：${r.applied.join('；')}（约 2 秒后热加载生效）`, 'ok');
    if (r.skipped && r.skipped.length) toast(`跳过：${r.skipped.join('；')}`, 'err');
    const name = finalOp.provider && finalOp.provider.name;
    const actions = card.querySelector('.p-actions');
    actions.innerHTML = `<span class="diff-add">✔ 已应用</span> <button class="btn sm" data-testnow="${escapeHtml(name || '')}">立即测试</button> <span class="hint">配置热加载约 2 秒后生效</span>`;
  } catch (err) {
    toast(err.message, 'err');
    btn.disabled = false;
    btn.textContent = '✔ 应用此变更';
  }
});
$('#chatBox').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-testnow]');
  if (!btn) return;
  btn.disabled = true; btn.textContent = '测试中…';
  try {
    const r = await api('/admin/api/test', { method: 'POST', body: { name: btn.dataset.testnow } });
    toast(r.ok ? `✅ ${r.name} 连通（${r.ms}ms）` : `❌ ${r.name}：${r.err}`, r.ok ? 'ok' : 'err');
  } catch (err) { toast(err.message, 'err'); }
  btn.textContent = '测试'; btn.disabled = false;
});

/* 手动 JSON 兜底 */
// 清空会话：先总结进记忆库，再清空聊天记录
$('#clearChatBtn').onclick = async () => {
  const history = chatStore.filter(m => m.role === 'user' || m.role === 'assistant');
  if (!history.length) { toast('当前没有对话', ''); return; }
  if (!(await confirmDlg('清空会话', '将把当前对话总结进记忆库（日记+长期记忆），然后清空聊天记录。确定？', false))) return;
  toast('正在总结进记忆库…');
  const ok = await consolidateChat(history, false);
  if (ok) {
    chatStore = [];
    lastConsolidatedIndex = 0;
    persistChat();
    renderChat();
    refreshMemory();
  }
};

$('#manualJsonBtn').onclick = () => {
  openModal(`
    <h3>手动应用变更 JSON</h3>
    <p class="hint">格式与助手提案一致：[{"action":"add","provider":{...}}]。此处 key 直接写明文（不经过 AI，不出境）。已有站的 key 写空串表示保持不变。</p>
    <textarea id="mjText" placeholder='[{"action":"add","provider":{"name":"myapi","baseUrl":"https://...","key":"sk-xxx","models":["m1"],"aliases":{}}}]'></textarea>
    <div class="m-actions">
      <button class="btn" id="mjCancel">取消</button>
      <button class="btn primary" id="mjApply">应用</button>
    </div>`);
  $('#mjCancel').onclick = closeModal;
  $('#mjApply').onclick = async () => {
    let ops;
    try { ops = JSON.parse($('#mjText').value); } catch (e) { toast('JSON 解析失败：' + e.message, 'err'); return; }
    if (!Array.isArray(ops)) ops = [ops];
    try {
      const r = await api('/admin/api/apply', { method: 'POST', body: { ops, source: '手动' } });
      toast(`已应用：${r.applied.join('；')}`, 'ok');
      closeModal();
    } catch (err) { toast(err.message, 'err'); }
  };
};

/* 记忆面板 */
async function refreshMemory() {
  try {
    const mem = await api('/admin/api/memory');
    const prefs = (mem.preferences || []).map((p, i) => `
      <div class="mem-item"><span>${escapeHtml(p)}</span>
        <span><button class="btn sm" data-editpref="${i}">改</button> <button class="btn sm danger" data-delpref="${i}">删</button></span>
      </div>`).join('') || '<span class="hint">暂无（告诉助手"记住…"即可保存）</span>';
    const stash = (mem.stash || []).map((s, i) => `
      <div class="mem-item"><span>${escapeHtml(s.time)} ${escapeHtml(s.summary)}</span>
        <button class="btn sm danger" data-delstash="${i}">删</button></div>`).join('') || '<span class="hint">暂无暂存资源</span>';
    const changes = (mem.changelog || []).slice(-15).reverse().map(c => `
      <div class="mem-item"><span>[${escapeHtml(c.source)}] ${escapeHtml(c.detail)}</span><span class="hint">${escapeHtml(c.time)}</span></div>`).join('') || '<span class="hint">暂无变更记录</span>';
    const diary = (mem.diary || []).map((d, i) => `
      <div class="mem-item"><span><b>${escapeHtml(d.summary)}</b>${d.keypoints && d.keypoints.length ? '<br><span class="hint">' + d.keypoints.map(escapeHtml).join('；') + '</span>' : ''}</span>
        <span><span class="hint">${escapeHtml(d.time)}</span> <button class="btn sm danger" data-deldiary="${i}">删</button></span></div>`).join('') || '<span class="hint">暂无日记（对话满10轮或清空会话时自动生成）</span>';
    const longterm = (mem.longterm || []).map((l, i) => `
      <div class="mem-item"><span><span class="tag tag-warn">${escapeHtml(l.category || '事实')}</span> ${escapeHtml(l.fact)}</span>
        <button class="btn sm danger" data-dellongterm="${i}">删</button></div>`).join('') || '<span class="hint">暂无长期记忆（从对话自动提取）</span>';
    $('#memoryPanel').innerHTML = `
      <details class="mem-collapse">
        <summary>🧠 长期记忆（${(mem.longterm || []).length}）</summary>
        <div class="mem-body">${longterm}</div>
      </details>
      <details class="mem-collapse">
        <summary>📔 日记（${(mem.diary || []).length}）</summary>
        <div class="mem-body">${diary}</div>
      </details>
      <details class="mem-collapse">
        <summary>偏好记忆（${(mem.preferences || []).length}）</summary>
        <div class="mem-body">${prefs}</div>
      </details>
      <details class="mem-collapse">
        <summary>未应用资源（${(mem.stash || []).length}）</summary>
        <div class="mem-body">${stash}</div>
      </details>
      <details class="mem-collapse">
        <summary>变更历史（${(mem.changelog || []).length}）</summary>
        <div class="mem-body">${changes}</div>
      </details>
      <button class="btn sm danger" id="memClear">清空全部记忆</button>`;
    $('#memClear').onclick = async () => {
      if (!(await confirmDlg('清空记忆', '确定清空全部记忆（偏好/暂存/变更历史）？', true))) return;
      await api('/admin/api/memory', { method: 'PUT', body: { op: 'clearAll' } });
      refreshMemory();
    };
  } catch (e) {
    $('#memoryPanel').textContent = '加载失败：' + e.message;
  }
}
$('#tab-assistant').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (btn.dataset.delpref !== undefined) {
    await api('/admin/api/memory', { method: 'PUT', body: { op: 'delPreference', index: parseInt(btn.dataset.delpref, 10) } }).catch(() => {});
    refreshMemory();
  } else if (btn.dataset.editpref !== undefined) {
    const i = parseInt(btn.dataset.editpref, 10);
    const mem = await api('/admin/api/memory');
    const old = mem.preferences[i];
    const nv = prompt('编辑偏好记忆：', old);
    if (nv !== null && nv.trim()) {
      await api('/admin/api/memory', { method: 'PUT', body: { op: 'editPreference', index: i, text: nv.trim() } });
      refreshMemory();
    }
  } else if (btn.dataset.delstash !== undefined) {
    await api('/admin/api/memory', { method: 'PUT', body: { op: 'delStash', index: parseInt(btn.dataset.delstash, 10) } }).catch(() => {});
    refreshMemory();
  } else if (btn.dataset.deldiary !== undefined) {
    await api('/admin/api/memory', { method: 'PUT', body: { op: 'delDiary', index: parseInt(btn.dataset.deldiary, 10) } }).catch(() => {});
    refreshMemory();
  } else if (btn.dataset.dellongterm !== undefined) {
    await api('/admin/api/memory', { method: 'PUT', body: { op: 'delLongterm', index: parseInt(btn.dataset.dellongterm, 10) } }).catch(() => {});
    refreshMemory();
  }
});

/* ============ 统计 ============ */
let statsRange = 'today';
$('#statsRange').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  statsRange = btn.dataset.range;
  $$('#statsRange button').forEach(b => b.classList.toggle('active', b === btn));
  refreshStats();
});
$('#statsRefresh').onclick = refreshStats;

function statsTable(map) {
  const names = Object.keys(map);
  if (!names.length) return '<tbody><tr><td class="hint">暂无数据，发几个请求后自动统计</td></tr></tbody>';
  const rows = names.map(n => {
    const c = map[n];
    const rate = c.reqs ? Math.round(c.ok / c.reqs * 100) : 0;
    const avg = c.reqs ? Math.round(c.ms / c.reqs) : 0;
    return `<tr><td>${escapeHtml(n)}</td><td>${c.reqs}</td><td>${c.ok}</td><td>${c.fail}</td><td>${rate}%</td><td>${avg}ms</td><td>${c.tin || '-'}</td><td>${c.tout || '-'}</td><td>${c.cached ? fmtTokens(c.cached) : '-'}</td></tr>`;
  }).join('');
  return `<thead><tr><th>名称</th><th>请求数</th><th>成功</th><th>失败</th><th>成功率</th><th>平均延迟</th><th>输入token</th><th>输出token</th><th>缓存命中</th></tr></thead><tbody>${rows}</tbody>`;
}

/* 模型用量环形图（Token 占比，纯 CSS conic-gradient 零依赖）
   数据无变化时不重建 DOM（轮询调用防卡顿） */
const DONUT_COLORS = ['#2962b9', '#1e8e4e', '#8e44ad', '#c62838', '#e67e22', '#00838f', '#b8860b', '#5d4037', '#607d8b'];
let lastDonutKey = '';
function fmtTokens(n) {
  if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
  return String(Math.round(n));
}
function renderModelDonut(byModel) {
  const box = $('#modelDonut');
  const items = Object.entries(byModel || {})
    .map(([m, c]) => ({ m, tokens: (c.tin || 0) + (c.tout || 0) }))
    .filter(x => x.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  const total = items.reduce((s, x) => s + x.tokens, 0);
  const cachedTotal = Object.values(byModel || {}).reduce((s, c) => s + (c.cached || 0), 0);
  const key = total + ':' + cachedTotal + ':' + items.map(x => `${x.m}=${x.tokens}`).join(',');
  if (key === lastDonutKey) return; // 数据没变，跳过重建
  lastDonutKey = key;
  if (!total) {
    box.innerHTML = '<div class="hint">暂无 Token 数据，发几个请求后自动生成占比图</div>';
    return;
  }
  const top = items.slice(0, 8);
  const restTokens = items.slice(8).reduce((s, x) => s + x.tokens, 0);
  const segs = top.map((x, i) => ({ ...x, color: DONUT_COLORS[i] }));
  if (restTokens > 0) segs.push({ m: '其他模型', tokens: restTokens, color: DONUT_COLORS[8] });
  let acc = 0;
  const gradient = segs.map(sg => {
    const from = (acc / total) * 100;
    acc += sg.tokens;
    return `${sg.color} ${from.toFixed(2)}% ${(acc / total * 100).toFixed(2)}%`;
  }).join(', ');
  const listHtml = segs.map(sg => `
    <div class="donut-item">
      <span class="swatch" style="background:${sg.color}"></span>
      <span class="mname">${escapeHtml(sg.m)}</span>
      <span class="mval">${fmtTokens(sg.tokens)} tokens</span>
      <span class="mpct">${(sg.tokens / total * 100).toFixed(1)}%</span>
    </div>`).join('');
  box.innerHTML = `
    <div class="donut" style="background:conic-gradient(${gradient})">
      <div class="donut-center"><div class="num">${fmtTokens(total)}</div><div class="unit">计费 token${cachedTotal ? `<br>缓存命中 ${fmtTokens(cachedTotal)}` : ''}</div></div>
    </div>
    <div class="donut-list">${listHtml}</div>`;
}
async function refreshStats() {
  try {
    const s = await api('/admin/api/stats?range=' + statsRange);
    renderModelDonut(s.byModel);
    $('#statsProviderTable').innerHTML = statsTable(s.byProvider);
    $('#statsModelTable').innerHTML = statsTable(s.byModel);
    const rate = s.clientReqs ? Math.round(s.clientOk / s.clientReqs * 100) : 0;
    const hist = (s.history || []).map(h => `<tr>
      <td>${fmtClock(h.t)}</td><td class="mono">${escapeHtml(h.model)}</td><td>${escapeHtml(h.provider)}</td>
      <td>${h.ms}ms</td><td>${h.code}</td><td>${h.ok ? '✅' : '❌'}</td><td>${h.stream ? '流式' : ''}</td></tr>`).join('');
    $('#historyTable').innerHTML = `<thead><tr><th>时间</th><th>模型</th><th>站点</th><th>耗时</th><th>状态码</th><th>结果</th><th>方式</th></tr></thead>
      <tbody>${hist || '<tr><td class="hint">暂无请求记录</td></tr>'}</tbody>`;
  } catch (e) {}
}

/* ============ 日志 ============ */
let logCursor = 0;
let logAutoScroll = true;
$('#logAutoScroll').addEventListener('change', (e) => { logAutoScroll = e.target.checked; });
$('#logClear').onclick = () => { $('#logBox').innerHTML = ''; };
$('#logFilter').addEventListener('input', () => { renderLogBox(); });

let logItems = [];
async function pollLogs() {
  if (activeTab !== 'logs') return;
  try {
    const r = await api(`/admin/api/logs?cursor=${logCursor}`);
    if (r.items.length) {
      logItems.push(...r.items);
      if (logItems.length > 2000) logItems.splice(0, logItems.length - 2000);
      logCursor = r.cursor;
      renderLogBox();
    }
  } catch (e) {}
}
function renderLogBox() {
  const filter = $('#logFilter').value.trim().toLowerCase();
  const items = filter ? logItems.filter(l => l.line.toLowerCase().includes(filter)) : logItems;
  $('#logBox').innerHTML = items.map(l => {
    const cls = /❌|💥|失败/.test(l.line) ? 'err' : /⚠️|🔄/.test(l.line) ? 'warn' : '';
    return `<div class="log-line ${cls}">[${fmtClock(l.t)}] ${escapeHtml(l.line)}</div>`;
  }).join('');
  const box = $('#logBox');
  if (logAutoScroll) box.scrollTop = box.scrollHeight;
}

/* ============ 启动 ============ */
/* SSE 实时推送：事件发生时后端主动推来，面板即时刷新（主通道；轮询降为兜底） */
function connectEvents() {
  try {
    const es = new EventSource('/admin/api/events');
    es.addEventListener('status', () => refreshStatus());
    es.addEventListener('providers', async () => {
      if (activeTab === 'providers') { await refreshStatus(); renderProviders(); }
    });
    es.addEventListener('stats', () => { if (activeTab === 'stats') refreshStats(); });
    es.addEventListener('memory', () => { if (activeTab === 'assistant') refreshMemory(); });
    // EventSource 断线自动重连(retry:3000)，无需手动处理
  } catch (e) {}
}
renderChat();
refreshStatus().then(() => { checkAssistantSetup(); });
connectEvents();
setInterval(async () => {           // 兜底轮询（SSE 断连时不黑屏，间隔放宽）
  await refreshStatus();
  if (activeTab === 'providers') renderProviders();
}, 15000);
setInterval(pollLogs, 2000);
setInterval(() => { if (activeTab === 'stats') refreshStats(); }, 10000);

// 总览页「测试稳定性」按钮
// 稳定性测试已下线（测活封号政策），推荐模型改由真实使用数据自动产生（见 computeRecommended）
