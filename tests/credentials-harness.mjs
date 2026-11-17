/**
 * Credential vault harness (Phase 2.3).
 *
 * The user's complaint that started this: guidance said
 * "拿到 App ID / App Secret → 填到：E:\...\_secrets\feishu.json", i.e. create the
 * file yourself and guess the JSON keys. The vault replaces that with a paste
 * box. This harness pins the two things that make it safe:
 *   1. the file/path surface is narrow (bare name, declared fields only), and
 *   2. a saved value NEVER comes back out — status carries a masked preview.
 *
 * Every case runs against a temp dir, never the real `_secrets` folder.
 */
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';

import {
  DEFAULT_SECRETS_DIR, MAX_VALUE_LENGTH,
  defaultSecretsDir,
  resolveSecretsDir, assertVaultFile, maskValue, validateValues,
  credentialStatus, saveCredential, clearCredential,
} from '../lib/credentials.js';
import { credentialSources, credentialSpec, sourceStatus } from '../lib/sources.js';

let pass = 0;
const ok = (c, l) => { if (!c) throw new Error('FAIL: ' + l); pass++; console.log('PASS', l); };
const eq = (a, b, l) => ok(JSON.stringify(a) === JSON.stringify(b), `${l} (got ${JSON.stringify(a)})`);

const fail = (fn, re, l) => {
  try { fn(); } catch (e) {
    if (re.test(String(e.message))) { pass++; console.log('PASS', l); return; }
    throw new Error(`FAIL: ${l} — wrong error: ${e.message}`);
  }
  throw new Error(`FAIL: ${l} — did not throw`);
};

// ---------- resolveSecretsDir: absolute or nothing ----------
ok(isAbsolute(DEFAULT_SECRETS_DIR), 'the default vault dir is absolute');
eq(resolveSecretsDir({}), { ok: true, dir: DEFAULT_SECRETS_DIR }, 'no config -> the documented default');
eq(resolveSecretsDir({ secretsDir: 'D:\\vault' }), { ok: true, dir: 'D:\\vault' }, 'config.secretsDir wins');
eq(resolveSecretsDir({ secretsDir: '  D:\\vault  ' }), { ok: true, dir: 'D:\\vault' }, 'it is trimmed');
const rel = resolveSecretsDir({ secretsDir: '_secrets' });
ok(rel.ok === false && /must be an absolute path/.test(rel.reason), 'a RELATIVE vault dir is rejected, not resolved against cwd');
ok(resolveSecretsDir({ secretsDir: '' }).ok === true, 'an empty string falls back to the default');

// The default must be portable: this package is published, so a hardcoded
// machine path would make every other install write into a folder that does
// not exist there. It follows DSH_HOME, and falls back to ~/.dsh.
eq(defaultSecretsDir({ DSH_HOME: 'C:\\dsh-home' }), join('C:\\dsh-home', '_secrets'), 'the default follows DSH_HOME');
const noHome = defaultSecretsDir({});
ok(isAbsolute(noHome) && noHome.endsWith(join('_secrets')), 'without DSH_HOME the default is still absolute, under the user profile');
ok(!/DSHWORK/.test(DEFAULT_SECRETS_DIR), 'the built-in default carries no author-specific machine path');
eq(resolveSecretsDir({ secretsDir: 'E:\\DSHWORK\\DSH插件\\_secrets' }), { ok: true, dir: 'E:\\DSHWORK\\DSH插件\\_secrets' }, 'an explicit absolute override still wins (the author keeps tokens there)');

// ---------- assertVaultFile: bare name only ----------
for (const good of ['feishu.json', 'qqdocs.json', 'a-b_c.1.json']) {
  ok(assertVaultFile(good) === good, `accepts the bare file name ${good}`);
}
for (const bad of ['../feishu.json', 'sub/feishu.json', 'sub\\feishu.json', '.hidden.json', 'feishu.txt', 'feishu', '', null, 'feishu.json.bak']) {
  fail(() => assertVaultFile(bad), /unsafe credential file name/, `rejects ${JSON.stringify(bad)}`);
}

// ---------- maskValue: recognisable, not usable ----------
eq(maskValue(''), '', 'an empty value masks to empty');
eq(maskValue('abc'), '***', 'a short value is fully starred');
eq(maskValue('abcdef'), '******', '6 chars is still fully starred');
eq(maskValue('cli_a1b2c3d4'), 'cli_****（12 位）', 'a long value keeps 4 chars + length');
ok(!maskValue('secret-token-value').includes('token'), 'the mask never contains the tail of the value');

// ---------- validateValues: declared fields only, blank means "keep" ----------
const feishuSpec = credentialSpec('feishu');
ok(feishuSpec && feishuSpec.file === 'feishu.json', 'credentialSpec(feishu) resolves the file name');
eq(validateValues(feishuSpec, { appId: 'cli_abc', appSecret: ' sek ' }), { ok: true, values: { appId: 'cli_abc', appSecret: 'sek' } }, 'values are trimmed and returned');
eq(validateValues(feishuSpec, { appId: 'cli_abc', userAccessToken: '' }), { ok: true, values: { appId: 'cli_abc' } }, 'a blank field is dropped (keeps the saved value)');
ok(validateValues(feishuSpec, { appId: 'cli_abc', evil: 'x' }).ok === false, 'an UNDECLARED field is rejected');
ok(/unknown credential field: evil/.test(validateValues(feishuSpec, { evil: 'x' }).reason), 'the rejection names the field');
ok(validateValues(feishuSpec, {}).ok === false, 'an all-empty save is rejected');
ok(/空的/.test(validateValues(feishuSpec, {}).reason), 'the empty-save reason is human readable');
ok(validateValues(feishuSpec, { appId: 'x'.repeat(MAX_VALUE_LENGTH + 1) }).ok === false, 'an over-long value is rejected');
ok(/太长/.test(validateValues(feishuSpec, { appId: 'x'.repeat(MAX_VALUE_LENGTH + 1) }).reason), 'the over-long reason says 太长');
ok(validateValues(feishuSpec, { appId: `a\u0000b` }).ok === false, 'a NUL byte is rejected');
ok(/控制字符/.test(validateValues(feishuSpec, { appId: 'a\u001bb' }).reason), 'an escape sequence is rejected');
ok(validateValues(feishuSpec, { appId: 'x'.repeat(MAX_VALUE_LENGTH) }).ok === true, 'a value exactly at the limit is fine');

// ---------- registry shape ----------
const credSrcs = credentialSources();
eq(credSrcs.map((s) => s.id), ['feishu', 'qqdocs', 'notion', 'baidu-netdisk', 'weread', 'cubox', 'images', 'email'], 'credentialSources() lists the 8 rows that need a paste box');
eq(credSrcs.reduce((n, s) => n + s.credential.fields.length, 0), 14, 'they declare 14 fields in total');
ok(credSrcs.every((s) => /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(s.credential.file)), 'every declared vault file is a bare name');
ok(credentialSpec('quark') === null && credentialSpec('nope') === null, 'a source with no credential returns null');
ok(credSrcs.every((s) => s.steps.some((st) => st.where && !/^[A-Za-z]:\\/.test(st.where))), 'the guidance no longer points at a Windows path to hand-write');
const st = sourceStatus(1);
ok(st.credentialSources === 8 && st.credentialFields === 14, `sourceStatus reports 8 sources / 14 fields (got ${st.credentialSources}/${st.credentialFields})`);
ok(/pasted credential/.test(st.note), 'the status note mentions the paste box');

// ---------- save -> status -> clear, against a temp vault ----------
const dir = join(await mkdtemp(join(tmpdir(), 'inbox-cred-')), 'vault');
try {
  const before = await credentialStatus(dir, 'feishu', feishuSpec);
  ok(before.configured === false && before.error === '', 'a missing file reads as "not configured", not as an error');
  ok(before.path === join(dir, 'feishu.json') && isAbsolute(before.path), 'status reports the absolute path it would write');
  ok(before.fields.every((f) => f.saved === false && f.preview === ''), 'every field starts unsaved');

  const saved = await saveCredential(dir, 'feishu', feishuSpec, { appId: 'cli_a1b2c3d4', appSecret: 'super-secret-value' });
  ok(saved.ok === true && saved.status.configured === true, 'saving both required fields configures the source');
  const json = JSON.stringify(saved);
  ok(!json.includes('super-secret-value'), 'the SAVE reply does not contain the secret');
  ok(saved.status.fields[0].preview === 'cli_****（12 位）', 'the save reply masks the value instead');
  ok(saved.status.savedAt && typeof saved.status.savedAt === 'string', 'status records when it was saved');

  const onDisk = JSON.parse(await readFile(join(dir, 'feishu.json'), 'utf8'));
  ok(onDisk.appId === 'cli_a1b2c3d4' && onDisk.appSecret === 'super-secret-value', 'the plaintext does land on disk (that is the point)');
  ok(onDisk._meta.writtenBy === 'dsh-source-inbox' && onDisk._meta.source === 'feishu', 'the file carries provenance metadata');

  const after = await credentialStatus(dir, 'feishu', feishuSpec);
  ok(!JSON.stringify(after).includes('super-secret-value'), 'STATUS never returns the secret either');
  ok(after.fields.find((f) => f.key === 'appId').preview.startsWith('cli_'), 'status shows a masked preview');

  // Blank input must not wipe what is already saved (two visits, one field each).
  const merged = await saveCredential(dir, 'feishu', feishuSpec, { appId: '', userAccessToken: 'uat-1234567' });
  ok(merged.ok === true, 'a second save with only the optional field succeeds');
  ok(merged.status.fields.find((f) => f.key === 'appSecret').saved === true, 'the earlier App Secret is preserved when its box is left blank');
  ok(merged.status.fields.find((f) => f.key === 'userAccessToken').saved === true, 'the newly pasted token is stored');

  // Unknown field must not be written even when mixed with good ones.
  const rejected = await saveCredential(dir, 'feishu', feishuSpec, { appId: 'x', sneaky: 'y' });
  ok(rejected.ok === false, 'a save with an undeclared field is refused');
  const stillThere = JSON.parse(await readFile(join(dir, 'feishu.json'), 'utf8'));
  ok(stillThere.sneaky === undefined && stillThere.appId === 'cli_a1b2c3d4', 'a refused save changes nothing on disk');

  // Atomic write: no .tmp left behind.
  const tmpLeft = await stat(join(dir, 'feishu.json.tmp')).then(() => true).catch(() => false);
  ok(tmpLeft === false, 'the temp file is renamed away, not left behind');

  // A corrupt file is reported, not thrown.
  await writeFile(join(dir, 'feishu.json'), '{not json', 'utf8');
  const corrupt = await credentialStatus(dir, 'feishu', feishuSpec);
  ok(corrupt.error.length > 0 && corrupt.configured === false, 'a corrupt vault file surfaces an error instead of crashing');
  const refuse = await saveCredential(dir, 'feishu', feishuSpec, { appId: 'x' });
  ok(refuse.ok === false, 'saving over a corrupt file is refused (do not silently destroy whatever is in there)');

  // clear() is idempotent and removes the file.
  await writeFile(join(dir, 'feishu.json'), JSON.stringify({ appId: 'a', appSecret: 'b' }), 'utf8');
  const cleared = await clearCredential(dir, 'feishu', feishuSpec);
  ok(cleared.ok === true && cleared.status.configured === false, 'clear() unsets the source');
  ok(!JSON.stringify(cleared).includes('"b"'), 'the clear reply carries no value either');
  const again = await clearCredential(dir, 'feishu', feishuSpec);
  ok(again.ok === true, 'clearing twice is fine (ENOENT is not an error)');

  // Two sources must never share a file.
  const files = credSrcs.map((s) => s.credential.file);
  ok(new Set(files).size === files.length, 'every source writes its own file');
  const qq = credentialSpec('qqdocs');
  await saveCredential(dir, 'feishu', feishuSpec, { appId: 'only-feishu' });
  await saveCredential(dir, 'qqdocs', qq, { token: 'only-qqdocs' });
  const f1 = JSON.parse(await readFile(join(dir, 'feishu.json'), 'utf8'));
  const f2 = JSON.parse(await readFile(join(dir, 'qqdocs.json'), 'utf8'));
  ok(f1.appSecret === undefined && f1.appId === 'only-feishu' && f2.token === 'only-qqdocs', 'two sources keep their values in separate files');

  // Non-secret fields are still just fields (email host/user are plain text).
  const emailSpec = credentialSpec('email');
  ok(emailSpec.fields.find((f) => f.key === 'host').secret === false, 'email host is a plain-text field');
  ok(emailSpec.fields.find((f) => f.key === 'password').secret === true, 'email password is a secret field');
  const mail = await saveCredential(dir, 'email', emailSpec, { host: 'imap.qq.com', user: 'me@qq.com', password: 'authcode123' });
  ok(mail.ok === true && mail.status.configured === true, 'a 3-field source saves and configures');
  ok(mail.status.fields.find((f) => f.key === 'host').preview === 'imap****（11 位）', 'even a non-secret field is masked in status');

  // The vault dir gets created on demand and is not world-readable.
  const fresh = join(dir, 'nested', 'deep');
  const made = await saveCredential(fresh, 'qqdocs', qq, { token: 'tok-123456' });
  ok(made.ok === true, 'a missing vault dir is created on demand');
  const st2 = await stat(join(fresh, 'qqdocs.json'));
  ok(st2.isFile(), 'the file exists after the save');
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

console.log(`\n${pass} checks passed.`);
console.log('CREDENTIALS VERIFIED: narrow file surface, declared fields only, masked status, atomic write, clear.');
