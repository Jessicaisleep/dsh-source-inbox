/**
 * dsh-source-inbox — Host half (Phase 0 base + Phase 1 adapters).
 *
 * Pure ESM JavaScript, zero external dependencies (only node: builtins).
 * Responsibilities (§4.4): discover already-landed export files, normalize,
 * archive with the dual-track schema, expose read routes + agent tools, serve
 * source / guidance metadata, and (Phase 1) run pluggable source adapters.
 * It does NOT log in to any platform, does NOT scrape, and does NOT read or
 * decrypt any local chat database (§2 red line, enforced in code).
 *
 * Real-installed-version references this follows:
 *  - dsh-connect-workbuddy/lib/index.js:14236 ctx.inject(['tools']) + :14292 ctx.inject(['webServer'])
 *  - dsh-connect-workbuddy/lib/index.js:12297-12948 webServer.register disposer array + ctx.effect cleanup
 *  - dsh-connect-workbuddy/lib/index.js:15565-15604 re-arming one-shot timer + cleanup clearTimeout
 *  - dshmarket/lib/routes.js:2438-2454 exact-path routes + sendJson
 */
import { isIP } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store, resolveDataDir } from './lib/store.js';
import { importPath, validateImportPath } from './lib/import.js';
import {
  LADDER, SOURCES, GROUP_LABELS, HARD_BAN, sourceStatus,
  sourceById, readablePages, credentialSources, credentialSpec,
} from './lib/sources.js';
import { AdapterRuntime } from './lib/adapters.js';
import { BrowserBridge, readAllowed, clampPort } from './lib/browser.js';
import { resolveSecretsDir, credentialStatus, saveCredential, clearCredential } from './lib/credentials.js';
// Phase 3: capabilities that used to be "install this third-party package" are
// implemented in-house — the panel must not send users searching for a name.
import { fetchDocument, slugFromTitle } from './lib/fetchdoc.js';
import { exportHighlights } from './lib/weread.js';
import { exportCards } from './lib/cubox.js';
import { fetchRecentMail, guessImapHost } from './lib/mailimap.js';

const API = '/dsh-source-inbox/api';

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function hostnameOfHost(host) {
  try { return new URL(`http://${host}`).hostname; } catch { return ''; }
}
function isLocalHostname(h) {
  const v = String(h).toLowerCase().replace(/^\[|\]$/g, '');
  return v === 'localhost' || v === '127.0.0.1' || v === '::1' || v.startsWith('127.');
}
function hostMatchesListener(host, localAddress) {
  if (!host || !host.trim()) return false;
  const hostname = hostnameOfHost(host);
  if (isLocalHostname(hostname)) return true;
  if (hostname === '0.0.0.0' || hostname === '[::]') return false;
  if (!localAddress) return false;
  const bare = (x) => (x.startsWith('[') && x.endsWith(']') ? x.slice(1, -1) : x);
  const local = bare(String(localAddress).toLowerCase());
  const hn = bare(hostname.toLowerCase());
  if (isIP(local) === 0 && isIP(hn) === 0) return false;
  return hn === local;
}
function originTrusted(origin, localAddress) {
  if (!origin || !origin.trim()) return true; // non-browser client / own fetch
  try { return hostMatchesListener(new URL(origin).host, localAddress); } catch { return false; }
}
function trusted(req, res) {
  if (!hostMatchesListener(req.headers.host, req.socket?.localAddress)) { json(res, 403, { error: 'host-not-trusted' }); return false; }
  if (!originTrusted(req.headers.origin, req.socket?.localAddress)) { json(res, 403, { error: 'origin-not-trusted' }); return false; }
  return true;
}

function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) { done = true; reject(new Error('request body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
    });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

function queryOf(req) {
  try { return new URL(req.url ?? '/', 'http://localhost').searchParams; } catch { return new URLSearchParams(); }
}

/** Build the shared runtime once; store.init() is idempotent and shared. */
function createRuntime(config) {
  const dataDir = resolveDataDir(config);
  const store = new Store(dataDir);
  // Phase 1: adapter config lives in <dataDir>/adapters.json, NOT in the
  // profile's cordis.patch.yml (configuration.md forbids rewriting it).
  const adapters = new AdapterRuntime(store, dataDir, config?.dropzone ?? {});
  // Phase 2: a plugin-owned Chromium profile used ONLY for the user's own
  // logged-in pages that the registry whitelists (lib/browser.js explains why
  // it must be a separate profile rather than the user's daily browser).
  const browser = new BrowserBridge(dataDir, {
    port: clampPort(config?.browser?.port),
    browserPath: config?.browser?.path,
  });
  const ready = store.init().then(() => adapters.load());
  // Phase 2.3: the credential vault. A source that needs an App Secret gets a
  // paste box in the panel instead of a "填到 C:\...\feishu.json" line that
  // silently demanded the user create the file and guess the JSON keys.
  const secrets = resolveSecretsDir(config);
  if (!secrets.ok) console.warn('[dsh-source-inbox] credential vault disabled:', secrets.reason);
  return { store, ready, adapters, browser, config, dataDir, secrets };
}

/**
 * Only let the controlled browser be pointed at a URL the registry already
 * knows: an official entry link, or a whitelisted readable page. This keeps the
 * "open a login page" button from becoming an open redirect into a fresh
 * plugin-owned browser profile.
 */
function validateEntryUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return { ok: false, reason: 'invalid url' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'only https urls are allowed' };
  if (u.username || u.password) return { ok: false, reason: 'url must not embed credentials' };
  const value = u.toString();
  const known = readablePages().some((p) => p.url === value || p.url === String(raw))
    || SOURCES.some((s) => s.links.some((l) => l.url === value || l.url === String(raw)));
  if (!known) return { ok: false, reason: `url is not a registered official entry: ${value}` };
  return { ok: true, url: value };
}

/**
 * Archive a page the plugin read into the text track, so a read is not a dead
 * end: it becomes a searchable record with a real Markdown body.
 */
async function archiveRead(rt, sourceId, page, result) {
  const source = sourceById(sourceId);
  const title = String(result.title || page.label || page.url).trim() || page.url;
  const body = [
    `# ${title}`,
    '',
    `- 来源：${source?.label ?? sourceId}（${sourceId}）`,
    `- 页面：${result.url || page.url}`,
    `- 读取方式：插件独立浏览器 profile（L2 登录态），用户本人账号`,
    `- 读取时间：${new Date().toISOString()}`,
    '',
    '> 页面可见文本，未经人工校对；只归档本人账号可见内容。',
    '',
    result.text || '(空)',
  ].join('\n');
  const buf = Buffer.from(body, 'utf8');
  const { record, duplicate } = await rt.store.put({
    buf,
    record: {
      source: sourceId,
      sourceType: 'document',
      title,
      mimeType: 'text/markdown',
      storage: 'materialized',
      tags: ['l2-read', sourceId],
      remoteRef: result.url || page.url,
    },
    markdown: body,
  });
  return { record, duplicate };
}

/**
 * Read one saved credential field, straight from the vault.
 *
 * Deliberately narrow: only the in-house exporters call this, only for their own
 * source, and the value goes into an outbound request — never into a response,
 * a log line, or a tool result.
 */
async function readSecret(rt, sourceId, fieldKey) {
  const spec = credentialSpec(sourceId);
  if (!spec) return { ok: false, reason: `source "${sourceId}" takes no credential` };
  if (!rt.secrets.ok) return { ok: false, reason: rt.secrets.reason };
  const file = spec.file;
  try {
    const text = await readFile(join(rt.secrets.dir, file), 'utf8');
    const parsed = JSON.parse(text);
    const value = typeof parsed?.[fieldKey] === 'string' ? parsed[fieldKey].trim() : '';
    if (!value) return { ok: false, reason: `还没有保存 ${fieldKey}（先在上面那个输入框里粘贴并保存）` };
    return { ok: true, value };
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, reason: `还没有保存 ${sourceId} 的凭据（先在上面那个输入框里粘贴并保存）` };
    return { ok: false, reason: `读取凭据失败：${String(error?.message ?? error).slice(0, 120)}` };
  }
}

/**
 * Archive an in-house export (weread / cubox / email / fetched link) as one
 * Markdown record. Same shape as archiveRead so the panel and the KB see one
 * kind of thing regardless of which exporter produced it.
 */
async function archiveDoc(rt, sourceId, doc) {
  const title = String(doc.title ?? '').trim() || '(无标题)';
  const markdown = String(doc.markdown ?? '').trim();
  const buf = Buffer.from(markdown, 'utf8');
  const { record, duplicate } = await rt.store.put({
    buf,
    record: {
      source: sourceId,
      sourceType: 'document',
      title,
      mimeType: 'text/markdown',
      storage: 'materialized',
      tags: ['export', sourceId],
      remoteRef: doc.remoteRef ?? '',
    },
    markdown,
  });
  return { record, duplicate };
}

/* ------------------------------------------------------------------ routes */

function mountRoutes(ctx, rt) {
  ctx.effect(() => {
    const disposers = [];
    const route = (entry) => { disposers.push(ctx.webServer.register(entry)); };
    const wrap = (spec, run) => route({
      kind: 'exact',
      path: spec.path,
      handler: async (req, res) => {
        if (req.method !== spec.method) { res.writeHead(405, { allow: spec.method }); res.end(); return; }
        if (!trusted(req, res)) return;
        try {
          await rt.ready;
          await run(req, res);
        } catch (error) {
          json(res, 500, { error: String(error?.message ?? error) });
        }
      },
    });

    wrap({ path: `${API}/status`, method: 'GET' }, async (_req, res) => {
      const src = sourceStatus(rt.adapters.wiredCount());
      json(res, 200, {
        ok: true,
        name: 'dsh-source-inbox',
        phase: src.phase,
        root: rt.store.root,
        stats: rt.store.stats(),
        sources: src,
        adaptersWired: rt.adapters.wiredCount(),
      });
    });

    wrap({ path: `${API}/list`, method: 'GET' }, async (req, res) => {
      const q = queryOf(req);
      const rows = rt.store.list({
        source: q.get('source') || undefined,
        storage: q.get('storage') || undefined,
        tag: q.get('tag') || undefined,
        q: q.get('q') || undefined,
        limit: Number(q.get('limit') || 200),
      });
      json(res, 200, { total: rows.length, rows });
    });

    wrap({ path: `${API}/stats`, method: 'GET' }, async (_req, res) => {
      json(res, 200, rt.store.stats());
    });

    wrap({ path: `${API}/sources`, method: 'GET' }, async (_req, res) => {
      json(res, 200, { ladder: LADDER, sources: SOURCES, groups: GROUP_LABELS, hardBan: HARD_BAN, status: sourceStatus(rt.adapters.wiredCount()) });
    });

    wrap({ path: `${API}/read`, method: 'GET' }, async (req, res) => {
      const id = queryOf(req).get('id') || '';
      const result = await rt.store.readText(id, Number(queryOf(req).get('maxChars') || 8000));
      if (!result) return json(res, 404, { error: 'not found', id });
      json(res, 200, result);
    });

    // Taking a record back out is a first-class need: a wrong read (e.g. a
    // login page that slipped through as content) must not stay in the
    // knowledge base forever. POST rather than DELETE so the client and the
    // agent tools share one shape with every other mutating call.
    wrap({ path: `${API}/remove`, method: 'POST' }, async (req, res) => {
      const body = await readJsonBody(req);
      const id = String(body.id ?? '').trim();
      if (!id) return json(res, 400, { ok: false, error: 'id is required' });
      const removed = await rt.store.remove(id);
      if (!removed) return json(res, 404, { ok: false, error: 'not found', id });
      json(res, 200, { ok: true, removed: removed.id, title: removed.title, source: removed.source });
    });

    wrap({ path: `${API}/import`, method: 'POST' }, async (req, res) => {
      const body = await readJsonBody(req);
      const path = String(body.path ?? '').trim();
      const gate = validateImportPath(path);
      if (!gate.ok) return json(res, 400, { error: gate.reason });
      const summary = await importPath(rt.store, path, {
        source: String(body.source ?? 'import'),
        tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
      });
      // Bounded echo: never dump every file back on a large import.
      json(res, 200, {
        imported: summary.imported.length,
        duplicates: summary.duplicates.length,
        skipped: summary.skipped.length,
        errors: summary.errors.length,
        sample: summary.imported.slice(0, 5),
        errorRows: summary.errors.slice(0, 5),
      });
    });

    // ---- Phase 1: adapter registry / dropzone control ----
    wrap({ path: `${API}/adapters`, method: 'GET' }, async (_req, res) => {
      json(res, 200, rt.adapters.status());
    });

    wrap({ path: `${API}/adapters/dropzone`, method: 'POST' }, async (req, res) => {
      const body = await readJsonBody(req);
      const result = await rt.adapters.configureDropzone(body);
      json(res, result.ok ? 200 : 400, result);
    });

    wrap({ path: `${API}/adapters/dropzone/scan`, method: 'POST' }, async (_req, res) => {
      const summary = await rt.adapters.scanOnce(true);
      json(res, 200, { ok: true, ...summary });
    });

    // ---- Phase 2: read the user's own logged-in pages ----
    wrap({ path: `${API}/browser/status`, method: 'GET' }, async (_req, res) => {
      json(res, 200, { ok: true, ...(await rt.browser.status()), pages: readablePages() });
    });

    // Launch the controlled browser at an official login page so the NEXT click
    // ("让插件自己读") actually has a session to reuse. Only https URLs that the
    // registry already lists as an entry link or a readable page are allowed.
    wrap({ path: `${API}/browser/open`, method: 'POST' }, async (req, res) => {
      const body = await readJsonBody(req);
      const url = String(body.url ?? '').trim();
      const urlGate = validateEntryUrl(url);
      if (!urlGate.ok) return json(res, 400, { error: urlGate.reason });
      const result = await rt.browser.openPage(url, { headless: body.headless === true });
      json(res, result.ok ? 200 : 500, result);
    });

    wrap({ path: `${API}/browser/read`, method: 'POST' }, async (req, res) => {
      const body = await readJsonBody(req);
      const sourceId = String(body.source ?? '').trim();
      const source = sourceById(sourceId);
      if (!source) return json(res, 400, { error: `unknown source: ${sourceId || '(empty)'}` });
      if (!source.reads.length) {
        return json(res, 400, { error: `source "${sourceId}" has no readable page (no logged-in web reading for this source)` });
      }
      // Pick the requested page by label/index, defaulting to the first one.
      const wanted = body.page === undefined ? 0 : body.page;
      const page = typeof wanted === 'number'
        ? source.reads[Math.max(0, Math.min(source.reads.length - 1, Math.trunc(wanted)))]
        : source.reads.find((r) => r.label === String(wanted)) ?? null;
      if (!page) return json(res, 400, { error: `no such page on ${sourceId}: ${String(wanted)}` });

      // The whitelist is enforced here, at the only place a page URL enters the
      // reader — a caller cannot pass an arbitrary URL past this point.
      if (!readAllowed(page.url, page.hosts)) {
        return json(res, 400, { error: `refusing to read outside the whitelist: ${page.url}` });
      }
      const result = await rt.browser.readPage(page.url, {
        headless: body.headless !== false,
        maxChars: body.maxChars,
        scrollSteps: page.scrollSteps,
      });
      if (!result.ok) return json(res, 502, { error: result.reason, page: page.label, url: page.url });
      // A logged-out page is not content: report it and skip archiving so the
      // inbox does not fill up with 扫码登录 chrome.
      if (result.loginRequired) {
        return json(res, 200, {
          ok: true,
          loginRequired: true,
          source: sourceId,
          page: page.label,
          url: result.url,
          title: result.title,
          chars: result.chars,
          text: result.text,
          archived: null,
        });
      }
      let archived = null;
      if (body.archive !== false) {
        const saved = await archiveRead(rt, sourceId, page, result);
        archived = { id: saved.record.id, duplicate: saved.duplicate };
      }
      json(res, 200, {
        ok: true,
        source: sourceId,
        page: page.label,
        url: result.url,
        title: result.title,
        chars: result.chars,
        truncated: result.truncated,
        text: result.text,
        archived,
      });
    });

    wrap({ path: `${API}/browser/stop`, method: 'POST' }, async (_req, res) => {
      json(res, 200, { ok: true, ...(await rt.browser.stop()) });
    });

    // ---- Phase 2.3: credential vault (paste a token, we save it) ----
    // The reply NEVER contains a saved value — only a masked preview, so the
    // secret cannot leak through the panel, a log line, or a tool result.
    wrap({ path: `${API}/credentials`, method: 'GET' }, async (req, res) => {
      if (!rt.secrets.ok) return json(res, 503, { ok: false, error: rt.secrets.reason });
      const wanted = queryOf(req).get('source') || '';
      if (wanted) {
        const spec = credentialSpec(wanted);
        if (!spec) return json(res, 404, { ok: false, error: `source "${wanted}" takes no credential` });
        return json(res, 200, { ok: true, dir: rt.secrets.dir, item: await credentialStatus(rt.secrets.dir, spec.sourceId, spec) });
      }
      const items = [];
      for (const c of credentialSources()) {
        items.push(await credentialStatus(rt.secrets.dir, c.id, { file: c.credential.file, fields: c.credential.fields }));
      }
      json(res, 200, {
        ok: true,
        dir: rt.secrets.dir,
        count: items.length,
        configured: items.filter((i) => i.configured).length,
        items,
      });
    });

    wrap({ path: `${API}/credentials/save`, method: 'POST' }, async (req, res) => {
      if (!rt.secrets.ok) return json(res, 503, { ok: false, error: rt.secrets.reason });
      const body = await readJsonBody(req);
      const sourceId = String(body.source ?? '').trim();
      const spec = credentialSpec(sourceId);
      if (!spec) return json(res, 400, { ok: false, error: `source "${sourceId || '(empty)'}" takes no credential` });
      const values = body.values ?? body.fields ?? {};
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        return json(res, 400, { ok: false, error: 'values must be an object of field -> string' });
      }
      const saved = await saveCredential(rt.secrets.dir, spec.sourceId, spec, values);
      json(res, saved.ok ? 200 : 400, saved);
    });

    wrap({ path: `${API}/credentials/clear`, method: 'POST' }, async (req, res) => {
      if (!rt.secrets.ok) return json(res, 503, { ok: false, error: rt.secrets.reason });
      const body = await readJsonBody(req);
      const sourceId = String(body.source ?? '').trim();
      const spec = credentialSpec(sourceId);
      if (!spec) return json(res, 400, { ok: false, error: `source "${sourceId || '(empty)'}" takes no credential` });
      json(res, 200, await clearCredential(rt.secrets.dir, spec.sourceId, spec));
    });

    // ---- Phase 3: in-house exporters ----
    // Each of these used to be a line of guidance telling the user to install
    // some third-party package. The capability now lives in this plugin, so the
    // panel has a button and the user installs nothing.

    // Paste one https link, get Markdown in the KB. Replaces the old
    // "交给 envoy-dsh / dsh-link-parse" instruction.
    wrap({ path: `${API}/fetch/url`, method: 'POST' }, async (req, res) => {
      const body = await readJsonBody(req);
      const result = await fetchDocument(body.url, { maxChars: body.maxChars });
      if (!result.ok) return json(res, 400, { ok: false, error: result.reason });
      let archived = null;
      if (body.archive !== false) {
        archived = await archiveDoc(rt, String(body.source ?? 'link-parse'), {
          title: result.title || slugFromTitle(result.title, 'link'),
          markdown: [
            `# ${result.title || result.url}`,
            '',
            `- 原文：${result.url}`,
            `- 抓取时间：${new Date().toISOString()}`,
            '',
            '> 由 dsh-source-inbox 直接抓取页面正文并转 Markdown；仅本地归档。',
            '',
            result.markdown,
          ].join('\n'),
          remoteRef: result.url,
        });
      }
      json(res, 200, {
        ok: true,
        url: result.url,
        title: result.title,
        chars: result.chars,
        truncated: result.truncated,
        markdown: result.markdown,
        archived: archived ? { id: archived.record.id, duplicate: archived.duplicate } : null,
      });
    });

    // WeRead highlights -> one Markdown record per book. Replaces weread-export.
    wrap({ path: `${API}/export/weread`, method: 'POST' }, async (req, res) => {
      const body = await readJsonBody(req);
      const cookie = await readSecret(rt, 'weread', 'cookie');
      if (!cookie.ok) return json(res, 400, { ok: false, error: cookie.reason });
      const out = await exportHighlights(cookie.value, { limit: body.limit });
      if (!out.ok) return json(res, 400, { ok: false, error: out.reason });
      const archived = [];
      for (const doc of out.docs) {
        const a = await archiveDoc(rt, 'weread', {
          title: doc.book.title,
          markdown: doc.markdown,
          remoteRef: `https://weread.qq.com/web/bookDetail/${doc.book.bookId}`,
        });
        archived.push({ id: a.record.id, title: doc.book.title, highlights: doc.count, duplicate: a.duplicate });
      }
      json(res, 200, {
        ok: true,
        shelfTotal: out.shelfTotal,
        scanned: out.scanned,
        exported: archived.length,
        archived,
        failures: out.failures,
      });
    });

    // Cubox cards -> one Markdown record each. Replaces dsh-cubox.
    wrap({ path: `${API}/export/cubox`, method: 'POST' }, async (req, res) => {
      const body = await readJsonBody(req);
      const api = await readSecret(rt, 'cubox', 'apiUrl');
      if (!api.ok) return json(res, 400, { ok: false, error: api.reason });
      const out = await exportCards(api.value, { limit: body.limit });
      if (!out.ok) return json(res, 400, { ok: false, error: out.reason });
      const archived = [];
      for (const doc of out.docs) {
        const a = await archiveDoc(rt, 'cubox', {
          title: doc.card.title || doc.card.url,
          markdown: doc.markdown,
          remoteRef: doc.card.url,
        });
        archived.push({ id: a.record.id, title: doc.card.title, duplicate: a.duplicate });
      }
      json(res, 200, { ok: true, fetched: out.count, exported: archived.length, archived });
    });

    // Newest mail over IMAP -> one Markdown record each. Replaces dsh-email.
    wrap({ path: `${API}/export/mail`, method: 'POST' }, async (req, res) => {
      const body = await readJsonBody(req);
      const host = await readSecret(rt, 'email', 'host');
      if (!host.ok) return json(res, 400, { ok: false, error: host.reason });
      const user = await readSecret(rt, 'email', 'user');
      if (!user.ok) return json(res, 400, { ok: false, error: user.reason });
      const password = await readSecret(rt, 'email', 'password');
      if (!password.ok) return json(res, 400, { ok: false, error: password.reason });
      const out = await fetchRecentMail({
        host: host.value,
        user: user.value,
        password: password.value,
        limit: body.limit,
      });
      if (!out.ok) return json(res, 400, { ok: false, error: out.reason });
      const archived = [];
      for (const doc of out.docs) {
        const a = await archiveDoc(rt, 'email', {
          title: doc.message.subject || '(无主题)',
          markdown: doc.markdown,
          remoteRef: doc.message.messageId ? `mid:${doc.message.messageId}` : '',
        });
        archived.push({ id: a.record.id, title: doc.message.subject, duplicate: a.duplicate });
      }
      json(res, 200, { ok: true, exists: out.exists, fetched: out.count, exported: archived.length, archived });
    });

    return () => { for (const dispose of disposers) dispose(); };
  }, 'dsh-source-inbox: API routes');
}

/* ------------------------------------------------------------------- tools */

function renderResult(_args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}
const OUTPUT = { schema: { type: 'object' }, render: renderResult };

function mountTools(ctx, rt) {
  ctx.effect(() => {
    const tools = ctx.tools;
    if (tools === undefined || typeof tools.register !== 'function') return () => {};
    const disposers = [];
    const reg = (def) => {
      try { disposers.push(tools.register(def)); } catch (e) { console.warn('[dsh-source-inbox] tool register failed:', e?.message); }
    };

    reg({
      name: 'inbox_status',
      description: 'Overview of the source inbox: data dir, counts by storage track / source, pending text shadows, wired adapters, and the four-tier source-ladder status. Use first to see what is already archived.',
      parameters: { type: 'object', properties: {}, required: [] },
      output: OUTPUT,
      async execute() {
        await rt.ready;
        const src = sourceStatus(rt.adapters.wiredCount());
        return { ok: true, phase: src.phase, root: rt.store.root, stats: rt.store.stats(), sources: src, adapters: rt.adapters.status() };
      },
    });

    reg({
      name: 'inbox_sources',
      description: 'List the planned data sources grouped by tier (L0 official API, L1 limited API, L2 logged-in web, L3 export/share) with the official export / share guidance for each, plus the hard compliance red line. Automatic adapters are wired per Phase 1.',
      parameters: { type: 'object', properties: { tier: { type: 'string', description: 'Optional filter: L0 | L1 | L2 | L3 | BAN' }, group: { type: 'string', description: 'Optional group filter: A-G' } }, required: [] },
      output: OUTPUT,
      async execute(args) {
        const tier = args?.tier ? String(args.tier).toUpperCase() : undefined;
        const group = args?.group ? String(args.group).toUpperCase() : undefined;
        const sources = SOURCES.filter((s) => (!tier || s.tier === tier) && (!group || s.group === group));
        return { ladder: LADDER, groups: GROUP_LABELS, hardBan: HARD_BAN, status: sourceStatus(rt.adapters.wiredCount()), sources };
      },
    });

    reg({
      name: 'inbox_list',
      description: 'List archived inbox records (bounded). Returns id/title/source/storage/mime/size/tags — not file bodies. Filter by source, storage (materialized|reference), tag, or a title substring.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Filter by source id, e.g. feishu / wechat-chat' },
          storage: { type: 'string', enum: ['materialized', 'reference'], description: 'Filter by storage track' },
          tag: { type: 'string', description: 'Filter by tag' },
          q: { type: 'string', description: 'Title substring search' },
          limit: { type: 'number', description: 'Max rows (1-500, default 200)' },
        },
        required: [],
      },
      output: OUTPUT,
      async execute(args) {
        await rt.ready;
        const rows = rt.store.list({
          source: args?.source, storage: args?.storage, tag: args?.tag, q: args?.q,
          limit: args?.limit ?? 200,
        });
        return {
          total: rows.length,
          rows: rows.map((r) => ({ id: r.id, title: r.title, source: r.source, storage: r.storage, mimeType: r.mimeType, sizeBytes: r.sizeBytes, tags: r.tags, capturedAt: r.capturedAt })),
        };
      },
    });

    reg({
      name: 'inbox_read',
      description: 'Read the normalized Markdown / text shadow of one archived record by id (bounded). Use inbox_list first to get ids. The text is truncated at maxChars with an explicit marker.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Record id from inbox_list' }, maxChars: { type: 'number', description: 'Max characters (default 8000)' } },
        required: ['id'],
      },
      output: OUTPUT,
      async execute(args) {
        await rt.ready;
        const result = await rt.store.readText(String(args?.id ?? ''), Number(args?.maxChars ?? 8000));
        if (!result) return { ok: false, error: 'not found', id: args?.id };
        return { ok: true, id: args.id, truncated: result.truncated, missing: result.missing, text: result.text };
      },
    });

    reg({
      name: 'inbox_import',
      description: 'Import an official export / share bundle into the inbox. Give an ABSOLUTE path to a file or directory (e.g. a WeChat 合并转发 ZIP, a DeepSeek export, a Yuque Markdown export folder). Files are sniffed by magic bytes (correcting wrong extensions), MIME-classified, de-duplicated by checksum, and archived on the dual track. Returns bounded counts. Never reads or decrypts a local chat database — only user-produced export files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'ABSOLUTE path to the export file or directory' },
          source: { type: 'string', description: 'Source id for the records (default: import), e.g. wechat-chat / deepseek-web' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
        },
        required: ['path'],
      },
      output: OUTPUT,
      async execute(args) {
        await rt.ready;
        const path = String(args?.path ?? '').trim();
        const gate = validateImportPath(path);
        if (!gate.ok) return { ok: false, error: gate.reason };
        const summary = await importPath(rt.store, path, {
          source: String(args?.source ?? 'import'),
          tags: Array.isArray(args?.tags) ? args.tags.map(String) : [],
        });
        return {
          ok: true,
          imported: summary.imported.length,
          duplicates: summary.duplicates.length,
          skipped: summary.skipped.length,
          errors: summary.errors.length,
          sample: summary.imported.slice(0, 5),
          errorRows: summary.errors.slice(0, 5),
        };
      },
    });

    // ---- Phase 1: adapter tools ----
    reg({
      name: 'inbox_adapters',
      description: 'Show the automatic source adapters: the live dropzone watcher (watched dir, poll interval, counts, enabled) and the official MCP/API adapter that still needs a one-time user authorization. Use this to see what is wired before configuring.',
      parameters: { type: 'object', properties: {}, required: [] },
      output: OUTPUT,
      async execute() {
        await rt.ready;
        return { ok: true, ...rt.adapters.status() };
      },
    });

    reg({
      name: 'inbox_watch',
      description: 'Configure the dropzone watcher: point it at an ABSOLUTE directory that receives official export / share files, and it will auto-import new files (magic-byte correction, de-dup, dual-track archive, compliance gate). All options optional; dir must be absolute and must not overlap the inbox archive. Returns the new bounded status.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string', description: 'ABSOLUTE path to the dropzone directory' },
          enabled: { type: 'boolean', description: 'Enable/disable automatic scanning (normal scans no-op when disabled)' },
          pollMs: { type: 'number', description: 'Poll interval ms (500-600000, default 5000)' },
          minAgeMs: { type: 'number', description: 'Min file age ms before ingesting, avoids half-writes (0-60000, default 1500)' },
          source: { type: 'string', description: 'Source id for imported records (default dropzone)' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags (max 20)' },
        },
        required: [],
      },
      output: OUTPUT,
      async execute(args) {
        await rt.ready;
        return rt.adapters.configureDropzone(args ?? {});
      },
    });

    reg({
      name: 'inbox_scan',
      description: 'Force one immediate scan of the dropzone directory (ignores the poll timer and the enabled flag). Returns bounded counts of imported / duplicate / skipped / error files. Use after dropping export files to ingest them right away.',
      parameters: { type: 'object', properties: {}, required: [] },
      output: OUTPUT,
      async execute() {
        await rt.ready;
        const summary = await rt.adapters.scanOnce(true);
        return { ok: true, ...summary };
      },
    });

    // ---- Phase 2: logged-in page reading ----
    reg({
      name: 'inbox_browser',
      description: 'Status of the plugin-owned controlled browser (separate Chromium profile in <dataDir>/browser-profile): whether it is running, which browser binary was found, how many pages were read, plus every readable page the source registry whitelists. Use before inbox_read_page.',
      parameters: { type: 'object', properties: {}, required: [] },
      output: OUTPUT,
      async execute() {
        await rt.ready;
        return { ok: true, ...(await rt.browser.status()), pages: readablePages() };
      },
    });

    reg({
      name: 'inbox_open_login',
      description: 'Open a source official login / authorization page inside the plugin-owned controlled browser, so that a later inbox_read_page can reuse that session. The URL must already be registered (an official entry link or a whitelisted readable page) — arbitrary URLs are rejected. The window is visible on purpose: the user has to scan a QR code.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Official https URL from the source registry (see inbox_browser pages / inbox_sources links)' },
          headless: { type: 'boolean', description: 'Run without a window (default false — the user must see the login page)' },
        },
        required: ['url'],
      },
      output: OUTPUT,
      async execute(args) {
        const gate = validateEntryUrl(String(args?.url ?? ''));
        if (!gate.ok) return { ok: false, error: gate.reason };
        return rt.browser.openPage(gate.url, { headless: args?.headless === true });
      },
    });

    reg({
      name: 'inbox_read_page',
      description: 'Read one of the user\'s OWN logged-in pages (L2) through the controlled browser and archive the visible text as a Markdown record. Only pages whitelisted by the source registry can be read; the host allowlist is enforced here. Pass a source id from inbox_sources; optionally pick a page by index or label. Never returns credentials and never reads anything outside the whitelist.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Source id with a readable page, e.g. creator-video / zhihu / cubox / wechat-mp' },
          page: { description: 'Which readable page: a 0-based index or the page label', oneOf: [{ type: 'number' }, { type: 'string' }] },
          maxChars: { type: 'number', description: 'Max characters of text to return (200-60000, default 12000)' },
          archive: { type: 'boolean', description: 'Archive the text as a record (default true)' },
          headless: { type: 'boolean', description: 'Read without a window (default true)' },
        },
        required: ['source'],
      },
      output: OUTPUT,
      async execute(args) {
        await rt.ready;
        const sourceId = String(args?.source ?? '').trim();
        const source = sourceById(sourceId);
        if (!source) return { ok: false, error: `unknown source: ${sourceId || '(empty)'}` };
        if (!source.reads.length) return { ok: false, error: `source "${sourceId}" has no readable page` };
        const wanted = args?.page === undefined ? 0 : args.page;
        const page = typeof wanted === 'number'
          ? source.reads[Math.max(0, Math.min(source.reads.length - 1, Math.trunc(wanted)))]
          : source.reads.find((r) => r.label === String(wanted)) ?? null;
        if (!page) return { ok: false, error: `no such page on ${sourceId}` };
        if (!readAllowed(page.url, page.hosts)) return { ok: false, error: `refusing to read outside the whitelist: ${page.url}` };
        const result = await rt.browser.readPage(page.url, {
          headless: args?.headless !== false,
          maxChars: args?.maxChars,
          scrollSteps: page.scrollSteps,
        });
        if (!result.ok) return { ok: false, error: result.reason, page: page.label, url: page.url };
        if (result.loginRequired) {
          return {
            ok: true, loginRequired: true, source: sourceId, page: page.label, url: result.url,
            title: result.title, chars: result.chars, text: result.text, archived: null,
            hint: 'this page is a login wall — open the login page in the controlled browser (inbox_open_login), log in, then read again',
          };
        }
        let archived = null;
        if (args?.archive !== false) {
          const saved = await archiveRead(rt, sourceId, page, result);
          archived = { id: saved.record.id, duplicate: saved.duplicate };
        }
        return {
          ok: true, source: sourceId, page: page.label, url: result.url,
          title: result.title, chars: result.chars, truncated: result.truncated,
          text: result.text, archived,
        };
      },
    });

    reg({
      name: 'inbox_credentials',
      description: 'Which sources already have a saved credential in the local vault (~\\_secrets), plus the exact field names each source expects. Read-only: it reports saved/not-saved and a masked preview, never the secret itself. There is deliberately NO tool that saves a credential — a secret typed into a tool argument would land in the conversation transcript; the panel has a paste box for that instead.',
      parameters: {
        type: 'object',
        properties: { source: { type: 'string', description: 'Optional source id, e.g. feishu / email / cubox' } },
        required: [],
      },
      output: OUTPUT,
      async execute(args) {
        await rt.ready;
        if (!rt.secrets.ok) return { ok: false, error: rt.secrets.reason };
        const wanted = String(args?.source ?? '').trim();
        if (wanted) {
          const spec = credentialSpec(wanted);
          if (!spec) return { ok: false, error: `source "${wanted}" takes no credential` };
          return { ok: true, dir: rt.secrets.dir, item: await credentialStatus(rt.secrets.dir, spec.sourceId, spec) };
        }
        const items = [];
        for (const c of credentialSources()) {
          items.push(await credentialStatus(rt.secrets.dir, c.id, { file: c.credential.file, fields: c.credential.fields }));
        }
        return {
          ok: true,
          dir: rt.secrets.dir,
          count: items.length,
          configured: items.filter((i) => i.configured).length,
          items,
        };
      },
    });

    reg({
      name: 'inbox_remove',
      description: 'Delete one archived record by id (rewrites the manifest and removes its files). Use it to take back a wrong record — e.g. a login page that was archived before it could be recognised, or an import the user does not want. Without this, the append-only store could never forget anything.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Record id from inbox_list, e.g. creator-video-20763d6ed76d0dd3' },
        },
        required: ['id'],
      },
      output: OUTPUT,
      async execute(args) {
        await rt.ready;
        const id = String(args?.id ?? '').trim();
        if (!id) return { ok: false, error: 'id is required' };
        const removed = await rt.store.remove(id);
        if (!removed) return { ok: false, error: `not found: ${id}` };
        return { ok: true, removed: removed.id, title: removed.title, source: removed.source };
      },
    });

    reg({
      name: 'inbox_fetch_url',
      description: 'Fetch one https link, reduce the page to Markdown and archive it in the local knowledge base. This is the plugin\'s own reader — it replaces "hand the link to some scraper package", so nothing extra has to be installed. Private/loopback hosts are refused and the size is capped.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'https URL of the page to read' },
          source: { type: 'string', description: 'Source id to file the record under (default link-parse)' },
          maxChars: { type: 'number', description: 'Cap on the Markdown length (500-200000, default 60000)' },
          archive: { type: 'boolean', description: 'Archive into the knowledge base (default true)' },
        },
        required: ['url'],
      },
      output: OUTPUT,
      async execute(args) {
        await rt.ready;
        const result = await fetchDocument(args?.url, { maxChars: args?.maxChars });
        if (!result.ok) return { ok: false, error: result.reason };
        let archived = null;
        if (args?.archive !== false) {
          const a = await archiveDoc(rt, String(args?.source ?? 'link-parse'), {
            title: result.title || slugFromTitle(result.title, 'link'),
            markdown: `# ${result.title || result.url}\n\n- 原文：${result.url}\n\n${result.markdown}`,
            remoteRef: result.url,
          });
          archived = { id: a.record.id, duplicate: a.duplicate };
        }
        return { ok: true, url: result.url, title: result.title, chars: result.chars, truncated: result.truncated, markdown: result.markdown, archived };
      },
    });

    reg({
      name: 'inbox_export_weread',
      description: 'Export the user\'s own WeRead highlights to Markdown using the Cookie already saved in the vault, one record per book. Built into the plugin on purpose: the previous guidance told the user to install a third-party exporter, which is a supply-chain risk. Read-only endpoints, own account only.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'How many books from the shelf to scan (1-50, default 10)' },
        },
      },
      output: OUTPUT,
      async execute(args) {
        await rt.ready;
        const cookie = await readSecret(rt, 'weread', 'cookie');
        if (!cookie.ok) return { ok: false, error: cookie.reason };
        const out = await exportHighlights(cookie.value, { limit: args?.limit });
        if (!out.ok) return { ok: false, error: out.reason };
        const archived = [];
        for (const doc of out.docs) {
          const a = await archiveDoc(rt, 'weread', {
            title: doc.book.title,
            markdown: doc.markdown,
            remoteRef: `https://weread.qq.com/web/bookDetail/${doc.book.bookId}`,
          });
          archived.push({ id: a.record.id, title: doc.book.title, highlights: doc.count, duplicate: a.duplicate });
        }
        return { ok: true, shelfTotal: out.shelfTotal, scanned: out.scanned, exported: archived.length, archived, failures: out.failures };
      },
    });

    reg({
      name: 'inbox_export_cubox',
      description: 'Pull the newest cards from the user\'s own Cubox via the API link saved in the vault, and archive each as Markdown. Built in on purpose: the previous guidance named a third-party sync package that would have to be installed.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'How many cards to pull (1-50, default 20)' },
        },
      },
      output: OUTPUT,
      async execute(args) {
        await rt.ready;
        const api = await readSecret(rt, 'cubox', 'apiUrl');
        if (!api.ok) return { ok: false, error: api.reason };
        const out = await exportCards(api.value, { limit: args?.limit });
        if (!out.ok) return { ok: false, error: out.reason };
        const archived = [];
        for (const doc of out.docs) {
          const a = await archiveDoc(rt, 'cubox', {
            title: doc.card.title || doc.card.url,
            markdown: doc.markdown,
            remoteRef: doc.card.url,
          });
          archived.push({ id: a.record.id, title: doc.card.title, duplicate: a.duplicate });
        }
        return { ok: true, fetched: out.count, exported: archived.length, archived };
      },
    });

    reg({
      name: 'inbox_export_mail',
      description: 'Read the newest mail over IMAP using the app password saved in the vault, and archive each message as Markdown. The IMAP client is built into the plugin (node:tls only) because the previous guidance told the user to install a mail package. Read-only: it uses BODY.PEEK and never changes flags, never sends.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'How many recent messages to read (1-50, default 10)' },
        },
      },
      output: OUTPUT,
      async execute(args) {
        await rt.ready;
        const host = await readSecret(rt, 'email', 'host');
        if (!host.ok) return { ok: false, error: host.reason };
        const user = await readSecret(rt, 'email', 'user');
        if (!user.ok) return { ok: false, error: user.reason };
        const password = await readSecret(rt, 'email', 'password');
        if (!password.ok) return { ok: false, error: password.reason };
        const out = await fetchRecentMail({ host: host.value, user: user.value, password: password.value, limit: args?.limit });
        if (!out.ok) return { ok: false, error: out.reason };
        const archived = [];
        for (const doc of out.docs) {
          const a = await archiveDoc(rt, 'email', {
            title: doc.message.subject || '(无主题)',
            markdown: doc.markdown,
            remoteRef: doc.message.messageId ? `mid:${doc.message.messageId}` : '',
          });
          archived.push({ id: a.record.id, title: doc.message.subject, duplicate: a.duplicate });
        }
        return { ok: true, exists: out.exists, fetched: out.count, exported: archived.length, archived };
      },
    });

    return () => { for (const dispose of disposers) dispose(); };
  }, 'dsh-source-inbox: agent tools');
}

/* -------------------------------------------------------------- host apply */

export function apply(ctx, config) {
  const rt = createRuntime(config ?? {});
  // Each service is injected independently so a missing one cannot suppress the
  // whole plugin (mirrors dsh-connect-workbuddy's parallel ctx.inject blocks).
  ctx.inject(['webServer'], (webCtx) => mountRoutes(webCtx, rt));
  ctx.inject(['tools'], (toolsCtx) => mountTools(toolsCtx, rt));
  // Phase 1: start the dropzone watcher once store + adapter config are ready;
  // clear its timer on teardown (dsh-connect-workbuddy:15565-15604).
  ctx.effect(() => {
    rt.ready.then(() => rt.adapters.start()).catch(() => {});
    return () => rt.adapters.stop();
  }, 'dsh-source-inbox: adapter lifecycle');
}
