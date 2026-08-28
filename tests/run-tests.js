/**
 * One-Relay 零依赖测试套件（node tests/run-tests.js）
 *
 * 策略：router.js 是常驻服务（require 会 listen），不能直接 require。
 * 这里用「平衡大括号扫描」从源码提取目标纯函数 + 注入 mock 上下文后 eval，
 * 对核心路由决策做断言。函数改名/删除时这里会直接报 not found，防止静默漂移。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const routerSrc = fs.readFileSync(path.join(ROOT, 'router.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

// ---------- 提取工具 ----------
function extractFn(src, name) {
  const marker = 'function ' + name + '(';
  const i = src.indexOf(marker);
  if (i < 0) throw new Error('函数未找到(可能已被改名/删除): ' + name);
  // 字符串感知的平衡扫描：跳过 ' " ` 字面量（函数体里常有 '{' '}' 字符比较，如 scanJsonObjects）
  let depth = 0, started = false, inStr = null, esc = false;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    const ch = src[k];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') { depth--; if (started && depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error('函数大括号不平衡: ' + name);
}
function extractConsts(src, prefix) {
  const re = new RegExp('(?:const|let) ' + prefix + '[A-Za-z0-9_]*\\s*=[^;\\n]+;', 'g');
  const m = src.match(re);
  if (!m || !m.length) throw new Error('常量未找到: ' + prefix + '*');
  return m.join('\n');
}

// ---------- 断言工具 ----------
let passed = 0, failed = 0;
const failures = [];
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; failures.push(`${label}\n    期望: ${e}\n    实际: ${a}`); }
}
function ok(cond, label) { if (cond) passed++; else { failed++; failures.push(label); } }

function runGroup(name, code) {
  try { eval(code); }
  catch (e) { failed++; failures.push(`[组 ${name}] 执行异常: ${e.message}`); }
}

// ================================================================
// 组1：故障转移决策 shouldFailover / isModelLevelError / isValidCompletion
// ================================================================
runGroup('failover', `
  ${extractFn(routerSrc, 'shouldFailover')}
  ${extractFn(routerSrc, 'isModelLevelError')}
  ${extractFn(routerSrc, 'isValidCompletion')}

  // 5xx 一律换站（修「裸503死磕」的核心回归点）
  eq(shouldFailover(503, ''), true, '503裸响应应换站');
  eq(shouldFailover(502, ''), true, '502裸响应应换站');
  eq(shouldFailover(500, ''), true, '500裸响应应换站');
  // 4xx 明细
  eq(shouldFailover(429, ''), true, '429应换站');
  eq(shouldFailover(404, ''), true, '404应换站');
  eq(shouldFailover(401, ''), true, '401应换站');
  eq(shouldFailover(402, ''), true, '402应换站');
  eq(shouldFailover(403, ''), true, '403应换站');
  eq(shouldFailover(424, ''), true, '424应换站');
  eq(shouldFailover(400, 'hello'), true, '400应换站');
  // 200 干净响应不换；带 quota 关键词换
  eq(shouldFailover(200, '{"choices":[{}]}'), false, '200正常不换站');
  eq(shouldFailover(200, 'quota exceeded'), true, '200带quota关键词换站');
  eq(shouldFailover(200, '余额不足'), true, '200带余额关键词换站');

  // 模型级错误：站活着但该模型不可用
  eq(isModelLevelError(404, '', true), true, '404算模型级错误');
  eq(isModelLevelError(200, '', false), true, '200空响应算模型级错误');
  eq(isModelLevelError(200, '', true), false, '200正常不算模型级错误');
  eq(isModelLevelError(503, 'service temporarily unavailable', false), true, '503+暂时不可用算模型级');
  eq(isModelLevelError(503, '', false), false, '503裸不算模型级(是站级)');

  // 空响应判定
  eq(isValidCompletion('{"choices":null}'), false, 'choices:null 无效');
  eq(isValidCompletion('{"choices":[]}'), false, 'choices:[] 无效');
  eq(isValidCompletion('{"choices":[{"message":{"content":"hi"}}]}'), true, '正常choices有效');
  eq(isValidCompletion(''), false, '空body无效');
`);

// ================================================================
// 组2：5xx 熔断状态机
// ================================================================
runGroup('5xx-breaker', `
  const computeProviderScore = () => {}; // mock（真实评分依赖太重，这里只测状态机）
  ${extractFn(routerSrc, 'is5xxCooling')}
  ${extractFn(routerSrc, 'markProvider5xx')}
  ${extractConsts(routerSrc, 'SXX_')}
  const provider5xx = {};

  eq(is5xxCooling('A'), false, '初始不冷却');
  markProvider5xx('A'); markProvider5xx('A');
  eq(is5xxCooling('A'), false, '2连败未达阈值不冷却');
  markProvider5xx('A');
  eq(is5xxCooling('A'), true, '3连败触发冷却');
  provider5xx.A = { streak: 0, until: 0 };   // 模拟成功重置
  eq(is5xxCooling('A'), false, '成功后冷却解除');
`);

// ================================================================
// 组3：429 提醒计数 + 两次提醒触发停用（mock 时钟）
// ================================================================
runGroup('429-suspend', `
  const __t = { v: 1000000 };
  function __now() { return __t.v; }
  const console2 = console;
  const notified = [], suspended = [];
  function sendNotify(m) { notified.push(m); }
  function addChangelog(s, d) { }
  function suspendProviderForQuota(n) { suspended.push(n); }
  ${extractFn(routerSrc, 'markProvider429').replace(/Date\.now\(\)/g, '__now()')}
  ${extractConsts(routerSrc, 'R429_')}
  const provider429 = {};

  // 第 1 轮：连 5 次 → 提醒 1
  for (let i = 0; i < 4; i++) markProvider429('X');
  eq(notified.length, 0, '4连击未达提醒阈值');
  markProvider429('X');
  eq(notified.length, 1, '5连击触发提醒1');
  eq(suspended.length, 0, '仅1次提醒不停用');
  // 冷却期内再连击 → 不重复提醒
  for (let i = 0; i < 10; i++) markProvider429('X');
  eq(notified.length, 1, '10分钟冷却内不重复提醒');
  eq(suspended.length, 0, '冷却内提醒数不变不停用');
  // 冷却过后连击 → 提醒 2 → 停用
  __t.v += 11 * 60 * 1000;
  for (let i = 0; i < 5; i++) markProvider429('X');
  eq(notified.length, 2, '冷却过后触发提醒2');
  eq(suspended.length, 1, '两次提醒触发停用');
  eq(suspended[0], 'X', '停用的站名正确');
  // 成功清零连击（直接操作状态验证语义）
  provider429.X.streak = 0;
  eq(provider429.X.notifyCount, 2, 'notifyCount 当天不清零');
`);

// ================================================================
// 组4：长期记忆近似去重 isDuplicateFact
// ================================================================
runGroup('memory-dedup', `
  const memory = { longterm: [{ fact: '用户偏好使用深色主题的界面风格' }] };
  ${extractFn(routerSrc, 'isDuplicateFact')}

  eq(isDuplicateFact('用户偏好使用深色主题的界面风格'), true, '精确重复');
  eq(isDuplicateFact('用户偏好使用深色主题'), true, '新是旧子串→重复');
  eq(isDuplicateFact('用户偏好使用深色主题的界面风格设计'), true, '旧是新子串→重复');
  eq(isDuplicateFact('完全无关的一条新事实'), false, '无关不重复');
  eq(isDuplicateFact(''), true, '空白视为重复(拒收)');
  // 新更长时替换保留长者
  const before = memory.longterm[0].fact;
  isDuplicateFact('用户偏好使用深色主题的界面风格设计并支持自定义');
  eq(memory.longterm[0].fact !== before, true, '互为子串且新更长→已替换为更长者');
`);

// ================================================================
// 组5：请求体清洗 sanitizeBody / fixMessage / fixTool
// ================================================================
runGroup('sanitize', `
  ${extractFn(routerSrc, 'sanitizeBody')}
  ${extractFn(routerSrc, 'fixMessage')}
  ${extractFn(routerSrc, 'fixTool')}

  // Anthropic 风格 system 注入为 messages[0]
  const r1 = sanitizeBody({ system: '你是助手', messages: [{ role: 'user', content: 'hi' }] }, 'm1');
  eq(r1.messages.length, 2, 'system转换为system消息');
  eq(r1.messages[0].role, 'system', '注入的是system角色');
  eq(r1.model, 'm1', '使用真实模型名');
  // stream_options 注入
  const r2 = sanitizeBody({ stream: true, messages: [] }, 'm');
  eq(r2.stream_options && r2.stream_options.include_usage, true, '流式自动请求usage');
  // max_tokens clamp
  eq(sanitizeBody({ messages: [], max_tokens: 999999 }, 'm').max_tokens, 32768, 'max_tokens上限clamp');
  eq(sanitizeBody({ messages: [] }, 'm').max_tokens, undefined, '未传max_tokens不注入');
  // Anthropic tool (input_schema) → OpenAI function
  const r3 = sanitizeBody({ messages: [], tools: [{ name: 'get', description: 'd', input_schema: { type: 'object' } }] }, 'm');
  eq(r3.tools[0].type, 'function', '工具转OpenAI格式');
  eq(r3.tools[0].function.name, 'get', '工具名保留');
  // content 数组全文本 → 折叠字符串
  const fixed = fixMessage({ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] });
  eq(fixed.content, 'a\\nb', '纯文本数组折叠为字符串');
  // 非纯文本数组保留
  const kept = fixMessage({ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: {} }] });
  ok(Array.isArray(kept.content), '含多模态块保留数组结构');
`);

// ================================================================
// 组6：key 脱敏 / 配置校验 / URL 规范化
// ================================================================
runGroup('misc-router', `
  ${extractFn(routerSrc, 'maskKey')}
  ${extractFn(routerSrc, 'validateProviders')}
  ${extractFn(routerSrc, 'normalizeBase')}

  eq(maskKey('sk-abcdefghijklmnop'), 'sk-***mnop', '长key首3尾4脱敏');
  eq(maskKey('12345678'), '***', '8字符key全遮');
  eq(maskKey(''), '', '空key返回空');
  eq(validateProviders([{ name: 'a', baseUrl: 'https://x.com/v1', key: 'k', models: ['m'] }]), null, '合法配置通过');
  ok(typeof validateProviders([{ name: 'a', baseUrl: 'https://x.com/v1', key: 'k', models: [] }]) === 'string', '空models报错');
  ok(typeof validateProviders([]) === 'string', '空列表报错');
  ok(typeof validateProviders([{ name: 'a', baseUrl: 'https://x.com/v1', key: 'k', models: ['m'] }, { name: 'a', baseUrl: 'https://y.com/v1', key: 'k', models: ['m'] }]) === 'string', '重名报错');
  eq(normalizeBase('https://x.com/v1/'), 'https://x.com/v1', '尾斜杠去除');
`);

// ================================================================
// 组7：前端 scanJsonObjects / extractName / normUrl
// ================================================================
runGroup('frontend', `
  ${extractFn(appSrc, 'scanJsonObjects')}
  ${extractFn(appSrc, 'extractName')}
  ${extractFn(appSrc, 'normUrl')}

  eq(scanJsonObjects('{"tool":"status"}').length, 1, '单JSON提取');
  eq(scanJsonObjects('先 {"tool":"probe"} 再 {"tool":"status"}').length, 2, '多JSON提取');
  eq(scanJsonObjects('{"tool":"toggle","name":"a{b}c"}').length, 1, '字符串内花括号不干扰');
  eq(scanJsonObjects('{"tool":"check","nested":{"x":1}}')[0].obj.nested.x, 1, '嵌套对象完整提取');
  eq(scanJsonObjects('{"unclosed": 1').length, 0, '未闭合不产出');
  eq(scanJsonObjects('纯文本没有json').length, 0, '纯文本零产出');
  // 转义引号场景（用 chr(92) 拼接，避免测试代码自身多重转义）
  const bs = String.fromCharCode(92);
  const escJson = '{"memory":{"remember":"he said ' + bs + '"hi' + bs + '" ok"}}';
  const escParsed = scanJsonObjects(escJson);
  eq(escParsed.length, 1, '转义引号JSON可提取');
  eq(escParsed[0] && escParsed[0].obj.memory.remember, 'he said "hi" ok', '转义引号正确解析');

  eq(extractName('https://api.xiaomimimo.com/v1'), 'xiaomimimo', '跳过api前缀');
  eq(extractName('https://api.openai.com/v1'), 'openai', '跳过api+TLD');
  eq(extractName('https://openrouter.ai/api/v1'), 'openrouter', 'ai域名取主体');
  eq(extractName('https://tabitoken.com/v1'), 'tabitoken', '普通域名');
  eq(extractName('not-a-url'), 'new-site', '无URL兜底');

  eq(normUrl('https://X.com/v1/'), normUrl('https://x.com/v1'), 'URL归一大小写+尾斜杠');
`);

// ================================================================
// 组8：providers.json 实盘配置健康检查（非法配置会直接拖垮热加载）
// ================================================================
runGroup('live-config', `
  const fs2 = require('fs');
  const p2 = JSON.parse(fs2.readFileSync(${JSON.stringify(path.join(ROOT, 'providers.json'))}, 'utf8'));
  ${extractFn(routerSrc, 'validateProviders')}
  eq(validateProviders(p2), null, '本地 providers.json 通过校验');
  const s2 = JSON.parse(fs2.readFileSync(${JSON.stringify(path.join(ROOT, 'settings.json'))}, 'utf8'));
  ok(Array.isArray(s2.priority), 'settings.priority 是数组');
  ok(typeof s2.bindLan === 'boolean', 'settings.bindLan 是布尔');
`);

// ---------- 汇总 ----------
console.log('');
console.log('════════════════════════════════════');
console.log(`  测试结果: ✅ ${passed} 通过  ❌ ${failed} 失败`);
console.log('════════════════════════════════════');
if (failures.length) {
  console.log('\n失败明细:');
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
  process.exit(1);
}
