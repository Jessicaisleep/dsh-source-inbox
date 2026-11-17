/**
 * Phase 1 adapter harness — exercises the REAL lib/adapters.js end-to-end
 * against a temp Store + temp dropzone. No DOM, no renderer, zero deps.
 *
 * Run: node tests/adapters-harness.mjs
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store } from '../lib/store.js';
import {
  ADAPTERS, wiredCount, isUnsafeWatchDir, DropZoneWatcher, AdapterRuntime,
} from '../lib/adapters.js';

let pass = 0;
function ok(cond, label) {
  if (!cond) { console.error('ADAPTERS FAILED:', label); process.exit(1); }
  pass += 1;
}

const root = fileURLToPath(new URL('..', import.meta.url));
const base = await fs.mkdtemp(join(tmpdir(), 'dsh-inbox-adapters-'));
const dataDir = join(base, 'archive');
const zone = join(base, 'dropzone');
await fs.mkdir(zone, { recursive: true });

async function cleanup() {
  await fs.rm(base, { recursive: true, force: true }).catch(() => {});
}

try {
  // ---- registry -----------------------------------------------------------
  ok(Array.isArray(ADAPTERS) && ADAPTERS.length === 2, 'registry has 2 adapters');
  const dz = ADAPTERS.find((a) => a.id === 'dropzone');
  const mcp = ADAPTERS.find((a) => a.id === 'official-mcp');
  ok(dz && dz.state === 'wired' && dz.auto === true && dz.auth === 'none', 'dropzone is wired/auto/no-auth');
  ok(mcp && mcp.state === 'needs-auth' && mcp.auto === false && mcp.auth === 'user', 'official-mcp honestly needs-auth');
  ok(wiredCount() === 1, 'wiredCount() === 1 (only dropzone is live)');

  // ---- watch-dir safety gate ---------------------------------------------
  ok(isUnsafeWatchDir(dataDir, dataDir) === true, 'archive root itself is unsafe');
  ok(isUnsafeWatchDir(join(dataDir, '_raw'), dataDir) === true, 'an in-archive subdir is unsafe');
  ok(isUnsafeWatchDir(join(dataDir, 'dropzone'), dataDir) === false, '<root>/dropzone is the one allowed in-archive dir');
  ok(isUnsafeWatchDir(base, dataDir) === true, 'an ancestor of the archive is unsafe (would re-ingest output)');
  ok(isUnsafeWatchDir(zone, dataDir) === false, 'an external absolute dir is safe');

  // ---- runtime + config persistence --------------------------------------
  const store = new Store(dataDir);
  await store.init();
  const rt = new AdapterRuntime(store, dataDir);
  await rt.load();
  ok(rt.status().phase === 1, 'runtime status phase === 1');
  ok(rt.status().wired === 1, 'runtime status wired === 1');
  ok(rt.status().adapters.length === 2, 'runtime exposes 2 adapters');
  ok(rt.watcher.opts.dir === join(dataDir, 'dropzone'), 'default dropzone dir is <root>/dropzone');
  ok((await fs.stat(join(dataDir, 'adapters.json')).catch(() => null)) === null, 'no config file before an explicit configure (load does not persist)');

  // configure to an external zone + persist
  const cfg = await rt.configureDropzone({ dir: zone, pollMs: 5000, source: 'dropzone', tags: ['auto'] });
  ok(cfg.ok === true, 'configureDropzone(external dir) ok');
  ok(rt.watcher.opts.dir === zone, 'watcher dir updated to external zone');
  ok(rt.watcher.opts.tags[0] === 'auto' && rt.watcher.opts.pollMs === 5000, 'options sanitized/whitelisted');
  const saved = JSON.parse(await fs.readFile(rt.configPath, 'utf8'));
  ok(saved.dropzone.dir === zone && saved.dropzone.enabled === true, 'config persisted to adapters.json');

  // reload a second runtime -> config is restored from disk
  const rt2 = new AdapterRuntime(store, dataDir);
  await rt2.load();
  ok(rt2.watcher.opts.dir === zone, 'a fresh runtime restores the saved dropzone dir');

  // ---- reject an overlapping / relative / unsafe dir ---------------------
  const bad1 = await rt2.configureDropzone({ dir: join(dataDir, '_raw') });
  ok(bad1.ok === false && /feedback loop|overlap/i.test(bad1.reason), 'overlapping dir rejected');
  const bad2 = await rt2.configureDropzone({ dir: 'relative/path' });
  ok(bad2.ok === false, 'relative dir rejected');

  // ---- end-to-end: drop a text file -> scan -> archive -------------------
  const note = join(zone, 'meeting-notes.md');
  await fs.writeFile(note, '# Weekly sync\n\n- official export sample\n', 'utf8');
  const scan1 = await rt2.scanOnce(true);
  ok(scan1.imported >= 1, 'first scan imports the dropped file');
  ok(scan1.errors === 0, 'first scan has no errors');
  const total1 = store.stats().total;
  ok(total1 >= 1, 'Store now has >=1 archived record');
  const list = store.list({ source: 'dropzone' });
  ok(list.length >= 1 && list[0].storage === 'materialized', 'record landed on the materialized (text) track');

  // second scan is a no-op thanks to the size+mtime signature
  const scan2 = await rt2.scanOnce(true);
  ok(scan2.imported === 0, 'second scan re-imports nothing (signature de-dup)');
  ok(store.stats().total === total1, 'no duplicate records after the second scan');

  // ---- compliance red line, in code --------------------------------------
  const db = join(zone, 'MM.sqlite');
  await fs.writeFile(db, 'not-a-real-db-but-forbidden-by-name', 'utf8');
  const beforeDb = store.stats().total;
  const scan3 = await rt2.scanOnce(true);
  ok(scan3.skippedFiles >= 1, 'a local chat database dropped in the zone is skipped');
  ok(store.stats().total === beforeDb, 'the chat database was NOT archived (compliance gate)');
  const f = scan3.files.find((x) => String(x.name).includes('MM.sqlite'));
  ok(f && /chat database|red line/i.test(String(f.skipped)), 'skip reason mentions the compliance red line');

  // ---- a second, changed file is still picked up --------------------------
  await fs.writeFile(join(zone, 'yuanbao-chat.txt'), 'another export\n', 'utf8');
  const scan4 = await rt2.scanOnce(true);
  ok(scan4.imported >= 1, 'a new/changed file in the zone is imported on the next scan');

  // ---- disabled watcher: timer scan is a no-op, force still works --------
  await rt2.configureDropzone({ enabled: false });
  const dis = await rt2.watcher.scanOnce(false);
  ok(dis.skipped === true && /disabled/i.test(dis.reason), 'disabled watcher: normal scan is a no-op');
  const forced = await rt2.watcher.scanOnce(true);
  ok(forced.skipped !== true, 'force=true ignores the enabled flag for a manual run');

  // ---- start / stop clears the timer (no residual handle) -----------------
  await rt2.configureDropzone({ enabled: true, pollMs: 100000 });
  const w = new DropZoneWatcher(store, { dir: zone, pollMs: 100000, minAgeMs: 0, enabled: true });
  w.start();
  ok(w.running === true && w.timer !== null, 'start() arms a one-shot timer');
  w.stop();
  ok(w.running === false && w.timer === null, 'stop() clears the timer (cleanup leaves no residual handle)');
  const st = w.status();
  ok(typeof st.scans === 'number' && typeof st.seen === 'number' && 'dir' in st, 'status() is a bounded object');

  // ---- status note is honest about MCP -----------------------------------
  ok(/authorization/i.test(rt2.status().note), 'status note tells the truth: official MCP needs user authorization');

  console.log(`ADAPTERS VERIFIED: registry + watch-dir gate + config persistence + dropzone end-to-end + compliance gate + cleanup.`);
  console.log(`${pass} checks passed.`);
} finally {
  await cleanup();
}
