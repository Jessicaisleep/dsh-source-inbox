/**
 * Client-half integration harness (Phase 0).
 *
 * Loads the REAL client.js with a mocked window.__ModuleLoader__ + require('react')
 * shim, then drives apply(ctx) against a mocked Cordis Client ctx. Verifies:
 *  - module registers with the expected id + inject services
 *  - main panel + sidebar.panellist rows register with correct keys/ids
 *  - rc.3 registration contract: each register() is wrapped in ctx.slots.inject()
 *    (bare register() at apply time is dropped when the slot is lazily declared)
 *  - the Panel component RENDERS via React.createElement (no hooks at factory scope)
 *  - locale dictionaries register
 *  - cleanup disposers unregister everything
 *  - prefix-aware api() builds a non-root-absolute, baseURI-relative path
 *
 * It does NOT simulate a DOM/browser (verification.md forbids custom renderers);
 * it only exercises the module's own registration + component factory logic.
 *
 * Run: node tests/client-harness.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
let pass = 0;
const ok = (c, l) => { if (!c) throw new Error('FAIL: ' + l); pass++; console.log('PASS', l); };

// ---- minimal React.createElement shim (no DOM, no renderer, no hooks runtime) ----
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() };
  },
};
// Hooks are only consulted while a component renders; our shim returns stable
// values so a purely static render of Panel() does not crash. This is NOT a
// DOM/renderer simulation — just enough to call the component's factory once.
React.useState = (init) => [typeof init === 'function' ? init() : init, () => {}];
React.useEffect = () => {};
React.useCallback = (fn) => fn;
React.useRef = (v) => ({ current: v });

// ---- capture window.__ModuleLoader__.load ----
let loaded = null;
globalThis.window = { __ModuleLoader__: { load: (spec) => { loaded = spec; } } };
globalThis.document = { baseURI: 'http://127.0.0.1:62117/dsh/' };

const code = readFileSync(join(root, 'client.js'), 'utf8');
// Execute as a classic script (window global) — same as the host loader does.
new Function('window', 'require', code)(globalThis.window, (name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
});

ok(loaded !== null, 'client.js calls window.__ModuleLoader__.load');
ok(loaded.id === 'dsh-source-inbox', 'module id matches package name');

const moduleObj = loaded.factory((name) => {
  if (name === 'react') return React;
  throw new Error('unexpected require: ' + name);
});
ok(Array.isArray(moduleObj.inject), 'module declares inject services');
ok(moduleObj.inject.includes('slots') && moduleObj.inject.includes('locale'), 'inject includes slots + locale');
ok(typeof moduleObj.apply === 'function', 'module exports apply(ctx)');

// ---- mocked Client Cordis ctx ----
const registered = [];
const injections = [];
const effects = [];
const dictionaries = [];
let layoutInjected = false;
const ctx = {
  slots: {
    // rc.3 contract: inject(key, cb) installs an effect for the slot's
    // declaration lifetime. In this mock the declaration already exists, so
    // the callback runs synchronously (real runner: callback may be deferred
    // until the declaring register() commits). cb() returns the inner
    // register() disposer; our outer disposer must forward it on cleanup.
    inject(key, cb) {
      const rec = { key, inner: null };
      injections.push(rec);
      rec.inner = (typeof cb === 'function') ? cb() : null;
      return () => { if (typeof rec.inner === 'function') { try { rec.inner(); } catch { /* noop */ } } };
    },
    register(spec, render) {
      const rec = { spec, render };
      registered.push(rec);
      return () => { const i = registered.indexOf(rec); if (i >= 0) registered.splice(i, 1); };
    },
  },
  locale: {
    register(ns, dict) { dictionaries.push({ ns, dict }); return () => {}; },
    bind(ns) { return (k) => (dictionaries.find((d) => d.ns === ns)?.dict?.zh?.[k]) ?? k; },
  },
  inject(services, cb) {
    if (services.includes('layout')) { layoutInjected = true; cb({ layout: { panelInfo: { getSnapshot: () => ({ activePanelId: null }) }, selectPanel() {} } }); }
    return () => {};
  },
  effect(factory, label) { const cleanup = factory(); effects.push({ factory, label, cleanup }); return cleanup; },
};

moduleObj.apply(ctx);

ok(dictionaries.length === 1, 'locale dictionaries registered');
ok(dictionaries[0].ns === 'dsh-source-inbox', 'locale namespace matches');
ok(dictionaries[0].dict.zh.nav === '素材收件箱' && dictionaries[0].dict.en.nav === 'Source inbox', 'zh + en dictionaries present');
ok(layoutInjected, 'layout service injected at apply scope');
ok(registered.length === 2, `2 slots registered (got ${registered.length})`);

// ---- rc.3 regression: register() MUST be wrapped in ctx.slots.inject() ----
// A bare register() at apply time is dropped because sidebar.panellist / main
// are lazily declared; the inject() callback fires once the declaration is
// committed. Assert both wrappers exist, with the correct keys, and that each
// wrapper actually drove one register() of the matching slot.
ok(injections.length === 2, `2 slots.inject() wrappers installed (got ${injections.length})`);
ok(injections.some((i) => i.key === 'main'), 'main registration goes through slots.inject("main")');
ok(injections.some((i) => i.key === 'sidebar.panellist'), 'sidebar registration goes through slots.inject("sidebar.panellist")');
ok(injections.every((i) => typeof i.inner === 'function'), 'each inject callback returned a register() disposer');
// Runtime proof of "no bare register": the mock's register() only fires when
// called (inside an inject callback or bare). Both registrations are accounted
// for by the 2 inject wrappers, so neither was a bare apply-time register().
ok(registered.length === injections.length, 'every register() was driven by an inject() wrapper (no bare register)');

const main = registered.find((r) => r.spec.name === 'main');
const side = registered.find((r) => r.spec.name === 'sidebar.panellist');
ok(main && main.spec.key === 'dsh-source-inbox', 'main panel uses key=dsh-source-inbox');
ok(side && side.spec.id === 'dsh-source-inbox', 'sidebar row uses id=dsh-source-inbox (same key)');
ok(side.spec.order === 5 && typeof side.spec.label === 'function', 'sidebar row has order + label fn');

// Render the sidebar icon. side.render({size}) returns an element wrapping the
// InboxIcon component; invoke it to get the actual svg.
const iconWrapper = side.render({ size: 16 });
ok(iconWrapper && typeof iconWrapper.type === 'function', 'sidebar render returns an InboxIcon element');
const svgEl = iconWrapper.type(iconWrapper.props);
ok(svgEl && svgEl.type === 'svg' && svgEl.props.width === 16, 'InboxIcon({size:16}) -> valid svg element');

// Render the main Panel component ONCE to prove its body executes without a
// hook-at-factory-scope crash. main.render() returns an element wrapping Panel;
// calling Panel({t}) with the stable hook shims must produce an element tree.
const wrapper = main.render();
ok(wrapper && typeof wrapper.type === 'function', 'main render returns a Panel element');
const panelEl = wrapper.type(wrapper.props);
ok(panelEl && panelEl.type === 'div' && Array.isArray(panelEl.children), 'Panel({t}) renders an element tree');

// ---- Phase 1: adapter Card + dictionary + endpoints ----
function collectText(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const n of node) collectText(n, out); return out; }
  if (typeof node === 'object' && Array.isArray(node.children)) {
    for (const n of node.children) collectText(n, out);
  }
  return out;
}
const panelText = collectText(panelEl).join(' | ');
ok(dictionaries[0].dict.zh.adapterTitle === '自动源适配器', 'zh DICT has adapterTitle (Phase 1)');
ok(dictionaries[0].dict.en.adapterTitle === 'Automatic source adapters', 'en DICT has adapterTitle (Phase 1)');
ok(/Phase 1/.test(dictionaries[0].dict.en.phase), 'en phase badge reads Phase 1');
ok(panelText.includes('自动源适配器'), 'render tree contains the adapter Card title');
ok(panelText.includes('自动源适配器') && /投放区|dropzone/.test(panelText), 'adapter Card renders its hint');
ok(code.includes('/adapters'), 'client.js references /adapters endpoint');
ok(code.includes('/adapters/dropzone/scan') && code.includes('/adapters/dropzone'), 'client.js references dropzone config + scan endpoints');
ok(code.includes('getJSON(`${API}/adapters`)'), 'loadAll fetches /adapters status');

// ---- api() BEHAVIOR, not just structure (independent-review MAJOR #1) ----
// The old harness only regex-checked that api() existed, so it missed that a
// pathname-only return silently DROPPED ?id= / ?limit=. Extract the real
// function body (brace-counted) and actually call it with a query string.
function extractFn(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('function not found: ' + marker);
  const open = src.indexOf('{', start);
  let depth = 0; let end = -1;
  for (let j = open; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) { end = j + 1; break; } }
  }
  return src.slice(start, end);
}
const api = new Function('document', extractFn(code, 'function api(path)') + '\nreturn api;')(
  { baseURI: 'http://127.0.0.1:62117/dsh/' },
);
const readUrl = api('/dsh-source-inbox/api/read?id=abc%20x&n=1');
ok(/new URL\(relative,\s*document\.baseURI\)/.test(code), 'api() is prefix-aware (document.baseURI)');
ok(readUrl.startsWith('/dsh/'), `api() keeps the host prefix (got ${readUrl})`);
ok(readUrl.includes('/dsh-source-inbox/api/read'), 'api() keeps the path');
ok(readUrl.includes('?id=abc%20x&n=1'), 'api() PRESERVES the query string (MAJOR #1 fix)');
ok(!readUrl.startsWith('http'), 'api() returns a path, not an absolute URL');
ok(!/fetch\((['"`])\//.test(code), 'no root-absolute fetch() path in client.js');

// ---- Phase: per-source official entry buttons (login / authorize / export) ----
const { SOURCES, AUTH_KINDS } = await import('../lib/sources.js');
ok(Array.isArray(SOURCES) && SOURCES.length === 28, `registry still has 28 sources (got ${SOURCES.length})`);
const zhDict = dictionaries[0].dict.zh;
const enDict = dictionaries[0].dict.en;
for (const k of ['authOauth', 'authToken', 'authLogin', 'authExport', 'authLocal', 'authOpen', 'groupHint', 'authNoLinkLocal', 'authNoLinkExport', 'authNoLinkToken', 'stepLabel', 'stepGet', 'stepWhere', 'readSelf', 'readBusy', 'readOk', 'readFail', 'readPageHint', 'readLoginNeeded', 'removeLabel', 'removeConfirm', 'removeOk', 'removeFail',
  'credLabel', 'credSave', 'credSaving', 'credClear', 'credClearConfirm', 'credOk', 'credCleared', 'credFail', 'credSavedBadge', 'credEmptyBadge', 'credNeedRequired', 'credSecretNote']) {
  ok(typeof zhDict[k] === 'string' && zhDict[k].length > 0, `zh DICT has ${k}`);
  ok(typeof enDict[k] === 'string' && enDict[k].length > 0, `en DICT has ${k}`);
}
// The record-preview hint and the read hint are two different things; reusing
// one key for both silently overwrote the preview text (caught here).
ok(zhDict.readHint !== zhDict.readPageHint && enDict.readHint !== enDict.readPageHint, 'readHint (preview) and readPageHint (self-read) are distinct keys');

// DATA: every row is actionable — either an official https entry point, or an
// explicit auth kind whose "no web page" explanation exists.
const badAuth = SOURCES.filter((s) => !AUTH_KINDS.includes(s.auth));
ok(badAuth.length === 0, `every source declares a known auth kind (bad: ${badAuth.map((s) => s.id).join(',')})`);
const badUrl = [];
for (const s of SOURCES) {
  for (const l of s.links) {
    if (!/^https:\/\/[^\s/]+\.[^\s/]+/i.test(l.url)) badUrl.push(`${s.id}:${l.url}`);
    if (/^https:\/\/[^/]*@/i.test(l.url)) badUrl.push(`${s.id}:credentials-in-url`);
    if (!l.label || typeof l.label !== 'string') badUrl.push(`${s.id}:no-label`);
    if (/[\s"'<>]/.test(l.url)) badUrl.push(`${s.id}:unsafe-chars`);
    if (l.url.length > 2048) badUrl.push(`${s.id}:too-long`);
  }
}
ok(badUrl.length === 0, `every official link is a clean absolute HTTPS URL (bad: ${badUrl.join(' | ')})`);
const NO_LINK_KEY_BY_AUTH = { local: 'authNoLinkLocal', export: 'authNoLinkExport', token: 'authNoLinkToken' };
const unexplained = SOURCES.filter((s) => s.links.length === 0 && !NO_LINK_KEY_BY_AUTH[s.auth]);
ok(unexplained.length === 0, `rows without a web page are all local/export/token (unexplained: ${unexplained.map((s) => s.id).join(',')})`);
const withLinks = SOURCES.filter((s) => s.links.length > 0);
ok(withLinks.length >= 18, `at least 18 rows carry a one-click official link (got ${withLinks.length}/${SOURCES.length})`);
ok(withLinks.every((s) => s.auth !== 'local'), 'no row with a link is mislabeled local');
ok(SOURCES.filter((s) => ['L0', 'L1'].includes(s.tier)).every((s) => s.links.length > 0 || s.auth === 'local'),
  'every official-API (L0/L1) row either links to its console or is a local channel');
ok(SOURCES.filter((s) => s.tier === 'L2').every((s) => s.links.length > 0 && s.auth === 'login' || s.auth === 'local'),
  'every web-login (L2) row links its login page (or is a local tool)');

// WIRING: the row renderer is a real component, and the click path is openExternal.
ok(/function SourceRow\(\{ s, t, onRead, reading, cred, credBusy, onSaveCred, onClearCred \}\)/.test(code), 'client.js defines a SourceRow component');
ok(code.includes('h(SourceRow, {') && /key: s\.id, s, t,/.test(code), 'the registry maps every source through SourceRow');
ok(/onClick: \(\) => openExternal\(l\.url\)/.test(code), 'each link button opens the URL via openExternal');
ok(code.includes('↗ '), 'link buttons render an ↗ affordance');
ok(/openGroups\[g\] !== false/.test(code), 'groups default to expanded so the buttons are visible without a first click');
// Phase 2 wiring: the follow-up steps and the self-read action must be in the tree.
ok(/steps\.map\(\(st, i\) =>/.test(code), 'SourceRow renders the follow-up steps');
ok(code.includes("t('stepGet')") && code.includes("t('stepWhere')"), 'steps render both the value you get and where it goes');
ok(/onRead\(s, pg\)/.test(code), 'each read button hands over its OWN whitelisted page');
ok(/reads\.map\(\(pg, i\) =>/.test(code), 'a row with several platforms renders one read button per page');
ok(code.includes('${API}/browser/read'), 'the panel posts to /browser/read');
// A wrong record must be removable from the panel itself, not only via a tool.
ok(code.includes('${API}/remove'), 'the panel posts to /remove');
ok(/const removeRecord = useCallback\(/.test(code), 'removeRecord is a declared callback');
ok(code.indexOf('const postJSON') < code.indexOf('const removeRecord'), 'removeRecord is declared AFTER postJSON (a dep array is evaluated during render — the reverse order throws TDZ)');
ok(code.includes("t('removeConfirm')"), 'removal asks for confirmation first');
ok(code.includes('onClick: () => removeRecord(selected.id)'), 'the preview pane offers the delete action for the open record');

// BEHAVIOR: openExternal must accept https and refuse everything else. It only
// ever forwards to window.open, which the host turns into shell.openExternal.
const openExternal = new Function('window', extractFn(code, 'function openExternal(url)') + '\nreturn openExternal;')(
  { open: (...args) => { openExternal.calls.push(args); } },
);
openExternal.calls = [];
ok(openExternal('https://pan.quark.cn') === true, 'openExternal accepts an https URL');
ok(openExternal.calls.length === 1 && openExternal.calls[0][0] === 'https://pan.quark.cn', 'it forwards the exact URL');
ok(openExternal.calls[0][1] === '_blank' && openExternal.calls[0][2] === 'noopener,noreferrer', 'opens in a new tab with noopener,noreferrer');
ok(openExternal('javascript:alert(1)') === false && openExternal.calls.length === 1, 'refuses javascript: URLs');
ok(openExternal('http://pan.quark.cn') === false, 'refuses plain http (https only)');
ok(openExternal('file:///C:/Windows/System32/calc.exe') === false, 'refuses file: URLs');
ok(openExternal('https://exa mple.com') === false, 'refuses URLs with whitespace');
ok(openExternal('') === false && openExternal(null) === false, 'refuses empty/null');
const noWindow = new Function('window', extractFn(code, 'function openExternal(url)') + '\nreturn openExternal;')(undefined);
ok(noWindow('https://pan.quark.cn') === false, 'returns false when the host exposes no window.open');

// ---- RENDER BEHAVIOR of the row: buttons per link, explanation per no-link row ----
// The real component is extracted and called with the real 28-row registry, so
// this asserts the actual render tree (label, href target, click path) instead
// of regex-matching the source.
const hShim = (type, props, ...children) => ({
  type,
  props: { ...(props || {}), children: children.length <= 1 ? (children[0] ?? null) : children },
});
const constFromCode = (name) => {
  const m = code.match(new RegExp(`const ${name} = (\\{[^}]*\\});`));
  if (!m) throw new Error('const not found: ' + name);
  return new Function('return (' + m[1] + ')')();
};
const AUTH_KEY = constFromCode('AUTH_KEY');
const NO_LINK_KEY = constFromCode('NO_LINK_KEY');
const tZh = (k) => zhDict[k] ?? k;
// SourceRow's header is destructured (`function SourceRow({ s, t }) {`), so the
// generic extractFn would stop at the parameter brace — match the body instead.
const extractComponent = (src, header) => {
  const start = src.indexOf(header);
  if (start < 0) throw new Error('component not found: ' + header);
  const bodyOpen = src.indexOf(') {', start) + 2;
  let depth = 0; let end = -1;
  for (let j = bodyOpen; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1;
    else if (src[j] === '}') { depth -= 1; if (depth === 0) { end = j + 1; break; } }
  }
  return src.slice(start, end);
};
const makeRow = (openSpy) => new Function(
  'h', 'C', 'focusable', 'LINK_BTN', 'CHIP', 'CRED_INPUT', 'AUTH_KEY', 'NO_LINK_KEY', 'openExternal', 't',
  extractComponent(code, 'function SourceRow') + '\nreturn SourceRow;',
)(
  hShim,
  { bgBase: 'bg', border: 'bd', radius: 'r', label: 'l', label2: 'l2', label3: 'l3', brand: 'brand', success: 'ok', error: 'err' },
  {}, {}, {}, {}, AUTH_KEY, NO_LINK_KEY, openSpy, tZh,
);
const walk = (node, out = []) => {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(node); return out; }
  if (Array.isArray(node)) { for (const n of node) walk(n, out); return out; }
  if (node && node.props) { out.push(node); walk(node.props.children, out); }
  return out;
};
const nodesOf = (tree) => walk(tree);
const buttonsOf = (tree) => nodesOf(tree).filter((n) => n && n.type === 'button');
const textOf = (tree) => nodesOf(tree).filter((n) => typeof n === 'string').join(' ');

let rowFailures = [];
const clicked = [];
for (const s of SOURCES) {
  const tree = makeRow((u) => clicked.push(u))({ s, t: tZh });
  const btns = buttonsOf(tree);
  const text = textOf(tree);
  // The self-read button is also a <button>; count only the entry buttons (↗).
  const entryBtns = btns.filter((b) => String(b.props.children ?? '').startsWith('↗ '));
  if (entryBtns.length !== s.links.length) rowFailures.push(`${s.id}:${entryBtns.length}buttons/${s.links.length}links`);
  for (let i = 0; i < entryBtns.length; i += 1) {
    const label = String(entryBtns[i].props.children ?? '');
    if (!label.includes(s.links[i].label)) rowFailures.push(`${s.id}:wrong-label`);
    if (!String(entryBtns[i].props.title || '').includes(s.links[i].url)) rowFailures.push(`${s.id}:no-title-url`);
    if (typeof entryBtns[i].props.onClick !== 'function') rowFailures.push(`${s.id}:no-onClick`);
  }
  if (!text.includes(s.label)) rowFailures.push(`${s.id}:no-name`);
  if (!text.includes(s.tier)) rowFailures.push(`${s.id}:no-tier`);
  if (!text.includes(tZh('guideLabel') + '：' + s.guide)) rowFailures.push(`${s.id}:no-guide`);
  if (s.links.length === 0) {
    const expect = tZh(NO_LINK_KEY[s.auth] ?? 'authNoLinkLocal');
    if (!text.includes(expect)) rowFailures.push(`${s.id}:no-explanation`);
  } else if (!text.includes(tZh(AUTH_KEY[s.auth]))) {
    rowFailures.push(`${s.id}:no-auth-chip`);
  }
}
ok(rowFailures.length === 0, `all 28 rows render their own buttons/explanation (bad: ${rowFailures.slice(0, 4).join(' | ')})`);

// ---- Phase 2 RENDER: follow-up steps + the self-read affordance ----
let stepFailures = [];
for (const s of SOURCES) {
  const text = textOf(makeRow(() => {})({ s, t: tZh }));
  for (const st of s.steps) {
    if (!text.includes(st.doing)) stepFailures.push(`${s.id}:missing-step`);
    if (st.get && !text.includes(`${tZh('stepGet')}：${st.get}`)) stepFailures.push(`${s.id}:missing-get`);
    if (st.where && !text.includes(`${tZh('stepWhere')}：${st.where}`)) stepFailures.push(`${s.id}:missing-where`);
  }
}
ok(stepFailures.length === 0, `every step renders (bad: ${stepFailures.slice(0, 4).join(' | ')})`);

// The feishu row is the example the user named: it must say what you get after
// the developer console and where that value goes.
const feishu = SOURCES.find((s) => s.id === 'feishu');
const feishuText = textOf(makeRow(() => {})({ s: feishu, t: tZh }));
ok(feishu.steps.some((st) => st.get && st.where), '飞书 row explains what to obtain AND where to put it');
ok(feishuText.includes(tZh('stepGet')) && feishuText.includes(tZh('stepWhere')), '飞书 row renders 拿到 / 填到 labels');

// Self-read: only rows with reads get the button, and clicking it reports the
// source + its FIRST whitelisted page (nothing else).
const readRows = SOURCES.filter((s) => s.reads.length > 0);
const noReadRows = SOURCES.filter((s) => s.reads.length === 0);
ok(readRows.length >= 5, `some rows offer the self-read action (got ${readRows.length})`);
const readCalls = [];
const dv = SOURCES.find((s) => s.id === 'creator-video');
const readTree = makeRow(() => {})({ s: dv, t: tZh, onRead: (src, page) => readCalls.push({ id: src.id, url: page.url }), reading: false });
const readBtns = buttonsOf(readTree).filter((b) => String(b.props.children ?? '').includes(tZh('readSelf')));
ok(readBtns.length === dv.reads.length, `抖音 row renders one read button per platform (got ${readBtns.length}/${dv.reads.length})`);
readBtns[0].props.onClick();
ok(readCalls.length === 1 && readCalls[0].id === 'creator-video' && readCalls[0].url === dv.reads[0].url, 'clicking the first read button hands over 抖音');
readCalls.length = 0;
readBtns[2].props.onClick();
ok(readCalls.length === 1 && readCalls[0].url === dv.reads[2].url, 'clicking the third read button hands over 视频号 (not silently the first)');
const busyText = textOf(makeRow(() => {})({ s: dv, t: tZh, onRead: () => {}, reading: true }));
ok(busyText.includes(tZh('readBusy')), 'the button shows a busy label while reading');
const noReadText = textOf(makeRow(() => {})({ s: SOURCES.find((s) => s.id === 'obsidian'), t: tZh, onRead: () => {}, reading: false }), 'obsidian row has no self-read button');
ok(noReadRows.every((s) => !textOf(makeRow(() => {})({ s, t: tZh, onRead: () => {}, reading: false })).includes(tZh('readSelf'))), 'rows without a readable page never show the self-read button');
ok(noReadRows.length + readRows.length === SOURCES.length, 'every row is classified as readable or not');

// Clicking a rendered button must forward exactly that row's official URL.
clicked.length = 0;
const quark = SOURCES.find((s) => s.id === 'quark');
const quarkTree = makeRow((u) => clicked.push(u))({ s: quark, t: tZh });
for (const b of buttonsOf(quarkTree)) b.props.onClick();
ok(clicked.length === quark.links.length && clicked.every((u, i) => u === quark.links[i].url), 'clicking Quark\'s buttons opens its own official URLs');
clicked.length = 0;
const obsidian = SOURCES.find((s) => s.id === 'obsidian');
makeRow((u) => clicked.push(u))({ s: obsidian, t: tZh });
ok(clicked.length === 0, 'a local channel row renders no clickable button (nothing to open)');

// ---- Phase 2.3 RENDER: the paste-and-save credential box ----
// The user's complaint: guidance said "填到 E:\...\_secrets\feishu.json", which
// silently meant "create the file and guess the JSON keys yourself". Every row
// that declares a credential must now render real <input> fields plus a save
// button, and must never render a path the user is expected to type into.
const credRows = SOURCES.filter((s) => s.credential);
const nonCredRows = SOURCES.filter((s) => !s.credential);
ok(credRows.length === 8, `8 sources need a pasted credential (got ${credRows.length})`);
const fieldTotal = credRows.reduce((n, s) => n + s.credential.fields.length, 0);
ok(fieldTotal === 14, `they declare 14 credential fields in total (got ${fieldTotal})`);
ok(credRows.every((s) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(s.credential.file)), 'every credential file is a bare .json name (no path segments)');
ok(credRows.every((s) => s.credential.fields.length > 0 && s.credential.fields.every((f) => f.key && f.label && typeof f.secret === 'boolean')), 'every credential field declares key/label/secret');
ok(credRows.every((s) => s.steps.every((st) => !/^[A-Za-z]:\\/.test(String(st.where ?? '')))), 'no step tells the user to write a credential into a Windows path by hand');

const credFailures = [];
for (const s of credRows) {
  const tree = makeRow(() => {})({ s, t: tZh, cred: null, credBusy: false, onSaveCred: () => {}, onClearCred: () => {} });
  const inputs = nodesOf(tree).filter((n) => n && n.type === 'input');
  const text = textOf(tree);
  if (inputs.length !== s.credential.fields.length) credFailures.push(`${s.id}:${inputs.length}inputs/${s.credential.fields.length}fields`);
  for (let i = 0; i < inputs.length; i += 1) {
    const f = s.credential.fields[i];
    if (inputs[i].props['data-cred-field'] !== f.key) credFailures.push(`${s.id}:wrong-field-key`);
    // Secret fields must be password inputs so the value is not shoulder-surfable.
    const want = f.secret ? 'password' : 'text';
    if (inputs[i].props.type !== want) credFailures.push(`${s.id}:${f.key}-type-${inputs[i].props.type}`);
    if (inputs[i].props.autoComplete !== 'off') credFailures.push(`${s.id}:${f.key}-autocomplete`);
  }
  if (!text.includes(tZh('credLabel'))) credFailures.push(`${s.id}:no-cred-label`);
  if (!text.includes(tZh('credEmptyBadge'))) credFailures.push(`${s.id}:no-empty-badge`);
  const saveBtns = buttonsOf(tree).filter((b) => String(b.props.children ?? '') === tZh('credSave'));
  if (saveBtns.length !== 1) credFailures.push(`${s.id}:save-buttons-${saveBtns.length}`);
}
ok(credFailures.length === 0, `every credential row renders one input per field + a save button (bad: ${credFailures.slice(0, 4).join(' | ')})`);
ok(nonCredRows.every((s) => !textOf(makeRow(() => {})({ s, t: tZh })).includes(tZh('credLabel'))), 'rows with no credential never render the credential box');

// A saved credential renders a MASKED preview (the host's status), never the value.
const feishuRow = SOURCES.find((s) => s.id === 'feishu');
const savedTree = makeRow(() => {})({
  s: feishuRow, t: tZh,
  cred: {
    source: 'feishu', file: 'feishu.json', path: 'E:\\_secrets\\feishu.json', configured: true,
    fields: [{ key: 'appId', saved: true, preview: 'cli_****（12 位）' }, { key: 'appSecret', saved: true, preview: 'abcd****（32 位）' }, { key: 'userAccessToken', saved: false, preview: '' }],
  },
  credBusy: false, onSaveCred: () => {}, onClearCred: () => {},
});
const savedInputs = nodesOf(savedTree).filter((n) => n && n.type === 'input');
ok(String(savedInputs[0].props.placeholder).includes('cli_****'), 'a saved field shows the masked preview as its placeholder');
ok(textOf(savedTree).includes(tZh('credSavedBadge')), 'a configured source shows the 已保存 badge');
const savedClear = buttonsOf(savedTree).filter((b) => String(b.props.children ?? '') === tZh('credClear'));
ok(savedClear.length === 1 && savedClear[0].props.disabled === false, 'the clear button is enabled only once something is saved');
const unsavedClear = buttonsOf(makeRow(() => {})({ s: feishuRow, t: tZh, cred: null })).filter((b) => String(b.props.children ?? '') === tZh('credClear'));
ok(unsavedClear.length === 1 && unsavedClear[0].props.disabled === true, 'the clear button is disabled when nothing is saved');

// Save must collect values out of the DOM by data-cred-field and hand them to onSaveCred.
const savedCalls = [];
const fakeInputs = { appId: { value: 'cli_abc' }, appSecret: { value: 'sek' }, userAccessToken: { value: '' } };
const fakeRoot = {
  querySelectorAll: (sel) => (sel !== '[data-cred-field]' ? [] : Object.keys(fakeInputs).map((k) => ({
    getAttribute: () => k, value: fakeInputs[k].value,
  }))),
};
const clickTree = makeRow(() => {})({ s: feishuRow, t: tZh, cred: null, onSaveCred: (src, v) => savedCalls.push({ id: src.id, v }) });
const saveBtn = buttonsOf(clickTree).filter((b) => String(b.props.children ?? '') === tZh('credSave'))[0];
saveBtn.props.onClick({ currentTarget: { parentElement: { parentElement: fakeRoot } } });
ok(savedCalls.length === 1 && savedCalls[0].id === 'feishu', 'clicking save reports the source');
ok(JSON.stringify(savedCalls[0].v) === JSON.stringify({ appId: 'cli_abc', appSecret: 'sek', userAccessToken: '' }), 'save collects every input by data-cred-field, including empty optional ones');
const busyTree = makeRow(() => {})({ s: feishuRow, t: tZh, cred: null, credBusy: true, onSaveCred: () => {} });
ok(textOf(busyTree).includes(tZh('credSaving')), 'the save button shows a busy label while saving');
ok(buttonsOf(busyTree).filter((b) => String(b.props.children ?? '') === tZh('credSaving')).every((b) => b.props.disabled === true), 'the save button is disabled while saving');

// Panel wiring: it must load the vault, post saves, and never keep a plaintext value.
ok(code.includes('${API}/credentials'), 'the panel reads the credential status from /credentials');
ok(code.includes('${API}/credentials/save') && code.includes('${API}/credentials/clear'), 'the panel posts to /credentials/save and /credentials/clear');
ok(/const saveCredential = useCallback\(/.test(code) && /const clearCredential = useCallback\(/.test(code), 'saveCredential and clearCredential are declared callbacks');
ok(code.indexOf('const postJSON') < code.indexOf('const saveCredential'), 'saveCredential is declared AFTER postJSON (dep arrays evaluate during render)');
ok(/cred: creds\[s\.id\] \?\? null/.test(code), 'each row receives its own masked credential status');
ok(!/setCreds\([^)]*values/.test(code), 'a plaintext value is never put into component state');

// Cleanup: run effect cleanups, then assert both slots unregistered.
for (const e of effects) { if (typeof e.cleanup === 'function') e.cleanup(); }
ok(registered.length === 0, `cleanup unregisters both slots (got ${registered.length})`);

console.log(`\n${pass} checks passed.`);
console.log('CLIENT VERIFIED: registration + render + locale + cleanup (no DOM simulated).');
