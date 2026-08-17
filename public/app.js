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
      <span class="mono"><button class="btn sm ghost copy-btn" data-copy="__ASKKEY__">显示</button>${s.apiKeyMasked}</span>
    </div>
    <p class="hint">ZCode / dsh 等客户端按此配置；key 点「显示」后从设置页复制完整值。</p>`;

  // 健康表
  const rows = s.providers.map(p => {
    const probe = p.probe;
    const kickTag = p.enabled === false
      ? (p.disabledBy === 'auto' ? '<span class="tag tag-bad">已踢出</span> ' : '<span class="tag tag-muted">已停用</span> ')
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
    return `<span class="chip rec-ok" title="${escapeHtml(r.note)}">⭐ ${escapeHtml(r.alias)}<span class="rec-vendor"> ${escapeHtml(r.vendor)}</span></span>`;
  }).join('');
  $('#recommendedModels').innerHTML = rec
    ? `<div class="rec-title">⭐ 推荐模型（实测通过：≥2 站冗余且 2 次全成功）</div><div>${rec}</div>`
    : `<div class="rec-title">⭐ 推荐模型</div><div class="hint">尚未测试。点「🧪 测试稳定性」按钮，或在 AI 助手对话框说「测测哪些模型稳定」，系统会实测后自动推荐。</div>`;
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
$('#tab-overview').addEventListener('click', (e) => {
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  if (btn.dataset.copy === '__ASKKEY__') { toast('完整 key 请到「Provider 管理」编辑框或 settings.json 查看', ''); return; }
  copyText(btn.dataset.copy);
});

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
        ? (p.disabledBy === 'auto' ? ' <span class="tag tag-bad">已踢出</span>' : ' <span class="tag tag-muted">已停用</span>')
        : '';
      const insecure = /^http:\/\//.test(p.baseUrl) ? ' ⚠️<span class="hint">明文</span>' : '';
      const pi = prio.indexOf(p.name);
      const sc = p.score;
      const scoreCell = sc
        ? `<span class="progress" title="${escapeHtml(sc.detail || '')}"><i class="${sc.score >= 70 ? 'p-hi' : sc.score >= 40 ? 'p-mid' : 'p-lo'}" style="--p:${Math.max(0, Math.min(100, sc.score))}%"></i></span> ${sc.score}`
        : '—';
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
  setTimeout(() => { renderProviders(); refreshStatus(); }, 6000);
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
        $('#fModels').value = r.models.join('\n');
        $('#fFetchNote').innerHTML = `✅ 获取到 <b>${r.count}</b> 个模型${r.count > 50 ? '（已全部填入，较多可手动删减）' : ''}`;
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

function renderChat() {
  const box = $('#chatBox');
  box.innerHTML = chatStore.map(m => {
    if (m.role === 'sysline') return `<div class="sysline">${escapeHtml(m.content)}</div>`;
    const body = m.role === 'assistant' ? renderMarkdown(m.content) : escapeHtml(m.content);
    return `<div class="msg ${m.role}"><div class="who">${m.role === 'user' ? '我' : '助手'}</div><div class="body">${body}</div></div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}
function renderMarkdown(text) {
  // 轻量渲染：代码块 -> pre（带复制），行内 code，加粗，其余转义
  const parts = String(text || '').split(/```(?:json)?\n?([\s\S]*?)```/g);
  let html = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const code = parts[i];
      const id = 'cp' + Math.random().toString(36).slice(2, 8);
      html += `<pre><button class="btn sm ghost copy-btn" data-copy-id="${id}">复制</button><code id="${id}">${escapeHtml(code)}</code></pre>`;
    } else {
      html += escapeHtml(parts[i])
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    }
  }
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

/* 发送对话 */
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
        const list = r.models.slice(0, 80).join('、') + (r.count > 80 ? ` …等 ${r.count} 个` : '');
        chatStore.push({ role: 'sysline', content: `✅ 已自动探测到 ${r.count} 个模型（已提供给助手）` });
        finalText = masked + `\n\n[系统自动探测] 该站支持的模型列表：${list}`;
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
        renderChat();
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

/* 回复后处理：记忆块 + 工具块 + 提案卡 */
async function handleAssistantReply(fullText) {
  // 中断的半截回复不解析块（防误存记忆/误弹提案）
  if (fullText.includes('[[INTERRUPTED]]')) return;

  // 记忆块（每轮最多1条）
  const memMatch = fullText.match(/^\{"memory":\{"remember":"(.+?)"\}\}\s*$/m);
  if (memMatch) {
    try {
      await api('/admin/api/memory', { method: 'PUT', body: { op: 'addPreference', text: memMatch[1] } });
      chatStore.push({ role: 'sysline', content: `🧠 助手记住了：「${memMatch[1]}」` });
      renderChat();
    } catch (e) {}
  }

  // 工具块（AI 要求执行本地工具，执行后回传结果再总结）
  const toolMatch = fullText.match(/\{"tool":"[a-z-]+"[^}]*\}/);
  if (toolMatch) {
    let args = {};
    try { args = JSON.parse(toolMatch[0]); } catch (e) {}
    const handler = toolHandlers[args.tool];
    if (handler) {
      await handler(args);
    } else {
      chatStore.push({ role: 'sysline', content: `⚠️ 未知工具：${args.tool || toolMatch[0]}` });
      renderChat();
    }
    return;
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

/* 工具：测试模型稳定性（AI 助手可调用） */
function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }
async function runStabilityTool() {
  chatStore.push({ role: 'sysline', content: '🧪 正在测试模型稳定性（对多站冗余模型各实测 2 次）…' });
  renderChat();
  try {
    await api('/admin/api/stability-test', { method: 'POST' });
    let r = null;
    for (let i = 0; i < 150; i++) {
      await sleep(3000);
      r = await api('/admin/api/stability-test').catch(() => null);
      if (r && !r.running) break;
    }
    if (!r || r.running) {
      chatStore.push({ role: 'sysline', content: '⚠️ 测试仍在进行，可稍后在「总览」页查看结果' });
      renderChat();
      return;
    }
    const rec = r.recommended || [];
    const summary = rec.length
      ? rec.map(x => `${x.alias}（${x.note}）`).join('；')
      : '没有任何模型通过（标准：2 次实测全成功 + 至少 2 站冗余）';
    chatStore.push({ role: 'sysline', content: rec.length ? `✅ 测试完成，推荐：${rec.map(x => '⭐ ' + x.alias).join(' ')}` : '✅ 测试完成，暂无模型通过' });
    renderChat();
    // 把结果回传给助手，让它用中文总结
    chatStore.push({ role: 'user', content: `[系统工具结果] 稳定性测试已完成。${summary}。请用中文简洁地告诉用户哪些模型最稳定、推荐用哪个。` });
    renderChat();
    const history = chatStore.filter(m => m.role === 'user' || m.role === 'assistant').slice(-20);
    const full = await streamAssistant(history);
    await handleAssistantReply(full);
  } catch (e) {
    chatStore.push({ role: 'sysline', content: `❌ 稳定性测试失败：${e.message}` });
    renderChat();
  }
}

/* 通用工具执行：取结果 → 回传给 AI 总结（带递归深度限制） */
let toolDepth = 0;
async function runTool(label, fetchResult) {
  if (toolDepth >= 3) {
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
    await sleep(9000);
    const s = await api('/admin/api/status');
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
  'stability-test': runStabilityTool,
  'status': runStatusTool,
  'probe': runProbeTool,
  'test': runTestTool,
  'stats': runStatsTool,
  'logs': runLogsTool,
  'priority': runPriorityTool,
  'toggle': runToggleTool,
};

/* 提案渲染与应用 */
async function addProposals(ops) {
  // baseUrl 幻觉校验：必须出现在用户历史消息中
  const userTexts = chatStore.filter(x => x.role === 'user').map(x => x.content).join('\n');
  let providersNow = [];
  try { providersNow = (await api('/admin/api/providers')).list; } catch (e) {}

  const box = $('#chatBox');
  for (const op of ops) {
    const p = op.provider || {};
    const exists = providersNow.find(x => x.name === p.name);
    const urlOk = !p.baseUrl || userTexts.includes(p.baseUrl) || userTexts.includes(p.baseUrl.replace(/\/+$/, ''));
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
    $('#memoryPanel').innerHTML = `
      <div class="mem-section"><h4>偏好记忆</h4>${prefs}</div>
      <div class="mem-section"><h4>未应用资源</h4>${stash}</div>
      <div class="mem-section"><h4>变更历史（最近15条）</h4>${changes}</div>
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
    return `<tr><td>${escapeHtml(n)}</td><td>${c.reqs}</td><td>${c.ok}</td><td>${c.fail}</td><td>${rate}%</td><td>${avg}ms</td><td>${c.tin || '-'}</td><td>${c.tout || '-'}</td></tr>`;
  }).join('');
  return `<thead><tr><th>名称</th><th>请求数</th><th>成功</th><th>失败</th><th>成功率</th><th>平均延迟</th><th>输入token</th><th>输出token</th></tr></thead><tbody>${rows}</tbody>`;
}

/* 模型用量环形图（Token 占比，纯 CSS conic-gradient 零依赖） */
const DONUT_COLORS = ['#2962b9', '#1e8e4e', '#8e44ad', '#c62838', '#e67e22', '#00838f', '#b8860b', '#5d4037', '#607d8b'];
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
      <div class="donut-center"><div class="num">${fmtTokens(total)}</div><div class="unit">tokens 总量</div></div>
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
renderChat();
refreshStatus().then(() => { checkAssistantSetup(); });
setInterval(refreshStatus, 5000);
setInterval(pollLogs, 2000);
setInterval(() => { if (activeTab === 'stats') refreshStats(); }, 10000);

// 总览页「测试稳定性」按钮
$('#stabilityTestBtn').onclick = async () => {
  const btn = $('#stabilityTestBtn');
  btn.disabled = true;
  btn.textContent = '测试中…';
  try {
    await api('/admin/api/stability-test', { method: 'POST' });
    for (let i = 0; i < 150; i++) {
      await sleep(3000);
      const r = await api('/admin/api/stability-test').catch(() => null);
      if (r && !r.running) break;
    }
    await refreshStatus();
    toast('稳定性测试完成', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
  btn.disabled = false;
  btn.textContent = '🧪 测试稳定性';
};
