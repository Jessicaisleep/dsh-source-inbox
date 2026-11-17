/**
 * dsh-source-inbox — Phase 2: controlled-browser bridge.
 *
 * WHY THIS EXISTS
 * Some sources (抖音创作者中心、知乎收藏、公众号已发表、Cubox、Figma/Figma-like
 * 素材站) have no usable official API. The only compliant way to read the user's
 * OWN data is to reuse a real logged-in browser session (§4.1 tier L2). The old
 * button only opened the login page in the user's default browser — which we
 * cannot attach to, so "登录完之后呢?" had no answer.
 *
 * HOW IT WORKS
 * We launch a SEPARATE Chromium instance (Edge/Chrome) with `--remote-debugging-port`
 * and a plugin-owned `--user-data-dir` (<dataDir>/browser-profile). The user logs in
 * once inside that window; the cookie jar lives in that profile only. Afterwards the
 * plugin drives it over the DevTools protocol (CDP) to read the pages they opened.
 *
 * WHY A SEPARATE PROFILE (not the user's daily browser)
 * 1. A running Chrome/Edge cannot be attached to unless it was started with the
 *    debugging port — the user's everyday window never is.
 * 2. Attaching to the daily profile would mean reading cookies of every site the
 *    user visits. A dedicated profile bounds what this plugin can ever see.
 *
 * COMPLIANCE
 * - Only https pages whose host is whitelisted by the source registry (`read.hosts`)
 *   can be read; this is not a general-purpose scraper.
 * - It never decrypts a local chat database, never touches another app's profile,
 *   and never stores a password. Cookies stay inside the Chromium profile dir.
 * - Everything is opt-in: nothing launches until the user clicks a button or the
 *   agent calls the tool.
 *
 * Zero external dependencies (node WebSocket client, Node >= 22 — the host runs 24).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/** Where a Chromium binary usually lives. First existing path wins. */
export const BROWSER_CANDIDATES = Object.freeze([
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
]);

/** Resolve a Chromium binary; DSH_BROWSER_PATH overrides everything. */
export function findBrowserPath(env = process.env, exists = existsSync) {
  const override = String(env?.DSH_BROWSER_PATH ?? '').trim();
  if (override && exists(override)) return override;
  for (const p of BROWSER_CANDIDATES) {
    if (exists(p)) return p;
  }
  return '';
}

export const DEFAULT_PORT = 9333;
const MIN_PORT = 1024;
const MAX_PORT = 65535;

export function clampPort(value, fallback = DEFAULT_PORT) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const p = Math.trunc(n);
  return p >= MIN_PORT && p <= MAX_PORT ? p : fallback;
}

/**
 * Is `url` readable under this source's whitelist? https only, and the host must
 * equal (or be a subdomain of) one of `hosts`. An empty whitelist refuses
 * everything — silence must never mean "read anything".
 */
export function readAllowed(url, hosts) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const list = Array.isArray(hosts) ? hosts : [];
  if (!list.length) return false;
  const host = u.hostname.toLowerCase();
  return list.some((raw) => {
    const h = String(raw).toLowerCase().trim();
    if (!h) return false;
    return host === h || host.endsWith('.' + h);
  });
}

/* ------------------------------------------------- viewport / login-wall heuristics */

/**
 * Does this page look like a login wall rather than the user's own list?
 *
 * A logged-out 抖音/知乎/公众号 page still returns 200 and a few hundred chars of
 * "扫码登录" chrome, so "ok: true, chars: 200" would be a lie that wastes the
 * user's time. We report it as `loginRequired` instead so the UI can tell them
 * to log in INSIDE the plugin's window and click again.
 *
 * WHY NOT JUST "short page"
 * The first version required `text.length <= 900`. Real life broke it: the
 * logged-out 抖音创作者中心 sells itself with marketing copy ("AI 工坊…把好想法
 * 变成好玩法") on top of the login box, totalling 1127 chars, so a pure length
 * guard ARCHIVED the login page as if it were the user's 作品列表.
 *
 * So we look for the shape of a login BOX: the words that only ever appear on
 * one ("扫码登录"、"请先登录"、"登录即代表…"、"Sign in to continue") rather than
 * the bare word 登录. Those are login-box UI strings; an article about logging
 * in writes 登录 without them, so prose is left alone no matter its length.
 *
 * KNOWN TRADE-OFF (deliberate, covered by tests — do NOT "fix" it)
 * An article that QUOTES one of those UI strings verbatim ("密码登录"/"验证码登录")
 * is misread as a login wall, and the user has to click once more for nothing.
 * The opposite error is archiving a login page into the knowledge base forever.
 * Those costs are not symmetric, so we prefer the extra click.
 */
const LOGIN_BOX_PHRASES = [
  /扫码登录/, /立即登录/, /请先登录/, /登录\s*\/\s*注册/, /登录即代表/,
  /登录后(?:查看|可)/, /扫一扫/, /验证码登录/, /密码登录/,
  /Log in to continue/i, /Sign in to continue/i,
];

export function looksLikeLoginWall(text, url = '') {
  const t = String(text ?? '');
  if (/\/login|\/signin|\/passport|sso\.|passport\./i.test(String(url))) return true;
  if (!t) return false;
  if (LOGIN_BOX_PHRASES.some((re) => re.test(t))) return true;
  // A lone 登录 on a very short page is still suspicious (some sites only render
  // "登录" as the button text), but it is never enough on a long page.
  return t.length <= 200 && /登录|sign\s*in|log\s*in/i.test(t);
}

/* --------------------------------------------------------------- CDP plumbing *//** Minimal CDP client over the built-in WebSocket (no ws dependency). */
export class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.closed = false;
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const slot = msg.id ? this.pending.get(msg.id) : null;
      if (!slot) return;
      this.pending.delete(msg.id);
      if (msg.error) slot.reject(new Error(msg.error.message || 'cdp error'));
      else slot.resolve(msg.result);
    };
    ws.onclose = () => {
      this.closed = true;
      for (const [, slot] of this.pending) slot.reject(new Error('cdp connection closed'));
      this.pending.clear();
    };
  }

  static async connect(wsUrl, timeoutMs = 10000) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error('cdp websocket timeout')), timeoutMs);
      ws.onopen = () => { clearTimeout(timer); res(); };
      ws.onerror = () => { clearTimeout(timer); rej(new Error('cdp websocket error')); };
    });
    return new CdpConnection(ws);
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('cdp connection closed'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`cdp timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  close() {
    this.closed = true;
    try { this.ws.close(); } catch { /* already gone */ }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Reach the DevTools HTTP endpoint; returns null when nothing listens. */
export async function probeEndpoint(port, timeoutMs = 1200) {
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: ctl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = await res.json();
    if (!body || typeof body.webSocketDebuggerUrl !== 'string') return null;
    return {
      browser: String(body.Browser ?? ''),
      protocolVersion: String(body['Protocol-Version'] ?? ''),
      webSocketDebuggerUrl: body.webSocketDebuggerUrl,
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ the bridge */

/**
 * Owns one controlled Chromium instance + the reads performed through it.
 * All state that matters (which mode it runs in) is derived from a live probe,
 * so a plugin restart reattaches instead of spawning a second browser.
 */
export class BrowserBridge {
  constructor(dataDir, opts = {}) {
    this.dataDir = dataDir;
    this.profileDir = join(dataDir, 'browser-profile');
    this.port = clampPort(opts.port);
    this.browserPath = String(opts.browserPath ?? '').trim() || findBrowserPath();
    /** 'headless' | 'headful' | 'external' | '' (not running) */
    this.mode = '';
    this.launchedAt = null;
    this.lastError = '';
    this.lastReadAt = null;
    this.reads = 0;
    this._child = null;
  }

  async _probe() {
    return probeEndpoint(this.port);
  }

  async status() {
    const live = await this._probe();
    return {
      running: !!live,
      mode: live ? (this.mode || 'external') : '',
      port: this.port,
      browserPath: this.browserPath,
      browser: live?.browser ?? '',
      profileDir: this.profileDir,
      launchedAt: this.launchedAt,
      reads: this.reads,
      lastReadAt: this.lastReadAt,
      lastError: this.lastError,
      available: !!this.browserPath,
    };
  }

  /** Args for a controlled instance. Kept separate so tests can assert them. */
  launchArgs({ headless = false } = {}) {
    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,EdgeCollections',
      'about:blank',
    ];
    if (headless) args.unshift('--headless=new');
    return args;
  }

  /**
   * Make sure a controlled browser is reachable. Reuses a live one (ours after a
   * restart, or an externally started CDP browser on the same port), otherwise
   * spawns it. Switching between headless and headful restarts the instance,
   * because one profile cannot be opened twice.
   */
  async ensure({ headless = true, waitMs = 20000 } = {}) {
    if (!this.browserPath) {
      this.lastError = 'no Chromium browser found (set DSH_BROWSER_PATH)';
      return { ok: false, reason: this.lastError };
    }
    const want = headless ? 'headless' : 'headful';
    const live = await this._probe();
    if (live) {
      // Already up. If we launched headless earlier and the user now needs to log
      // in (headful), restart; an external instance is left alone.
      if (this.mode && this.mode !== 'external' && this.mode !== want) {
        await this.stop();
      } else {
        if (!this.mode) this.mode = 'external';
        return { ok: true, reused: true, mode: this.mode, browser: live.browser };
      }
    }

    await fs.mkdir(this.profileDir, { recursive: true });
    let child;
    try {
      child = spawn(this.browserPath, this.launchArgs({ headless }), {
        detached: true, stdio: 'ignore', windowsHide: false,
      });
    } catch (e) {
      this.lastError = String(e?.message ?? e);
      return { ok: false, reason: this.lastError };
    }
    child.unref?.();
    this._child = child;
    this.mode = want;
    this.launchedAt = new Date().toISOString();

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const up = await this._probe();
      if (up) return { ok: true, launched: true, mode: this.mode, browser: up.browser };
      await sleep(250);
    }
    this.lastError = `controlled browser did not expose port ${this.port} within ${waitMs}ms`;
    return { ok: false, reason: this.lastError };
  }

  async _browserWs() {
    const live = await this._probe();
    if (!live) return null;
    return CdpConnection.connect(live.webSocketDebuggerUrl);
  }

  /** Page targets only (extensions / service workers are noise here). */
  async listTabs() {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/list`);
      const all = await res.json();
      if (!Array.isArray(all)) return [];
      return all
        .filter((t) => t.type === 'page' && typeof t.webSocketDebuggerUrl === 'string')
        .map((t) => ({ id: t.id, title: t.title, url: t.url, webSocketDebuggerUrl: t.webSocketDebuggerUrl }));
    } catch { return []; }
  }

  /**
   * Open a page in the controlled browser and KEEP it (login flow). Headful by
   * default: the user has to see the window to scan a QR code.
   */
  async openPage(url, { headless = false } = {}) {
    const up = await this.ensure({ headless });
    if (!up.ok) return up;
    const browser = await this._browserWs();
    if (!browser) return { ok: false, reason: 'cdp browser endpoint unreachable' };
    try {
      const { targetId } = await browser.send('Target.createTarget', { url: String(url) });
      return { ok: true, targetId, url: String(url), mode: this.mode };
    } catch (e) {
      this.lastError = String(e?.message ?? e);
      return { ok: false, reason: this.lastError };
    } finally { browser.close(); }
  }

  /**
   * Read one page and return its visible text.
   *
   * `scrollSteps` nudges lazy-loading lists (抖音作品、知乎收藏) by scrolling the
   * viewport a few times before extraction; `expression` overrides the extractor
   * for sources that need a narrower selector.
   */
  async readPage(url, { headless = true, maxChars = 12000, scrollSteps = 0, waitMs = 1500, expression = '', keepTab = false } = {}) {
    const up = await this.ensure({ headless });
    if (!up.ok) return up;
    const browser = await this._browserWs();
    if (!browser) return { ok: false, reason: 'cdp browser endpoint unreachable' };

    let targetId = '';
    try {
      ({ targetId } = await browser.send('Target.createTarget', { url: 'about:blank' }));
    } catch (e) {
      browser.close();
      this.lastError = String(e?.message ?? e);
      return { ok: false, reason: this.lastError };
    }
    browser.close();

    let pageWs = '';
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !pageWs) {
      const tabs = await this.listTabs();
      pageWs = tabs.find((t) => t.id === targetId)?.webSocketDebuggerUrl ?? '';
      if (!pageWs) await sleep(150);
    }
    if (!pageWs) return { ok: false, reason: 'page target did not expose a websocket' };

    const page = await CdpConnection.connect(pageWs);
    try {
      await page.send('Page.enable');
      await page.send('Runtime.enable');
      await page.send('Page.navigate', { url: String(url) });
      await sleep(Math.max(200, Math.min(20000, Number(waitMs) || 1500)));

      const steps = Math.max(0, Math.min(20, Math.trunc(Number(scrollSteps) || 0)));
      for (let i = 0; i < steps; i += 1) {
        await page.send('Runtime.evaluate', { expression: 'window.scrollBy(0, window.innerHeight * 0.9)' }).catch(() => {});
        await sleep(500);
      }

      const limit = Math.max(200, Math.min(60000, Math.trunc(Number(maxChars) || 12000)));
      const expr = expression || `JSON.stringify({
        title: document.title || '',
        url: location.href,
        text: (document.body ? document.body.innerText : '') || ''
      })`;
      const out = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      const raw = out?.result?.value;
      let parsed;
      try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { parsed = null; }
      if (!parsed || typeof parsed !== 'object') {
        return { ok: false, reason: 'extraction returned no data', url: String(url) };
      }
      const text = String(parsed.text ?? '');
      this.reads += 1;
      this.lastReadAt = new Date().toISOString();
      const finalUrl = String(parsed.url ?? url);
      return {
        ok: true,
        url: finalUrl,
        title: String(parsed.title ?? ''),
        chars: text.length,
        truncated: text.length > limit,
        // A short page full of 扫码登录 is not the user's content — say so.
        loginRequired: looksLikeLoginWall(text, finalUrl),
        text: text.length > limit ? `${text.slice(0, limit)}\n…[truncated]` : text,
      };
    } catch (e) {
      this.lastError = String(e?.message ?? e);
      return { ok: false, reason: this.lastError, url: String(url) };
    } finally {
      page.close();
      if (!keepTab) {
        const b2 = await this._browserWs();
        if (b2) {
          await b2.send('Target.closeTarget', { targetId }).catch(() => {});
          b2.close();
        }
      }
    }
  }

  /** Close the controlled browser (no-op when nothing listens). */
  async stop() {
    const browser = await this._browserWs();
    if (browser) {
      await browser.send('Browser.close').catch(() => {});
      browser.close();
    }
    this.mode = '';
    this.launchedAt = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!(await this._probe())) return { ok: true };
      await sleep(200);
    }
    return { ok: true, note: 'close requested; port still answering' };
  }
}
