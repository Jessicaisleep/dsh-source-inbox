import { promises as fs } from 'node:fs';
import { join, relative, extname, basename, isAbsolute } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { TEXT_MIMES, DOCUMENT_MIMES, classifyStorage } from './schema.js';
import { safeInnerPath } from './store.js';

// Hard caps to make the import wizard safe on untrusted export bundles.
const MAX_ENTRIES = 3000;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_WALK_FILES = 3000;

/** Canonical extension for a sniffed MIME. */
const EXT_FOR_MIME = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif',
  'image/webp': '.webp', 'image/bmp': '.bmp', 'image/tiff': '.tiff',
  'application/pdf': '.pdf', 'application/zip': '.zip',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg', 'audio/flac': '.flac',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
};

const OFFICE_PARTS = {
  'word/': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'xl/': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'ppt/': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// ---- compliance gate (§2 red line, now enforced in code, not just docs) ----
// A personal WeChat/QQ chat history lives in a LOCAL SQLite database that must
// NEVER be ingested or decrypted. Official export / share bundles (TXT, MD,
// JSON, PDF, Office, images, ZIP) are the only supported input. We reject any
// database-ish file by extension, including WAL/SHM/journal sidecars, so the
// "never a local chat database" promise is a real gate rather than a comment.
// Known high-risk basenames are also blocked even if the extension is renamed.
const CHAT_DB_EXT = /\.(db|db3|sqlite|sqlite3|mdb|realm|wal|shm|journal|db-wal|db-shm|db-journal|sqlite-wal|sqlite-shm|sqlite-journal)$/i;
const CHAT_DB_NAMES = /^(MM\.sqlite|EnMicroMsg\.db|WCDB_Contact|MicroMsg|Msg3\.0|ChatMsg|message\.db|msg\.db|WxFileIndex|sns\.db|Favorite\.db|QQ\.db|QQData|cache4|postbox)/i;

/** True when a file (basename) looks like a local chat database. */
export function isForbiddenChatFile(name) {
  const base = String(name ?? '').split(/[\\/]/).pop();
  return CHAT_DB_EXT.test(base) || CHAT_DB_NAMES.test(base);
}

/**
 * Validate a top-level import target. Returns { ok, reason }.
 * - must be an absolute path (no relative / arbitrary cwd-relative reads)
 * - must not itself be a local chat database
 */
export function validateImportPath(absolutePath) {
  const p = String(absolutePath ?? '').trim();
  if (!p) return { ok: false, reason: 'path is required (absolute path to an export file or directory)' };
  if (!isAbsolute(p)) return { ok: false, reason: 'path must be absolute' };
  if (isForbiddenChatFile(p)) return { ok: false, reason: 'refusing to ingest a local chat database (compliance red line: use an official export / share instead)' };
  return { ok: true, reason: '' };
}

function has(buf, offset, bytes) {
  if (offset + bytes.length > buf.length) return false;
  for (let i = 0; i < bytes.length; i += 1) if (buf[offset + i] !== bytes[i]) return false;
  return true;
}
function u16(buf, o) { return buf.readUInt16LE(o); }
function u32(buf, o) { return buf.readUInt32LE(o); }

function looksLikeText(buf) {
  const sample = buf.subarray(0, 4096);
  if (sample.length === 0) return true;
  let control = 0;
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) control += 1;
  }
  return control / sample.length < 0.02;
}

/**
 * Sniff MIME from magic bytes, then fall back to the extension.
 * WeChat "合并转发" exports frequently carry wrong/missing extensions, so
 * magic bytes take priority (this is the "按魔数纠正扩展名" step).
 */
export function sniffMime(buf, name = '') {
  const ext = extname(String(name)).toLowerCase();
  if (has(buf, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (has(buf, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (has(buf, 0, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (has(buf, 0, [0x52, 0x49, 0x46, 0x46]) && has(buf, 8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  if (has(buf, 0, [0x42, 0x4d])) return 'image/bmp';
  if (has(buf, 0, [0x49, 0x49, 0x2a, 0x00]) || has(buf, 0, [0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff';
  if (has(buf, 0, [0x25, 0x50, 0x44, 0x46])) return 'application/pdf';
  if (has(buf, 0, [0x50, 0x4b, 0x03, 0x04]) || has(buf, 0, [0x50, 0x4b, 0x05, 0x06]) || has(buf, 0, [0x50, 0x4b, 0x07, 0x08])) return 'application/zip';
  if (has(buf, 4, [0x66, 0x74, 0x79, 0x70])) return 'video/mp4';
  if (has(buf, 0, [0x1f, 0x8b])) return 'application/gzip';
  if (has(buf, 0, [0x4f, 0x67, 0x67, 0x53])) return 'audio/ogg';
  if (has(buf, 0, [0x66, 0x4c, 0x61, 0x43])) return 'audio/flac';
  if (has(buf, 0, [0x52, 0x49, 0x46, 0x46]) && has(buf, 8, [0x57, 0x41, 0x56, 0x45])) return 'audio/wav';
  if (has(buf, 0, [0x49, 0x44, 0x33]) || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (has(buf, 0, [0x7b, 0x22]) || has(buf, 0, [0x5b, 0x7b])) {
    try { JSON.parse(buf.toString('utf8')); return 'application/json'; } catch { /* not json */ }
  }
  if (looksLikeText(buf)) {
    if (ext === '.md' || ext === '.markdown') return 'text/markdown';
    if (ext === '.html' || ext === '.htm') return 'text/html';
    if (ext === '.csv') return 'text/csv';
    if (ext === '.json') return 'application/json';
    return 'text/plain';
  }
  return 'application/octet-stream';
}

/** Replace a wrong/missing extension with the canonical one for the sniffed MIME. */
export function correctExtension(name, mime) {
  const canonical = EXT_FOR_MIME[mime];
  if (!canonical) return String(name);
  const base = String(name).replace(/\.[^./\\]+$/, '');
  return `${base}${canonical}`;
}

/**
 * Minimal, dependency-free ZIP reader using the central directory + node:zlib.
 * Returns { entries: [{name, data}], skipped: [{name, reason}], officeMime? }.
 * Deliberately conservative: ZIP64 / encrypted / data-descriptor entries are
 * skipped with an explicit reason rather than guessed.
 */
export function readZipEntries(buf) {
  const entries = [];
  const skipped = [];
  let eocd = -1;
  const floor = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return { entries, skipped: [{ name: '(zip)', reason: '未找到 EOCD，无法按中央目录解析' }], officeMime: undefined };

  const total = u16(buf, eocd + 10);
  let cd = u32(buf, eocd + 16);
  let officeMime;
  let totalBytes = 0;

  for (let n = 0; n < total && n < MAX_ENTRIES; n += 1) {
    if (cd + 46 > buf.length || u32(buf, cd) !== 0x02014b50) break;
    const flags = u16(buf, cd + 8);
    const method = u16(buf, cd + 10);
    const compSize = u32(buf, cd + 20);
    const uncompSize = u32(buf, cd + 24);
    const nameLen = u16(buf, cd + 28);
    const extraLen = u16(buf, cd + 30);
    const commentLen = u16(buf, cd + 32);
    const localOff = u32(buf, cd + 42);
    const rawName = buf.subarray(cd + 46, cd + 46 + nameLen).toString('utf8');
    const name = safeInnerPath(rawName);
    cd += 46 + nameLen + extraLen + commentLen;

    // Detect Office OpenXML by its internal parts; keep it as ONE document.
    if (!officeMime) {
      for (const [prefix, mime] of Object.entries(OFFICE_PARTS)) {
        if (rawName.startsWith(prefix)) { officeMime = mime; break; }
      }
      if (rawName === '[Content_Types].xml' || rawName === '_rels/.rels') officeMime = OFFICE_PARTS['word/'];
    }

    if (!name) { skipped.push({ name: rawName, reason: '不安全路径，已跳过' }); continue; }
    if (flags & 0x1) { skipped.push({ name, reason: '加密条目，Phase 0 不处理' }); continue; }
    if (compSize === 0xffffffff || uncompSize === 0xffffffff) { skipped.push({ name, reason: 'ZIP64 条目，Phase 0 不处理' }); continue; }
    if (uncompSize > MAX_ENTRY_BYTES || totalBytes + uncompSize > MAX_TOTAL_BYTES) {
      skipped.push({ name, reason: '超过体积上限，已跳过' }); continue;
    }
    if (localOff + 30 > buf.length || u32(buf, localOff) !== 0x04034b50) {
      skipped.push({ name, reason: '本地头异常，已跳过' }); continue;
    }
    const lNameLen = u16(buf, localOff + 26);
    const lExtraLen = u16(buf, localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > buf.length) { skipped.push({ name, reason: '数据被截断，已跳过' }); continue; }
    const raw = buf.subarray(dataStart, dataEnd);
    let data;
    try {
      data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
    } catch {
      skipped.push({ name, reason: '解压失败，已跳过' }); continue;
    }
    if (!data) { skipped.push({ name, reason: `压缩方法 ${method} 不支持` }); continue; }
    totalBytes += data.length;
    entries.push({ name, data });
  }
  return { entries, skipped, officeMime };
}

function recordFor({ name, buf, mime, source, tags, capturedAt }) {
  const storage = classifyStorage(mime, buf.length);
  return {
    source,
    sourceType: undefined,
    title: basename(name).replace(/\.[^.]+$/, '') || basename(name),
    capturedAt: capturedAt ?? new Date().toISOString(),
    storage,
    mimeType: mime,
    innerPath: name,
    tags: tags ?? [],
    localRef: undefined,
    remoteRef: undefined,
  };
}

/**
 * Import one absolute path (file or directory) into the store.
 * - ZIP / Office files are expanded (Office kept as one document, ZIP entries
 *   imported individually so chat TXT + media become separate records).
 * - Directories are walked recursively with a file-count cap.
 * Returns a bounded summary; never throws on a single bad file.
 */
export async function importPath(store, absolutePath, opts = {}) {
  const source = opts.source ?? 'import';
  const tags = opts.tags ?? [];
  const result = { imported: [], duplicates: [], skipped: [], errors: [], root: absolutePath };
  let filesSeen = 0;

  const addOne = async (name, buf, forcedMime) => {
    // Defense in depth: a ZIP member or a walked file may be a chat database
    // even when the top-level target is a legitimate folder/ZIP.
    if (isForbiddenChatFile(name)) { result.skipped.push({ name, reason: '本地聊天数据库（合规红线，仅接受官方导出）' }); return; }
    const mime = forcedMime ?? sniffMime(buf, name);
    const finalName = correctExtension(name, mime);
    const rec = recordFor({ name: finalName, buf, mime, source, tags, capturedAt: opts.capturedAt });
    // Text-track files keep their bytes as Markdown directly.
    const markdown = TEXT_MIMES.has(mime) ? buf.toString('utf8') : undefined;
    const { record, duplicate } = await store.put({ buf, record: rec, markdown });
    if (duplicate) result.duplicates.push({ name: finalName, id: record.id });
    else result.imported.push({ name: finalName, id: record.id, storage: record.storage, mimeType: record.mimeType });
  };

  const handleBuffer = async (name, buf) => {
    const mime = sniffMime(buf, name);
    if (mime === 'application/zip') {
      const { entries, skipped, officeMime } = readZipEntries(buf);
      result.skipped.push(...skipped.map((s) => ({ ...s, name: `${name}/${s.name}` })));
      if (officeMime) {
        // Office OpenXML = one document on the text track, not N XML parts.
        await addOne(name, buf, officeMime);
        return;
      }
      for (const entry of entries) {
        if (filesSeen >= MAX_WALK_FILES) { result.skipped.push({ name: `${name}/${entry.name}`, reason: '达到文件数上限' }); break; }
        filesSeen += 1;
        const innerMime = sniffMime(entry.data, entry.name);
        if (innerMime === 'application/zip') {
          // Nested ZIP (e.g. WeChat 合并转发 bundles): recurse one level.
          const nested = readZipEntries(entry.data);
          result.skipped.push(...nested.skipped.map((s) => ({ ...s, name: `${name}/${entry.name}/${s.name}` })));
          for (const ne of nested.entries) {
            if (ne.name.endsWith('/')) continue;
            await addOne(`${name}/${entry.name.replace(/\.zip$/i, '')}/${ne.name}`, ne.data);
          }
        } else if (!entry.name.endsWith('/')) {
          await addOne(`${name.replace(/\.zip$/i, '')}/${entry.name}`, entry.data);
        }
      }
      return;
    }
    await addOne(name, buf, mime);
  };

  // Top-level compliance + path gate (§2). Cheap, and shared by HTTP route and
  // agent tool alike — both call importPath, so both are protected.
  const gate = validateImportPath(absolutePath);
  if (!gate.ok) { result.errors.push({ path: absolutePath, reason: gate.reason }); return result; }

  let stat;
  try { stat = await fs.stat(absolutePath); } catch (e) { result.errors.push({ path: absolutePath, reason: e.message }); return result; }

  try {
    if (stat.isDirectory()) {
      const walk = async (dir) => {
        let items;
        try { items = await fs.readdir(dir, { withFileTypes: true }); } catch (e) { result.errors.push({ path: dir, reason: e.message }); return; }
        for (const it of items) {
          if (filesSeen >= MAX_WALK_FILES) { result.skipped.push({ name: join(dir, it.name), reason: '达到文件数上限' }); break; }
          const full = join(dir, it.name);
          if (it.isDirectory()) { await walk(full); continue; }
          if (!it.isFile()) continue;
          filesSeen += 1;
          const rel = safeInnerPath(relative(absolutePath, full)) ?? it.name;
          try {
            const buf = await fs.readFile(full);
            await handleBuffer(rel, buf);
          } catch (e) { result.errors.push({ path: full, reason: e.message }); }
        }
      };
      await walk(absolutePath);
    } else if (stat.isFile()) {
      const buf = await fs.readFile(absolutePath);
      await handleBuffer(basename(absolutePath), buf);
    }
  } catch (e) {
    result.errors.push({ path: absolutePath, reason: e.message });
  }
  return result;
}
