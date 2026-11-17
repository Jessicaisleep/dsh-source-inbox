/**
 * dsh-source-inbox — Phase 1: pluggable source adapters.
 *
 * v2 复用策略 (继续任务.MD §5): 授权 / 抓取 / 落盘型存储全部复用源插件，
 * 本插件只做下游「统一整理归档」。本机已装插件里没有「程序化调用另一插件
 * 工具」的范式（grep 无匹配），所以第一个自动源落在 file-producing 形态：
 * 监视一个落地目录，新文件出现即自动走 Phase 0 的 importPath 归集。
 *
 * 这是所有 file-producing 源（官方导出 ZIP / 微信合并转发 ZIP / DeepSeek 导出 /
 * 元宝转文档 / 夸克下载）的统一底座，且不需要任何账号授权。官方 MCP/API
 * 源需要用户先给一次授权，故在注册表里诚实标为 needs-auth、当前不接线。
 *
 * 纯 ESM，零外部依赖，只用 node: 内置。定时器范式来自运行版
 * dsh-connect-workbuddy/lib/index.js:15565-15604（re-arming one-shot +
 * timer.unref?.() + cleanup clearTimeout），不用 setInterval。
 */
import { promises as fs } from 'node:fs';
import { join, isAbsolute, resolve, sep } from 'node:path';
import { importPath, isForbiddenChatFile } from './import.js';

/** Adapter registry. state: wired | needs-auth | planned. */
export const ADAPTERS = Object.freeze([
  Object.freeze({
    id: 'dropzone',
    label: '投放区观察器',
    delivery: 'file-producing',
    state: 'wired',
    auth: 'none',
    auto: true,
    hint: '监视一个本地落地目录；新文件自动走导入向导（魔数纠正 / 去重 / 双轨 / 合规闸门）归集。所有 file-producing 源的统一底座，不需要账号授权。',
  }),
  Object.freeze({
    id: 'official-mcp',
    label: '官方 MCP / API 源',
    delivery: 'tool-returning',
    state: 'needs-auth',
    auth: 'user',
    auto: false,
    hint: '腾讯文档 / 飞书 / 夸克 / Notion 等官方 MCP。需要用户先给一次授权（个人 Token / 扫码 / 登录），当前未接通；不会假装它现在能跑。',
  }),
]);

export function wiredCount() {
  return ADAPTERS.filter((a) => a.state === 'wired').length;
}

const DEFAULTS = Object.freeze({
  dir: '',            // AdapterRuntime fills this with <dataDir>/dropzone
  enabled: true,
  pollMs: 5000,
  minAgeMs: 1500,     // avoid ingesting a half-written file
  source: 'dropzone',
  tags: [],
});

function clamp(n, lo, hi, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(lo, Math.min(hi, Math.trunc(v)));
}

/**
 * A watched dir must not overlap the inbox archive, or the watcher would
 * re-ingest its own _raw/ materialized/ output forever (feedback loop).
 * The one allowed in-archive dir is exactly <root>/dropzone.
 */
export function isUnsafeWatchDir(dir, root) {
  const d = resolve(String(dir));
  const r = resolve(String(root));
  if (d === r) return true;
  if (r.startsWith(d + sep)) return true;                       // dir is an ancestor of the archive
  if (d.startsWith(r + sep) && d !== join(r, 'dropzone')) return true; // inside the archive
  return false;
}

function validateDir(dir, root) {
  if (!dir || !String(dir).trim()) return { ok: false, reason: 'dropzone dir is required' };
  if (!isAbsolute(String(dir))) return { ok: false, reason: 'dropzone dir must be absolute' };
  if (isUnsafeWatchDir(dir, root)) return { ok: false, reason: 'dropzone dir must not overlap the inbox archive (feedback loop)' };
  return { ok: true };
}

/** Whitelist + clamp user-supplied options; unknown keys are ignored. */
function sanitize(partial = {}) {
  const out = {};
  if (partial && typeof partial === 'object') {
    if (partial.dir !== undefined) { const d = String(partial.dir).trim(); if (d) out.dir = d; }
    if (partial.pollMs !== undefined) out.pollMs = clamp(partial.pollMs, 500, 600000, DEFAULTS.pollMs);
    if (partial.minAgeMs !== undefined) out.minAgeMs = clamp(partial.minAgeMs, 0, 60000, DEFAULTS.minAgeMs);
    if (partial.enabled !== undefined) out.enabled = !!partial.enabled;
    if (partial.source !== undefined) out.source = String(partial.source).trim() || DEFAULTS.source;
    if (partial.tags !== undefined) out.tags = Array.isArray(partial.tags) ? partial.tags.map(String).slice(0, 20) : [];
  }
  return out;
}

/** Stable signature for change detection (files: size+mtime; dirs: shallow listing). */
async function signatureOf(abs, ent) {
  if (ent.isFile()) {
    const s = await fs.stat(abs);
    return `f:${s.size}:${Math.round(s.mtimeMs)}`;
  }
  if (ent.isDirectory()) {
    let sig = 'd:';
    try {
      const kids = (await fs.readdir(abs, { withFileTypes: true }))
        .slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
      for (const k of kids) {
        const ks = await fs.stat(join(abs, k.name)).catch(() => null);
        sig += `${k.name}:${ks ? ks.size : 0}:${ks ? Math.round(ks.mtimeMs) : 0}|`;
      }
    } catch { /* unreadable dir -> signature stays shallow */ }
    return sig;
  }
  return null; // symlink / special -> skip
}

/**
 * Watches one absolute directory. Re-arming one-shot timer (never setInterval),
 * change-detection by signature, minAgeMs guard against half-writes, and a
 * hard compliance skip for local chat databases dropped into the zone.
 */
export class DropZoneWatcher {
  constructor(store, opts = {}) {
    this.store = store;
    this.opts = { ...DEFAULTS, ...opts };
    /** @type {Map<string,string>} abs path -> last signature */
    this.seen = new Map();
    this.timer = null;
    this.running = false;
    this.counters = { scans: 0, imported: 0, duplicates: 0, skipped: 0, errors: 0 };
    this.lastScanAt = null;
    this.lastError = '';
  }

  _arm() {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    // One-shot: after each tick we re-arm, so a changed pollMs / disabled flag
    // takes effect on the very next cycle (dsh-connect-workbuddy:15488).
    this.timer = setTimeout(() => { this._tick(); }, Math.max(500, this.opts.pollMs));
    this.timer.unref?.();
  }

  async _tick() {
    try { await this.scanOnce(false); } catch (e) { this.lastError = String(e?.message ?? e); }
    this._arm();
  }

  /**
   * One scan. force=true (button / tool / route) ignores `enabled` and
   * `minAgeMs` for a deterministic manual run; the timer uses force=false.
   * Returns a BOUNDED summary — never dumps file bodies.
   */
  async scanOnce(force = false) {
    if (!this.opts.enabled && !force) return { skipped: true, reason: 'watcher disabled', scanned: 0, imported: 0, duplicates: 0, skippedFiles: 0, errors: 0, files: [] };
    const dir = this.opts.dir;
    const gate = validateDir(dir, this.store.root);
    if (!gate.ok) {
      this.lastError = gate.reason;
      return { skipped: true, reason: gate.reason, scanned: 0, imported: 0, duplicates: 0, skippedFiles: 0, errors: 0, files: [] };
    }
    const summary = { scanned: 0, imported: 0, duplicates: 0, skippedFiles: 0, errors: 0, files: [] };
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch (e) {
      this.lastError = String(e?.message ?? e);
      this.counters.errors += 1;
      return { ...summary, reason: this.lastError };
    }

    for (const ent of entries) {
      if (String(ent.name).startsWith('.')) continue; // hidden / temp files
      const abs = join(dir, ent.name);
      let sig;
      try { sig = await signatureOf(abs, ent); } catch { continue; }
      if (!sig) continue;
      if (this.seen.get(abs) === sig) continue;       // unchanged since last scan

      // §2 red line, in code: never ingest a local chat database.
      if (isForbiddenChatFile(ent.name)) {
        this.seen.set(abs, sig);
        summary.skippedFiles += 1;
        summary.files.push({ name: ent.name, skipped: 'chat database (compliance red line)' });
        continue;
      }

      // Half-write guard (timer scans only).
      if (!force && this.opts.minAgeMs > 0) {
        try { const st = await fs.stat(abs); if (Date.now() - st.mtimeMs < this.opts.minAgeMs) continue; } catch { continue; }
      }

      summary.scanned += 1;
      let r;
      try { r = await importPath(this.store, abs, { source: this.opts.source, tags: this.opts.tags }); }
      catch (e) { summary.errors += 1; this.lastError = String(e?.message ?? e); continue; }
      this.seen.set(abs, sig);
      summary.imported += r.imported.length;
      summary.duplicates += r.duplicates.length;
      summary.skippedFiles += r.skipped.length;
      summary.errors += r.errors.length;
      if (r.imported.length) summary.files.push({ name: ent.name, imported: r.imported.length });
    }

    summary.files = summary.files.slice(0, 5);
    this.counters.scans += 1;
    this.counters.imported += summary.imported;
    this.counters.duplicates += summary.duplicates;
    this.counters.skipped += summary.skippedFiles;
    this.counters.errors += summary.errors;
    this.lastScanAt = new Date().toISOString();
    return summary;
  }

  setOptions(partial) {
    const s = sanitize(partial);
    if (s.dir !== undefined) {
      const gate = validateDir(s.dir, this.store.root);
      if (!gate.ok) return { ok: false, reason: gate.reason };
    }
    this.opts = { ...this.opts, ...s };
    const gate = validateDir(this.opts.dir, this.store.root);
    if (!gate.ok) { this.opts.enabled = false; return { ok: false, reason: gate.reason }; }
    if (s.dir !== undefined) this.seen.clear(); // new zone -> re-evaluate its files
    if (this.running) this._arm();              // apply a new pollMs immediately
    return { ok: true, dropzone: this.status() };
  }

  status() {
    return {
      enabled: this.opts.enabled,
      dir: this.opts.dir,
      pollMs: this.opts.pollMs,
      minAgeMs: this.opts.minAgeMs,
      source: this.opts.source,
      tags: this.opts.tags,
      running: this.running,
      scans: this.counters.scans,
      imported: this.counters.imported,
      duplicates: this.counters.duplicates,
      skipped: this.counters.skipped,
      errors: this.counters.errors,
      lastScanAt: this.lastScanAt,
      lastError: this.lastError,
      seen: this.seen.size,
    };
  }

  start() { if (this.running) return; this.running = true; this._arm(); }
  stop() { this.running = false; if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
}

/**
 * Owns the registry + the one wired watcher. Config lives in
 * <dataDir>/adapters.json — NOT in the profile's cordis.patch.yml
 * (configuration.md forbids a plugin rewriting the user patch layer, and a
 * normal config field would restart the plugin on every change).
 */
export class AdapterRuntime {
  constructor(store, dataDir, seed = {}) {
    this.store = store;
    this.dataDir = dataDir;
    this.configPath = join(dataDir, 'adapters.json');
    this.defaultDir = join(dataDir, 'dropzone');
    const opts = { ...DEFAULTS, dir: this.defaultDir, ...sanitize(seed) };
    // seed.dir, if any, still has to pass the safety gate at load() time.
    this.watcher = new DropZoneWatcher(store, opts);
    this._wantRunning = false;
    this.loaded = false;
  }

  wiredCount() { return wiredCount(); }

  async load() {
    let saved = null;
    try { saved = JSON.parse(await fs.readFile(this.configPath, 'utf8')); } catch { /* new install */ }
    if (saved && typeof saved === 'object' && saved.dropzone && typeof saved.dropzone === 'object') {
      this.watcher.setOptions(saved.dropzone);
    }
    const dir = this.watcher.opts.dir;
    if (dir) { try { await fs.mkdir(dir, { recursive: true }); } catch { /* non-fatal */ } }
    this.loaded = true;
    if (this._wantRunning) this.watcher.start();
    return this.status();
  }

  async save() {
    await fs.mkdir(this.dataDir, { recursive: true });
    const o = this.watcher.opts;
    await fs.writeFile(this.configPath, JSON.stringify({
      dropzone: { dir: o.dir, enabled: o.enabled, pollMs: o.pollMs, minAgeMs: o.minAgeMs, source: o.source, tags: o.tags },
    }, null, 2), 'utf8');
  }

  async configureDropzone(partial) {
    const res = this.watcher.setOptions(partial);
    if (!res.ok) return res;
    try { await this.save(); } catch (e) { return { ok: false, reason: `config save failed: ${String(e?.message ?? e)}` }; }
    return { ok: true, dropzone: this.watcher.status() };
  }

  status() {
    return {
      phase: 1,
      wired: this.wiredCount(),
      adapters: ADAPTERS,
      dropzone: this.watcher.status(),
      configPath: this.configPath,
      note: 'The dropzone watcher is live. Official MCP/API sources need a one-time user authorization and are NOT connected yet.',
    };
  }

  async scanOnce(force = true) { return this.watcher.scanOnce(force); }

  start() { this._wantRunning = true; if (this.loaded) this.watcher.start(); }
  stop() { this._wantRunning = false; this.watcher.stop(); }
}
