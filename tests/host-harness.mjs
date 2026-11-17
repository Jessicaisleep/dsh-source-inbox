/**
 * Host-half integration harness (Phase 0).
 *
 * Drives the REAL index.js apply() against a mocked Cordis ctx + Node HTTP
 * request/response objects, so the route handlers, loopback guard, JSON body
 * reader, query parser, tool execute() functions and cleanup disposers are all
 * exercised — not just syntax-checked. No DSH runtime / browser needed.
 *
 * Run: node tests/host-harness.mjs
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const root = fileURLToPath(new URL('..', import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), 'dsh-inbox-host-'));

let pass = 0;
function ok(cond, label) { if (!cond) throw new Error('FAIL: ' + label); pass++; console.log('PASS', label); }

// ---- mock HTTP request (an EventEmitter with data/end/error) ----
function makeReq({ method = 'GET', url = '/', headers = {}, body = null, localAddress = '127.0.0.1' } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:62117', ...headers };
  req.socket = { localAddress };
  // emit body asynchronously after handlers attach 'data'/'end'
  if (body !== null) {
    const buf = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    setImmediate(() => { req.emit('data', buf); req.emit('end'); });
  }
  return req;
}
function makeRes() {
  const res = {
    statusCode: 0, headers: {}, chunks: [], ended: false,
    writeHead(status, hdrs) { this.statusCode = status; this.headers = hdrs; return this; },
    write(c) { this.chunks.push(Buffer.from(c)); return true; },
    end(c) { if (c !== undefined) this.chunks.push(Buffer.from(c)); this.ended = true; return this; },
    json() { return JSON.parse(Buffer.concat(this.chunks).toString('utf8')); },
    text() { return Buffer.concat(this.chunks).toString('utf8'); },
  };
  return res;
}

// ---- mock Cordis ctx: captures routes + tools, runs effects immediately ----
function makeCtx() {
  const routes = new Map();
  const tools = new Map();
  const effects = [];
  const baseCtx = {
    webServer: {
      register(entry) {
        if (routes.has(entry.path)) throw new Error('duplicate route ' + entry.path);
        routes.set(entry.path, entry);
        return () => routes.delete(entry.path); // disposer
      },
    },
    tools: {
      register(def) {
        if (tools.has(def.name)) throw new Error('duplicate tool ' + def.name);
        tools.set(def.name, def);
        return () => tools.delete(def.name); // disposer
      },
    },
  };
  baseCtx.inject = (services, cb) => {
    const scoped = { ...baseCtx };
    scoped.effect = (factory, label) => { effects.push({ factory, label, cleanup: factory() }); return scoped.effect; };
    // apply() calls ctx.inject(['webServer'], cb) / ctx.inject(['tools'], cb)
    return cb(scoped);
  };
  baseCtx.effect = (factory) => { effects.push({ factory, cleanup: factory() }); };
  return { routes, tools, effects, baseCtx };
}

const mod = await import(pathToFileURL(join(root, 'index.js')).href);
ok(typeof mod.apply === 'function', 'index.js exports apply()');

const ctx = makeCtx();
mod.apply(ctx.baseCtx, { dataDir });
// Wait for store.init() (mkdir + manifest read) to settle.
await new Promise((r) => setTimeout(r, 80));

ok(ctx.routes.size === 17, `17 routes registered (got ${ctx.routes.size})`);
ok(ctx.tools.size === 13, `13 tools registered (got ${ctx.tools.size})`);
ok(ctx.effects.length === 3, `3 effects mounted (got ${ctx.effects.length})`);

async function call(path, opts = {}) {
  const routePath = path.split('?')[0];
  const entry = ctx.routes.get(routePath);
  if (!entry) throw new Error('no route ' + routePath);
  const req = makeReq({ ...opts, url: path });
  const res = makeRes();
  if (opts?.body === undefined || opts?.body === null) {
    // GET-style: no body stream; emit 'end' so readJsonBody (if any) resolves.
    if (opts?.method === 'POST') setImmediate(() => req.emit('end'));
  }
  await entry.handler(req, res);
  return res;
}

// status
let r = await call('/dsh-source-inbox/api/status');
ok(r.statusCode === 200, 'GET /status -> 200');
ok(r.json().ok === true && r.json().phase === 1, 'status reports phase 1 (adapter wired)');
ok(r.json().stats && typeof r.json().stats.total === 'number', 'status carries stats');
ok(r.json().sources && r.json().sources.phase === 1 && r.json().sources.adaptersWired === 1, 'status carries sourceStatus with 1 wired adapter');
ok(r.json().adaptersWired === 1, 'status carries adaptersWired');

// sources
r = await call('/dsh-source-inbox/api/sources');
ok(r.statusCode === 200 && Array.isArray(r.json().sources), 'GET /sources -> 200 + sources array');
ok(r.json().ladder.length >= 5, 'ladder has >= 5 tiers');
ok(r.json().hardBan && r.json().hardBan.rule, 'hard ban present');
// Phase: every serialized row carries its auth kind + official entry links, so
// the client can render a login / authorize button without a second round trip.
const wireSources = r.json().sources;
ok(wireSources.every((s) => typeof s.auth === 'string' && Array.isArray(s.links)), 'every row serializes auth + links[]');
ok(wireSources.every((s) => s.links.every((l) => /^https:\/\//.test(l.url) && typeof l.label === 'string')), 'all serialized links are https with a label');
ok(wireSources.filter((s) => s.links.length > 0).length >= 18, `>= 18 rows are clickable (got ${wireSources.filter((s) => s.links.length > 0).length})`);
ok(r.json().status.entriesWithOfficialLink === wireSources.filter((s) => s.links.length > 0).length, 'sourceStatus.entriesWithOfficialLink matches the rows');
ok(r.json().status.officialLinks === new Set(wireSources.flatMap((s) => s.links.map((l) => l.url))).size, 'sourceStatus.officialLinks matches the de-duplicated count');

// stats
r = await call('/dsh-source-inbox/api/stats');
ok(r.statusCode === 200 && typeof r.json().total === 'number', 'GET /stats -> 200');

// import: a real directory with one text file (official-export shape)
const expDir = join(dataDir, 'export-sample');
mkdirSync(expDir, { recursive: true });
writeFileSync(join(expDir, 'notes.md'), '# hello\nThis is an official export.', 'utf8');
r = await call('/dsh-source-inbox/api/import', {
  method: 'POST',
  body: { path: expDir, source: 'deepseek-web', tags: ['chat'] },
});
ok(r.statusCode === 200, 'POST /import -> 200 (got ' + r.statusCode + ')');
ok(r.json().imported >= 1, 'import archived >= 1 record (got ' + r.json().imported + ')');

// list
r = await call('/dsh-source-inbox/api/list');
ok(r.statusCode === 200 && r.json().rows.length >= 1, 'GET /list -> rows');
const id = r.json().rows[0].id;
ok(typeof id === 'string' && id.length > 0, 'row has id');

// read
r = await call('/dsh-source-inbox/api/read?id=' + encodeURIComponent(id));
ok(r.statusCode === 200, 'GET /read -> 200');
ok(r.json().text && r.json().text.includes('official export'), 'read returns normalized text');

// read missing
r = await call('/dsh-source-inbox/api/read?id=nope');
ok(r.statusCode === 404, 'GET /read missing -> 404');

// remove: taking a wrong record back out must be reachable from BOTH surfaces.
r = await call('/dsh-source-inbox/api/remove', { method: 'POST', body: {} });
ok(r.statusCode === 400 && /id is required/.test(r.json().error), 'POST /remove without id -> 400');
r = await call('/dsh-source-inbox/api/remove', { method: 'POST', body: { id: 'no-such-id' } });
ok(r.statusCode === 404 && r.json().ok === false, 'POST /remove unknown id -> 404');
const beforeRemove = ctx.routes.has('/dsh-source-inbox/api/remove');
ok(beforeRemove === true, '/remove route is mounted');

// method guard
r = await call('/dsh-source-inbox/api/status', { method: 'POST' });
ok(r.statusCode === 405, 'wrong method -> 405');

// loopback guard: foreign Host header -> 403
const foreign = makeReq({ url: '/dsh-source-inbox/api/status', headers: { host: 'evil.example.com' } });
const fr = makeRes();
await ctx.routes.get('/dsh-source-inbox/api/status').handler(foreign, fr);
ok(fr.statusCode === 403 && fr.headers['content-type']?.includes('json') === false ? true : fr.json().error === 'host-not-trusted', 'foreign Host -> 403 host-not-trusted');

// ---- compliance gate (§2 red line enforced in code, not just docs) ----
// A relative path must be rejected (no cwd-relative reads).
r = await call('/dsh-source-inbox/api/import', { method: 'POST', body: { path: 'relative/notes.md' } });
ok(r.statusCode === 400 && /absolute/i.test(r.json().error), 'POST /import rejects a relative path');
// A local chat database (absolute) must be refused by BOTH the route and the tool.
const dbPath = join(dataDir, 'MM.sqlite');
r = await call('/dsh-source-inbox/api/import', { method: 'POST', body: { path: dbPath, source: 'wechat-chat' } });
ok(r.statusCode === 400 && /chat database/i.test(r.json().error), 'POST /import refuses a local chat database');

// tool execution
const statusTool = ctx.tools.get('inbox_status');
const toolOut = await statusTool.execute({}, {});
ok(toolOut.ok === true && toolOut.phase === 1 && toolOut.adapters.wired === 1, 'tool inbox_status executes (phase 1, 1 adapter)');
const importTool = ctx.tools.get('inbox_import');
const badImport = await importTool.execute({}, {});
ok(badImport.ok === false && /path is required/.test(badImport.error), 'tool inbox_import validates missing path');
const relImport = await importTool.execute({ path: 'relative/x' }, {});
ok(relImport.ok === false && /absolute/i.test(relImport.error), 'tool inbox_import rejects relative path');
const dbImport = await importTool.execute({ path: dbPath }, {});
ok(dbImport.ok === false && /chat database/i.test(dbImport.error), 'tool inbox_import refuses a local chat database');
const listTool = ctx.tools.get('inbox_list');
const listed = await listTool.execute({ limit: 10 }, {});
ok(listed.total >= 1 && listed.rows[0].id, 'tool inbox_list returns bounded rows');
const readTool = ctx.tools.get('inbox_read');
const readOut = await readTool.execute({ id }, {});
ok(readOut.ok === true && readOut.text.includes('official export'), 'tool inbox_read returns text');
const removeTool = ctx.tools.get('inbox_remove');
ok(Boolean(removeTool), 'tool inbox_remove is registered');
const removeNoId = await removeTool.execute({}, {});
ok(removeNoId.ok === false && /id is required/.test(removeNoId.error), 'tool inbox_remove requires an id');
const removeUnknown = await removeTool.execute({ id: 'no-such-id' }, {});
ok(removeUnknown.ok === false && /not found/.test(removeUnknown.error), 'tool inbox_remove reports an unknown id');
const srcTool = ctx.tools.get('inbox_sources');
const srcOut = await srcTool.execute({ tier: 'L3' }, {});
ok(Array.isArray(srcOut.sources) && srcOut.sources.every((s) => s.tier === 'L3'), 'tool inbox_sources filters by tier');
// The agent must be able to hand the user the SAME official pages the panel shows.
ok(srcOut.sources.every((s) => typeof s.auth === 'string' && Array.isArray(s.links)), 'tool inbox_sources carries auth + links');
ok(srcOut.sources.some((s) => s.links.length > 0), 'tool inbox_sources exposes at least one official link for L3');
const allOut = await srcTool.execute({}, {});
ok(allOut.status.entriesWithOfficialLink === allOut.sources.filter((s) => s.links.length > 0).length, 'tool status counts clickable rows');

// output.render
const rendered = statusTool.output.render({}, toolOut);
ok(Array.isArray(rendered) && rendered[0].type === 'text', 'output.render -> [{type:text}]');

// ---- Phase 1: adapter routes + tools ----
r = await call('/dsh-source-inbox/api/adapters');
ok(r.statusCode === 200 && r.json().phase === 1 && r.json().wired === 1, 'GET /adapters -> 200 + phase 1 + wired 1');
ok(Array.isArray(r.json().adapters) && r.json().adapters.length === 2, '/adapters exposes 2 registry entries');
ok(r.json().adapters.find((a) => a.id === 'official-mcp').state === 'needs-auth', 'official MCP honestly flagged needs-auth');
ok(/dropzone/i.test(r.json().dropzone.dir), 'default dropzone dir is <root>/dropzone');

// An in-archive watch dir must be REJECTED (feedback-loop protection).
r = await call('/dsh-source-inbox/api/adapters/dropzone', {
  method: 'POST', body: { dir: join(dataDir, 'watch-inside-archive') },
});
ok(r.statusCode === 400 && r.json().ok === false && /overlap|feedback/i.test(r.json().reason), 'dropzone rejects an in-archive dir (feedback loop)');

// configure the watcher to point at an EXTERNAL absolute dir, then scan it
const watchDir = dataDir + '-watch';
mkdirSync(watchDir, { recursive: true });
r = await call('/dsh-source-inbox/api/adapters/dropzone', {
  method: 'POST',
  body: { dir: watchDir, pollMs: 5000, source: 'dropzone', tags: ['auto'] },
});
ok(r.statusCode === 200 && r.json().ok === true, 'POST /adapters/dropzone -> 200 + ok (got ' + r.statusCode + ' ' + JSON.stringify(r.json()) + ')');
ok(r.json().dropzone.dir === watchDir, 'dropzone dir updated');

// relative dir must be rejected by the route too
r = await call('/dsh-source-inbox/api/adapters/dropzone', { method: 'POST', body: { dir: 'relative/x' } });
ok(r.statusCode === 400 && r.json().ok === false, 'POST /adapters/dropzone rejects a relative dir');

writeFileSync(join(watchDir, 'auto-note.md'), '# auto picked up\n', 'utf8');
r = await call('/dsh-source-inbox/api/adapters/dropzone/scan', { method: 'POST' });
ok(r.statusCode === 200 && r.json().imported >= 1, 'POST /adapters/dropzone/scan imports a dropped file');

const adaptersTool = ctx.tools.get('inbox_adapters');
const adOut = await adaptersTool.execute({}, {});
ok(adOut.ok === true && adOut.wired === 1, 'tool inbox_adapters executes');
const watchTool = ctx.tools.get('inbox_watch');
const watchOut = await watchTool.execute({ enabled: false }, {});
ok(watchOut.ok === true && watchOut.dropzone.enabled === false, 'tool inbox_watch configures the watcher');
const scanTool = ctx.tools.get('inbox_scan');
const scanOut = await scanTool.execute({}, {});
ok(scanOut.ok === true && typeof scanOut.imported === 'number', 'tool inbox_scan forces a bounded scan');

// ---- Phase 2: per-source steps + whitelisted logged-in reading ----
r = await call('/dsh-source-inbox/api/sources');
const phase2Sources = r.json().sources;
ok(phase2Sources.every((s) => Array.isArray(s.steps)), 'every row serializes steps[]');
ok(phase2Sources.filter((s) => s.steps.length >= 2).length === phase2Sources.length, 'every row carries >= 2 steps of follow-up guidance');
ok(phase2Sources.every((s) => s.steps.every((st) => typeof st.doing === 'string' && st.doing.length > 6)), 'every step says what to do');
ok(phase2Sources.some((s) => s.steps.some((st) => st.get && st.where)), 'some steps say what you get and where it goes (feishu-style)');
ok(phase2Sources.every((s) => Array.isArray(s.reads)), 'every row serializes reads[]');
ok(r.json().status.entriesWithSteps === phase2Sources.length, 'sourceStatus.entriesWithSteps matches the rows');
ok(r.json().status.readableSources === phase2Sources.filter((s) => s.reads.length > 0).length, 'sourceStatus.readableSources matches the rows');
ok(phase2Sources.filter((s) => s.reads.length > 0).length >= 5, 'at least 5 sources are readable by the plugin itself');

// every readable page is https and carries a non-empty host whitelist
const readableRows = phase2Sources.flatMap((s) => s.reads.map((x) => ({ id: s.id, ...x })));
ok(readableRows.length >= 8, `registry exposes >= 8 readable pages (got ${readableRows.length})`);
ok(readableRows.every((p) => /^https:\/\//.test(p.url)), 'every readable page is https');
ok(readableRows.every((p) => Array.isArray(p.hosts) && p.hosts.length > 0), 'every readable page has a host whitelist (no open scraper)');
ok(readableRows.every((p) => p.hosts.some((h) => new URL(p.url).hostname === h || new URL(p.url).hostname.endsWith('.' + h))), 'each whitelist actually covers its own url host');
// the 抖音 case the user called out must be readable
const creator = phase2Sources.find((s) => s.id === 'creator-video');
ok(!!creator && creator.reads.some((p) => /creator\.douyin\.com/.test(p.url)), '抖音「我的作品」is a readable page');
ok(creator.reads.some((p) => p.scrollSteps > 0), '抖音 list page asks for scroll-to-load (lazy list)');

// GET /browser/status: probes the real port, reports availability honestly
r = await call('/dsh-source-inbox/api/browser/status');
ok(r.statusCode === 200 && r.json().ok === true, 'GET /browser/status -> 200');
ok(typeof r.json().running === 'boolean', '/browser/status reports a boolean running flag');
ok(Array.isArray(r.json().pages) && r.json().pages.length >= 8, '/browser/status lists the readable pages');
ok(typeof r.json().browserPath === 'string', '/browser/status reports the resolved browser path');

// POST /browser/open must refuse anything that is not a registered entry url
r = await call('/dsh-source-inbox/api/browser/open', { method: 'POST', body: { url: 'https://evil.example.com/login' } });
ok(r.statusCode === 400 && /not a registered official entry/i.test(r.json().error), '/browser/open refuses an unregistered url');
r = await call('/dsh-source-inbox/api/browser/open', { method: 'POST', body: { url: 'http://creator.douyin.com' } });
ok(r.statusCode === 400 && /https/i.test(r.json().error), '/browser/open refuses http (https only)');

// POST /browser/read: validates source + whitelist BEFORE touching a browser
r = await call('/dsh-source-inbox/api/browser/read', { method: 'POST', body: { source: 'nope' } });
ok(r.statusCode === 400 && /unknown source/i.test(r.json().error), '/browser/read rejects an unknown source');
r = await call('/dsh-source-inbox/api/browser/read', { method: 'POST', body: { source: 'obsidian' } });
ok(r.statusCode === 400 && /no readable page/i.test(r.json().error), '/browser/read refuses a row with no readable page');

// tools: inbox_browser / inbox_open_login / inbox_read_page
const browserTool = ctx.tools.get('inbox_browser');
const brOut = await browserTool.execute({}, {});
ok(brOut.ok === true && Array.isArray(brOut.pages) && brOut.pages.length >= 8, 'tool inbox_browser lists readable pages');
const openTool = ctx.tools.get('inbox_open_login');
const openBad = await openTool.execute({ url: 'https://evil.example.com/x' }, {});
ok(openBad.ok === false && /not a registered official entry/i.test(openBad.error), 'tool inbox_open_login refuses an unregistered url');
const openEmpty = await openTool.execute({}, {});
ok(openEmpty.ok === false && /invalid url/i.test(openEmpty.error), 'tool inbox_open_login validates a missing url');
const readPageTool = ctx.tools.get('inbox_read_page');
const rpBad = await readPageTool.execute({ source: 'nope' }, {});
ok(rpBad.ok === false && /unknown source/i.test(rpBad.error), 'tool inbox_read_page rejects an unknown source');
const rpObsidian = await readPageTool.execute({ source: 'obsidian' }, {});
ok(rpObsidian.ok === false && /no readable page/i.test(rpObsidian.error), 'tool inbox_read_page refuses a row with no readable page');
const srcOut2 = await ctx.tools.get('inbox_sources').execute({}, {});
ok(srcOut2.sources.every((s) => Array.isArray(s.steps) && Array.isArray(s.reads)), 'tool inbox_sources carries steps + reads');

// ---- Phase 2: a login wall must be reported, not archived as content ----
// A logged-out 知乎/抖音 page returns HTTP 200 and a few hundred chars of
// 扫码登录 chrome; "ok:true, archived" would be a lie the user pays for later.
const { looksLikeLoginWall } = await import(pathToFileURL(join(root, 'lib', 'browser.js')).href);
ok(looksLikeLoginWall('打开知乎App 在「我的页」右上角打开扫一扫 其他扫码方式：微信 验证码登录密码登录 登录/注册'), 'detects a short 扫码登录 page as a login wall');
ok(looksLikeLoginWall('Sign in to continue\nEmail\nPassword') === true, 'detects an English sign-in wall');
ok(looksLikeLoginWall('请稍候…', 'https://passport.example.com/login') === true, 'a passport/login url alone marks the page as a wall');
ok(looksLikeLoginWall('xxxxx '.repeat(400) + ' 请先登录') === true, 'a long page still showing a login-box phrase is a wall');
ok(looksLikeLoginWall('创作经验分享：'.repeat(200) + '有一次登录不上后台，重装浏览器就好了') === false, 'long prose that merely uses the word 登录 is not a wall');
ok(looksLikeLoginWall('我的作品 作品数据 评论管理 数据概览 粉丝画像 播放量 12.3万 最近发布 3 条', 'https://creator.douyin.com/creator-micro/content/manage') === false, 'a real 抖音 works list is not a login wall');

// ---- Phase 2.3: credential routes never hand a secret back ----
// The host writes to a temp vault for this test; the real _secrets dir is never
// touched. The assertion that matters: no endpoint reply may contain the value.
const v = await import(pathToFileURL(join(root, 'index.js')).href);
const vaultDir = join(dataDir, 'vault');
const vctx = makeCtx();
v.apply(vctx.baseCtx, { dataDir: join(dataDir, 'v2'), secretsDir: vaultDir });
await new Promise((r2) => setTimeout(r2, 80));
const vcall = async (path, opts = {}) => {
  const entry = vctx.routes.get(path.split('?')[0]);
  if (!entry) throw new Error('no route ' + path);
  const req = makeReq({ ...opts, url: path });
  const res = makeRes();
  if (opts?.method === 'POST' && (opts.body === undefined || opts.body === null)) setImmediate(() => req.emit('end'));
  await entry.handler(req, res);
  return res;
};

ok(vctx.routes.size === 17, `the vault keeps the route count (got ${vctx.routes.size})`);
let vr = await vcall('/dsh-source-inbox/api/credentials');
ok(vr.statusCode === 200 && vr.json().ok === true, 'GET /credentials -> 200');
ok(vr.json().count === 8 && vr.json().items.length === 8, 'it lists all 8 credential sources');
ok(vr.json().configured === 0, 'nothing is configured in a fresh vault');
ok(vr.json().items.every((i) => i.fields.length > 0 && i.configured === false), 'each item carries its field list');
ok(!JSON.stringify(vr.json()).includes('_meta'), 'the vault meta key is never serialized');

vr = await vcall('/dsh-source-inbox/api/credentials?source=feishu');
ok(vr.statusCode === 200 && vr.json().item.source === 'feishu', 'GET /credentials?source=feishu returns one item');
vr = await vcall('/dsh-source-inbox/api/credentials?source=quark');
ok(vr.statusCode === 404 && /takes no credential/i.test(vr.json().error), 'a source with no credential -> 404');
vr = await vcall('/dsh-source-inbox/api/credentials?source=nope');
ok(vr.statusCode === 404, 'an unknown source -> 404');

const SECRET = 'cli_thisisthesecretvalue';
vr = await vcall('/dsh-source-inbox/api/credentials/save', { method: 'POST', body: { source: 'feishu', values: { appId: SECRET, appSecret: 'sek-abcdefgh' } } });
ok(vr.statusCode === 200 && vr.json().ok === true, 'POST /credentials/save -> 200');
ok(!JSON.stringify(vr.json()).includes(SECRET), 'the SAVE reply does not echo the secret');
ok(vr.json().status.configured === true, 'the saved source reports configured');
ok(vr.json().status.fields[0].preview.startsWith('cli_'), 'it returns a masked preview instead');

vr = await vcall('/dsh-source-inbox/api/credentials');
ok(vr.json().configured === 1, 'the list reflects the saved source');
ok(!JSON.stringify(vr.json()).includes(SECRET), 'the LIST never contains the secret either');
vr = await vcall('/dsh-source-inbox/api/credentials?source=feishu');
ok(!JSON.stringify(vr.json()).includes(SECRET), 'the single-item GET never contains the secret');
const credTool = vctx.tools.get('inbox_credentials');
const ct = await credTool.execute({}, {});
ok(ct.ok === true && ct.count === 8 && ct.configured === 1, 'tool inbox_credentials reports the saved count');
ok(!JSON.stringify(ct).includes(SECRET), 'the TOOL reply never contains the secret (it would land in the transcript)');
ok(/no tool that saves/i.test(credTool.description), 'the tool description says saving is panel-only, by design');

vr = await vcall('/dsh-source-inbox/api/credentials/save', { method: 'POST', body: { source: 'feishu', values: { appId: SECRET, evil: 'x' } } });
ok(vr.statusCode === 400 && /unknown credential field/i.test(vr.json().reason), 'an undeclared field -> 400');
vr = await vcall('/dsh-source-inbox/api/credentials/save', { method: 'POST', body: { source: 'quark', values: { a: 'b' } } });
ok(vr.statusCode === 400 && /takes no credential/i.test(vr.json().error), 'saving for a source that needs none -> 400');
vr = await vcall('/dsh-source-inbox/api/credentials/save', { method: 'POST', body: { source: 'feishu', values: ['nope'] } });
ok(vr.statusCode === 400 && /must be an object/i.test(vr.json().error), 'a non-object values payload -> 400');
vr = await vcall('/dsh-source-inbox/api/credentials/save', { method: 'POST', body: { source: 'feishu', values: {} } });
ok(vr.statusCode === 400, 'an empty values object -> 400 (nothing to save)');

vr = await vcall('/dsh-source-inbox/api/credentials/clear', { method: 'POST', body: { source: 'feishu' } });
ok(vr.statusCode === 200 && vr.json().status.configured === false, 'POST /credentials/clear unsets it');
ok(!JSON.stringify(vr.json()).includes(SECRET), 'the CLEAR reply does not echo the old value');
vr = await vcall('/dsh-source-inbox/api/credentials/clear', { method: 'POST', body: { source: 'nope' } });
ok(vr.statusCode === 400, 'clearing an unknown source -> 400');

// A relative secretsDir disables the vault instead of writing somewhere random.
const badCtx = makeCtx();
v.apply(badCtx.baseCtx, { dataDir: join(dataDir, 'v3'), secretsDir: 'relative\\vault' });
await new Promise((r3) => setTimeout(r3, 80));
const bEntry = badCtx.routes.get('/dsh-source-inbox/api/credentials');
const bReq = makeReq({ url: '/dsh-source-inbox/api/credentials' });
const bRes = makeRes();
await bEntry.handler(bReq, bRes);
ok(bRes.statusCode === 503 && /absolute path/i.test(bRes.json().error), 'a relative secretsDir -> 503, not a silent write');
for (const e of vctx.effects) { if (typeof e.cleanup === 'function') e.cleanup(); }
for (const e of badCtx.effects) { if (typeof e.cleanup === 'function') e.cleanup(); }

// cleanup: all disposers remove routes + tools
for (const e of ctx.effects) { if (typeof e.cleanup === 'function') e.cleanup(); }
ok(ctx.routes.size === 0, 'cleanup removes all 17 routes (got ' + ctx.routes.size + ')');
ok(ctx.tools.size === 0, 'cleanup removes all 13 tools (got ' + ctx.tools.size + ')');

rmSync(watchDir, { recursive: true, force: true });
rmSync(dataDir, { recursive: true, force: true });
console.log(`\n${pass} checks passed.`);
console.log('RUNTIME VERIFIED: apply() + routes + guards + tools + cleanup.');
