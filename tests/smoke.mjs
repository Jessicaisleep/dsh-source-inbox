/**
 * Phase 0 smoke test — pure node: builtins, no test framework.
 * Runs the schema / store / import pipeline against a temp data dir, including
 * a real hand-built ZIP that mimics a WeChat 合并转发 export (TXT + a PNG with
 * a WRONG extension, which the magic-byte sniffer must correct).
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateRawSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { Store } from '../lib/store.js';
import { sniffMime, correctExtension, readZipEntries, importPath, validateImportPath, isForbiddenChatFile } from '../lib/import.js';
import { SOURCES, sourceStatus, HARD_BAN } from '../lib/sources.js';
import { classifyStorage, STORAGE, checksum } from '../lib/schema.js';

// ---- minimal ZIP builder (stored + deflate, central directory) ----
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i];
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8');
    const compressed = deflateRawSync(data);
    const method = 8;
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30); compressed.copy(local, 30 + nameBuf.length);
    locals.push(local);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36); central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const cdOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(cdOffset, 16); eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

async function main() {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-inbox-test-'));
  const dataDir = join(root, 'data');
  const exportDir = join(root, 'export');
  await fs.mkdir(exportDir, { recursive: true });
  const results = [];
  const check = (name, fn) => { fn(); results.push(`PASS ${name}`); };

  // 1. schema
  check('classifyStorage text -> materialized', () => assert.equal(classifyStorage('text/markdown', 10), STORAGE.MATERIALIZED));
  check('classifyStorage image -> reference', () => assert.equal(classifyStorage('image/png', 10), STORAGE.REFERENCE));
  check('classifyStorage big octet -> reference', () => assert.equal(classifyStorage('application/octet-stream', 6 * 1024 * 1024), STORAGE.REFERENCE));
  check('checksum deterministic', () => assert.equal(checksum(Buffer.from('abc')), checksum(Buffer.from('abc'))));

  // 2. magic-byte sniffing + extension correction
  check('sniff PNG regardless of extension', () => assert.equal(sniffMime(PNG_MAGIC, 'photo.dat'), 'image/png'));
  check('correctExtension .dat -> .png', () => assert.equal(correctExtension('photo.dat', 'image/png'), 'photo.png'));
  check('sniff text markdown', () => assert.equal(sniffMime(Buffer.from('# hello\n'), 'note.md'), 'text/markdown'));

  // 3. source registry
  check('~27 sources registered', () => assert.ok(SOURCES.length >= 25, `only ${SOURCES.length}`));
  check('status phase 0 / adapters 0', () => {
    const st = sourceStatus();
    assert.equal(st.phase, 0);
    assert.equal(st.adaptersWired, 0);
  });
  check('hard ban defined', () => {
    assert.equal(typeof HARD_BAN.rule, 'string');
    assert.ok(HARD_BAN.rule.includes('数据库'));
  });
  // compliance gate (§2 red line enforced in code)
  check('validateImportPath rejects missing', () => assert.equal(validateImportPath('').ok, false));
  check('validateImportPath rejects relative', () => assert.equal(validateImportPath('relative/notes.md').ok, false));
  check('validateImportPath accepts absolute export', () => assert.equal(validateImportPath(join(exportDir, 'forward.zip')).ok, true));
  check('isForbiddenChatFile flags .sqlite/.db/WAL', () => {
    assert.equal(isForbiddenChatFile('MM.sqlite'), true);
    assert.equal(isForbiddenChatFile('EnMicroMsg.db'), true);
    assert.equal(isForbiddenChatFile('msg.db-wal'), true);
    assert.equal(isForbiddenChatFile('chat/2025-01.txt'), false);
  });
  check('validateImportPath refuses chat database (absolute)', () => assert.equal(validateImportPath(join(exportDir, 'MM.sqlite')).ok, false));
  // importPath itself gates (defense in depth) even when called directly.
  // The gate returns before any store access, so a fresh (uninit) Store is fine.
  const gated = await importPath(new Store(dataDir), 'relative/notes.md');
  check('importPath gates a relative path directly', () => assert.equal(gated.imported.length, 0) && assert.equal(gated.errors.length, 1));

  // 4. ZIP reader (deflate)
  const zip = makeZip([['chat/2025-01.txt', 'Alice: 明天交稿\nBob: 好\n'], ['chat/photo.wrong', PNG_MAGIC]]);
  const parsed = readZipEntries(zip);
  check('ZIP entries parsed', () => assert.equal(parsed.entries.length, 2));
  check('ZIP text member decompressed', () => assert.ok(parsed.entries[0].data.toString('utf8').includes('明天交稿')));
  check('ZIP skip list empty', () => assert.equal(parsed.skipped.length, 0));

  // 5. end-to-end import of a folder with a ZIP + a loose markdown
  await fs.writeFile(join(exportDir, 'forward.zip'), zip);
  await fs.writeFile(join(exportDir, 'deepseek-export.md'), '# 一次问答\n\n用户：量子计算是什么？\n模型：……\n');
  const store = new Store(dataDir);
  const summary = await importPath(store, exportDir, { source: 'wechat-chat', tags: ['测试'] });
  check('import produced records', () => assert.ok(summary.imported.length >= 3, JSON.stringify(summary)));
  check('import has no errors', () => assert.equal(summary.errors.length, 0, JSON.stringify(summary.errors)));
  check('PNG magic corrected inside ZIP', () => assert.ok(summary.imported.some((r) => r.name.endsWith('photo.png'))));
  check('reference track holds no bulk bytes', () => {
    const png = summary.imported.find((r) => r.name.endsWith('photo.png'));
    assert.equal(png.storage, STORAGE.REFERENCE);
  });

  // 6. de-duplication + bounded list + safe read
  const before = store.stats().total;
  const again = await importPath(store, exportDir, { source: 'wechat-chat' });
  check('re-import de-duplicates', () => assert.equal(again.imported.length, 0) && assert.equal(again.duplicates.length >= 1, true));
  check('total unchanged after re-import', () => assert.equal(store.stats().total, before));
  check('list bounded + filtered', () => assert.ok(store.list({ storage: 'materialized' }).length >= 2));
  const firstText = store.list({ storage: 'materialized' })[0];
  const read = await store.readText(firstText.id, 40);
  check('readText returns text', () => assert.ok(typeof read.text === 'string' && !read.missing));
  check('readText enforces bound', () => assert.ok(read.text.length <= 60));
  const bad = await store.readText('does-not-exist');
  check('readText null on missing', () => assert.equal(bad, null));

  // 7. path-traversal guard
  const { safeInnerPath } = await import('../lib/store.js');
  check('safeInnerPath blocks ..', () => assert.equal(safeInnerPath('../../etc/passwd'), 'etc/passwd'));
  check('safeInnerPath blocks absolute', () => assert.equal(safeInnerPath('/etc/passwd'), null));
  check('safeInnerPath blocks drive', () => assert.equal(safeInnerPath('C:\\Windows\\x'), null));

  // 7. two records from the SAME source in the SAME month must not collide.
  // Regression: the target path used to fall back to the literal leaf "file",
  // so the second write overwrote the first and reading one record returned
  // the other record's body.
  const a = await store.put({
    buf: Buffer.from('# page A\n\nAAA body\n', 'utf8'),
    record: { source: 'collide', title: 'A', mimeType: 'text/markdown', storage: STORAGE.MATERIALIZED, capturedAt: '2026-11-16T10:00:00.000Z' },
  });
  const b = await store.put({
    buf: Buffer.from('# page B\n\nBBB body\n', 'utf8'),
    record: { source: 'collide', title: 'B', mimeType: 'text/markdown', storage: STORAGE.MATERIALIZED, capturedAt: '2026-11-16T11:00:00.000Z' },
  });
  check('same-source records get distinct ids', () => assert.notEqual(a.record.id, b.record.id));
  check('same-source records get distinct paths', () => assert.notEqual(a.record.mdPath, b.record.mdPath));
  const readA = await store.readText(a.record.id);
  const readB = await store.readText(b.record.id);
  check('record A still reads its own body', () => assert.match(readA.text, /AAA body/));
  check('record B still reads its own body', () => assert.match(readB.text, /BBB body/));

  // 8. remove(): a wrong record must be takeable back out of the knowledge base.
  const aPath = join(dataDir, a.record.mdPath);
  const bPath = join(dataDir, b.record.mdPath);
  const removed = await store.remove(a.record.id);
  check('remove() returns the removed record', () => assert.equal(removed?.id, a.record.id));
  check('remove() drops it from the store', () => assert.equal(store.get(a.record.id), null));
  const readBAfter = await store.readText(b.record.id);
  check('remove() leaves the other record readable', () => assert.match(readBAfter.text, /BBB body/));
  check('remove() deletes the file it owned', async () => {});
  let aGone = false;
  try { await fs.stat(aPath); } catch { aGone = true; }
  check('removed record file is gone from disk', () => assert.equal(aGone, true));
  let bThere = true;
  try { await fs.stat(bPath); } catch { bThere = false; }
  check('surviving record file is still on disk', () => assert.equal(bThere, true));
  const unknown = await store.remove('no-such-id');
  check('remove() unknown id -> null', () => assert.equal(unknown, null));
  // The manifest must survive the rewrite: reopening the store sees only survivors.
  const reopened = new Store(dataDir);
  await reopened.init();
  check('manifest rewrite persists the removal', () => assert.equal(reopened.get(a.record.id), null) && Boolean(reopened.get(b.record.id)));

  console.log(results.join('\n'));
  console.log(`\n${results.length} checks passed. dataDir=${dataDir}`);
  await fs.rm(root, { recursive: true, force: true });
}
main().catch((e) => { console.error('SMOKE FAILED:', e); process.exit(1); });
