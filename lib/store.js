import { promises as fs } from 'node:fs';
import { join, dirname, relative, isAbsolute, resolve, sep } from 'node:path';
import {
  checksum, makeId, makeRecord, cleanRecord, classifyStorage,
  STORAGE, TEXT_MIMES, guessSourceType,
} from './schema.js';

const MANIFEST = 'manifest.jsonl';
const SUBDIRS = ['_raw', 'materialized', 'reference', 'assets'];

/** Default data dir: harness home / data / dsh-source-inbox (mirrors dsh-comfyui). */
export function defaultDataDir() {
  const base = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh');
  return join(base, 'data', 'dsh-source-inbox');
}

/** Resolve the data dir from config / env, with a safe default. */
export function resolveDataDir(config) {
  const fromConfig = typeof config?.dataDir === 'string' ? config.dataDir.trim() : '';
  const fromEnv = (process.env.DSH_SOURCE_INBOX_DIR ?? '').trim();
  return fromConfig || fromEnv || defaultDataDir();
}

function monthOf(iso) {
  return String(iso).slice(0, 7); // YYYY-MM
}

/** Zip-slip guard: return a safe relative path, or null when unusable. */
export function safeInnerPath(name) {
  const cleaned = String(name).replace(/\\/g, '/');
  if (!cleaned || cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned)) return null;
  const norm = cleaned.split('/').filter((p) => p && p !== '.' && p !== '..').join('/');
  if (!norm) return null;
  return norm;
}

function titleFromName(name) {
  const base = String(name).split('/').pop() ?? 'untitled';
  return base.replace(/\.[^.]+$/, '') || base;
}

function extForMime(mime) {
  const map = {
    'text/plain': '.txt', 'text/markdown': '.md', 'text/html': '.html', 'text/csv': '.csv',
    'application/json': '.json', 'application/pdf': '.pdf',
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
    'image/bmp': '.bmp', 'audio/mpeg': '.mp3', 'audio/wav': '.wav',
    'video/mp4': '.mp4', 'video/quicktime': '.mov', 'application/zip': '.zip',
  };
  return map[mime] ?? '';
}

export class Store {
  constructor(dataDir) {
    this.root = dataDir;
    this.manifestPath = join(dataDir, MANIFEST);
    /** @type {Map<string, object>} id -> record */
    this.records = new Map();
    /** @type {Map<string, string>} checksum -> id */
    this.byChecksum = new Map();
    this.ready = false;
  }

  async init() {
    if (this.ready) return;
    await fs.mkdir(this.root, { recursive: true });
    for (const d of SUBDIRS) await fs.mkdir(join(this.root, d), { recursive: true });
    let text = '';
    try { text = await fs.readFile(this.manifestPath, 'utf8'); } catch { /* new store */ }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (!rec?.id) continue;
        // Later lines win (append-only upsert log).
        this.records.set(rec.id, rec);
        if (rec.checksum) this.byChecksum.set(rec.checksum, rec.id);
      } catch { /* skip a torn line */ }
    }
    this.ready = true;
  }

  get inboxRoot() { return this.root; }

  async _append(rec) {
    await fs.appendFile(this.manifestPath, JSON.stringify(cleanRecord(rec)) + '\n', 'utf8');
  }

  /**
   * Persist one normalized entry. Returns { record, duplicate }.
   * - materialized: writes original bytes to _raw + a Markdown copy to materialized
   * - reference: writes NOTHING large; keeps a pointer + a small text shadow file
   */
  async put({ buf, record, markdown }) {
    await this.init();
    const sum = record.checksum ?? checksum(buf);
    const dupId = this.byChecksum.get(sum);
    if (dupId) return { record: this.records.get(dupId), duplicate: true };

    const source = String(record.source || 'import');
    const month = monthOf(record.capturedAt ?? new Date().toISOString());
    const base = join(source, month);
    // The id must be known before the target path is chosen: two records from
    // the same source in the same month used to fall back to the literal leaf
    // "file", so the second write silently overwrote the first and reading one
    // record returned another record's body. Fall back to the id, which is
    // unique per record.
    const id = record.id ?? makeId(source, `${sum}:${record.innerPath ?? ''}`);
    const inner = safeInnerPath(record.innerPath ?? '') ?? id;
    const leaf = inner.split('/').pop() ?? id;

    const storage = record.storage ?? classifyStorage(record.mimeType, buf.length);
    const mimeType = record.mimeType ?? 'application/octet-stream';

    let originalPath;
    let mdPath;
    let shadowStatus;

    if (storage === STORAGE.MATERIALIZED) {
      const rawRel = join('_raw', base, inner);
      const rawAbs = join(this.root, rawRel);
      await fs.mkdir(dirname(rawAbs), { recursive: true });
      await fs.writeFile(rawAbs, buf);
      originalPath = rawRel;

      const mdText = markdown ?? (
        TEXT_MIMES.has(mimeType) ? buf.toString('utf8') : `# ${record.title ?? titleFromName(leaf)}\n\n> 二进制文档，待后续抽取器转 Markdown。`
      );
      const mdRel = join('materialized', base, `${inner}.md`);
      const mdAbs = join(this.root, mdRel);
      await fs.mkdir(dirname(mdAbs), { recursive: true });
      await fs.writeFile(mdAbs, mdText, 'utf8');
      mdPath = mdRel;
    } else {
      // Reference track: no bulk bytes on disk. localRef points at the original
      // file the source plugin produced (when known); a text shadow is a stub
      // to be filled by a later transcript/OCR/summary adapter.
      const shadowRel = join('reference', base, `${inner}.shadow.md`);
      const shadowAbs = join(this.root, shadowRel);
      await fs.mkdir(dirname(shadowAbs), { recursive: true });
      const shadow = markdown ?? [
        `# ${record.title ?? titleFromName(leaf)}`,
        '',
        `- 类型：素材轨（reference），大文件本体不落盘`,
        `- MIME：${mimeType}`,
        `- 字节数：${buf.length}`,
        `- 指针：${record.localRef ?? record.remoteRef ?? '(待补)'}`,
        '',
        '> 文字影子占位：待 transcript / OCR / AI 摘要适配器填充，否则检索不到。',
      ].join('\n');
      await fs.writeFile(shadowAbs, shadow, 'utf8');
      shadowStatus = 'stub';
      mdPath = shadowRel;
      originalPath = record.localRef ?? record.remoteRef;
    }

    const finalRec = makeRecord({
      ...record,
      id,
      checksum: sum,
      storage,
      originalPath,
      mdPath,
      sizeBytes: buf.length,
      sourceType: record.sourceType ?? guessSourceType(mimeType),
      shadowStatus,
      remoteRef: record.remoteRef,
      localRef: record.localRef,
    });
    this.records.set(id, finalRec);
    this.byChecksum.set(sum, id);
    await this._append(finalRec);
    return { record: finalRec, duplicate: false };
  }

  /** Bounded list; optional filters: source, storage, tag, q (title substring), limit. */
  list(filter = {}) {
    const { source, storage, tag, q, limit = 200 } = filter;
    let rows = [...this.records.values()];
    if (source) rows = rows.filter((r) => r.source === source);
    if (storage) rows = rows.filter((r) => r.storage === storage);
    if (tag) rows = rows.filter((r) => (r.tags ?? []).includes(tag));
    if (q) rows = rows.filter((r) => String(r.title).toLowerCase().includes(String(q).toLowerCase()));
    rows.sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));
    return rows.slice(0, Math.max(1, Math.min(500, limit)));
  }

  get(id) {
    return this.records.get(id) ?? null;
  }

  /**
   * Drop one record: rewrite the append-only manifest without it, then remove
   * the files it owns (only inside this.root). Returns the removed record, or
   * null when the id is unknown.
   *
   * Needed because the manifest is an upsert log with no tombstone — without
   * this, a wrong record (e.g. a login page archived by mistake) could never be
   * taken back out of the knowledge base.
   */
  async remove(id) {
    await this.init();
    const rec = this.records.get(id);
    if (!rec) return null;
    this.records.delete(id);
    if (rec.checksum && this.byChecksum.get(rec.checksum) === id) this.byChecksum.delete(rec.checksum);
    const lines = [...this.records.values()].map((r) => JSON.stringify(cleanRecord(r)));
    const tmp = `${this.manifestPath}.tmp`;
    await fs.writeFile(tmp, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
    await fs.rename(tmp, this.manifestPath);
    // Only unlink a path nothing else points at. Records written before the
    // per-record path fix can share one file, and deleting it would leave the
    // surviving record with an empty body.
    const stillUsed = new Set();
    for (const r of this.records.values()) {
      if (r.mdPath) stillUsed.add(r.mdPath);
      if (r.originalPath) stillUsed.add(r.originalPath);
    }
    for (const rel of [rec.mdPath, rec.originalPath]) {
      if (!rel || isAbsolute(rel) || stillUsed.has(rel)) continue;
      const abs = resolve(this.root, rel);
      if (!abs.startsWith(this.root + sep)) continue;
      try { await fs.rm(abs, { force: true }); } catch { /* best effort */ }
    }
    return rec;
  }

  /** Read the normalized Markdown (bounded to maxChars) for a record. */
  async readText(id, maxChars = 8000) {
    const rec = this.records.get(id);
    if (!rec) return null;
    const rel = rec.mdPath;
    if (!rel || isAbsolute(rel)) return { record: rec, text: '', truncated: false, missing: true };
    const abs = resolve(this.root, rel);
    if (!abs.startsWith(this.root + sep) && abs !== this.root) return { record: rec, text: '', truncated: false, missing: true };
    let text = '';
    try { text = await fs.readFile(abs, 'utf8'); } catch { return { record: rec, text: '', truncated: false, missing: true }; }
    const truncated = text.length > maxChars;
    return { record: rec, text: truncated ? `${text.slice(0, maxChars)}\n…[truncated]` : text, truncated, missing: false };
  }

  stats() {
    const byStorage = { materialized: 0, reference: 0 };
    const bySource = {};
    let shadowsPending = 0;
    for (const r of this.records.values()) {
      byStorage[r.storage] = (byStorage[r.storage] ?? 0) + 1;
      bySource[r.source] = (bySource[r.source] ?? 0) + 1;
      if (r.storage === 'reference' && r.shadowStatus === 'stub') shadowsPending += 1;
    }
    return { total: this.records.size, byStorage, bySource, shadowsPending, root: this.root };
  }
}
