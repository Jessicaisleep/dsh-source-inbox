/**
 * Credential vault (Phase 2.3).
 *
 * WHY THIS EXISTS
 * The first version of the guidance ended every "you get an App Secret" step
 * with `填到：<secrets-dir>\feishu.json`. That is a dead end in
 * disguise: the user has to create a file, guess the JSON key names, and a typo
 * produces no error anywhere — the adapter just silently reads nothing. The
 * panel now shows a paste box; this module writes the file.
 *
 * SECURITY RULES (kept deliberately narrow)
 *  - one file per source, bare file name only (`feishu.json`). No separators, no
 *    `..`, no leading dot: the spec is the only thing that names a path, and a
 *    bad spec fails loudly instead of writing somewhere unexpected.
 *  - only fields declared for that source can be written. An unknown key is an
 *    error, not a passthrough, so a caller cannot smuggle extra content in.
 *  - the SAVED value is never returned to any caller. Status reports `saved`,
 *    a masked preview (first 4 chars + length) and the file path — never the
 *    secret itself, so it cannot leak through the panel, a log, or a tool reply.
 *  - written atomically (tmp + rename) with mode 0600 where the platform
 *    supports it, so a half-written file never becomes the live credential and
 *    a crash cannot leave a truncated token.
 *  - nothing here sends anything anywhere. The bytes go to the local disk and
 *    stop there; wiring a source's adapter to READ them is a later phase.
 */
import { mkdir, readFile, writeFile, rename, unlink, chmod } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

/**
 * Where pasted credentials land when nobody says otherwise: `$DSH_HOME/_secrets`,
 * falling back to `~/.dsh/_secrets` when DSH_HOME is not set.
 *
 * Deliberately NOT a hardcoded absolute path: this package is published, so the
 * default has to make sense on someone else's machine. Anyone who keeps tokens
 * somewhere specific (this repo's author uses `E:\DSHWORK\DSH插件\_secrets`)
 * points `config.secretsDir` or `DSH_SECRETS_DIR` at it — a relative value is
 * rejected rather than resolved against an unpredictable cwd.
 */
export function defaultSecretsDir(env = process.env) {
  const home = String(env?.DSH_HOME ?? '').trim();
  return join(home || join(homedir(), '.dsh'), '_secrets');
}

export const DEFAULT_SECRETS_DIR = defaultSecretsDir();

/** Longest single value we accept (a JWT / cookie can be long; a paste-often does not get to 4k). */
export const MAX_VALUE_LENGTH = 4096;

const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;

/** `{ok, dir}` or `{ok:false, dir:'', reason}` — never throws at runtime setup. */
export function resolveSecretsDir(config) {
  const raw = String(config?.secretsDir ?? process.env.DSH_SECRETS_DIR ?? '').trim() || DEFAULT_SECRETS_DIR;
  if (!isAbsolute(raw)) return { ok: false, dir: '', reason: `secretsDir must be an absolute path: ${raw}` };
  return { ok: true, dir: raw };
}

/** Throw on anything that is not a plain `name.json` in the vault dir. */
export function assertVaultFile(file) {
  const f = String(file ?? '');
  if (!FILE_RE.test(f)) throw new Error(`unsafe credential file name: ${f || '(empty)'}`);
  return f;
}

/**
 * Enough to recognise "this is the token I pasted", not enough to use it.
 * Short values are fully starred; longer ones keep 4 leading chars + length.
 */
export function maskValue(value) {
  const s = String(value ?? '');
  if (!s) return '';
  if (s.length <= 6) return '*'.repeat(s.length);
  return `${s.slice(0, 4)}${'*'.repeat(4)}（${s.length} 位）`;
}

const omitMeta = (raw) => {
  const out = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (k === '_meta') continue;
    out[k] = v;
  }
  return out;
};

async function readVault(dir, file) {
  try {
    const text = await readFile(join(dir, file), 'utf8');
    // Never echo the file contents in an error: it holds secrets.
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, raw: {}, reason: `${file} 的内容不是 JSON 对象` };
      }
      return { ok: true, raw: parsed };
    } catch {
      return { ok: false, raw: {}, reason: `${file} 不是合法 JSON（可把它删掉重存一次）` };
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, raw: {} };
    return { ok: false, raw: {}, reason: `读取 ${file} 失败：${String(error?.message ?? error).slice(0, 120)}` };
  }
}

/**
 * Whitelist + sanity gate. Returns only the fields that carry a value, so a
 * blank input means "leave what is already saved alone" instead of wiping it.
 */
export function validateValues(spec, values) {
  const declared = new Map((spec?.fields ?? []).map((f) => [f.key, f]));
  const out = {};
  for (const [k, v] of Object.entries(values ?? {})) {
    const field = declared.get(k);
    if (!field) return { ok: false, reason: `unknown credential field: ${k}` };
    const s = String(v ?? '').trim();
    if (!s) continue;
    if (s.length > MAX_VALUE_LENGTH) {
      return { ok: false, reason: `${field.label} 太长（超过 ${MAX_VALUE_LENGTH} 字符），可能粘到别的内容了` };
    }
    // Control chars other than \t \n are a symptom of pasting binary or a
    // terminal escape sequence, never of a real token.
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) {
      return { ok: false, reason: `${field.label} 含不可见控制字符，可能粘错了` };
    }
    out[k] = s;
  }
  if (!Object.keys(out).length) return { ok: false, reason: '所有输入框都是空的，没有可保存的内容' };
  return { ok: true, values: out };
}

/** Masked, path-annotated status for one source. Safe to hand to the client. */
export async function credentialStatus(dir, sourceId, spec) {
  const file = assertVaultFile(spec.file);
  const read = await readVault(dir, file);
  const values = omitMeta(read.raw);
  const fields = (spec.fields ?? []).map((f) => {
    const v = typeof values[f.key] === 'string' ? values[f.key] : '';
    return {
      key: f.key,
      label: f.label,
      help: f.help ?? '',
      secret: !!f.secret,
      required: !!f.required,
      saved: v.length > 0,
      preview: maskValue(v),
    };
  });
  const required = fields.filter((f) => f.required);
  const satisfied = required.every((f) => f.saved);
  return {
    source: sourceId,
    file,
    dir,
    path: join(dir, file),
    savedAt: read.raw?._meta?.savedAt ?? null,
    configured: satisfied && fields.some((f) => f.saved),
    fields,
    error: read.ok ? '' : read.reason,
  };
}

/**
 * Merge-and-write. Missing keys keep their previously saved value (that is what
 * makes "paste the App Secret now, the App ID later" work across two visits).
 */
export async function saveCredential(dir, sourceId, spec, values) {
  const file = assertVaultFile(spec.file);
  const gate = validateValues(spec, values);
  if (!gate.ok) return { ok: false, reason: gate.reason };
  const prev = await readVault(dir, file);
  if (!prev.ok) return { ok: false, reason: prev.reason };

  const savedAt = new Date().toISOString();
  const merged = {
    ...omitMeta(prev.raw),
    ...gate.values,
    _meta: { source: sourceId, savedAt, writtenBy: 'dsh-source-inbox' },
  };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const abs = join(dir, file);
  const tmp = `${abs}.tmp`;
  // 0600: only this Windows account can read it. The rename is what makes the
  // swap atomic — a reader never sees a partially written token.
  await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, abs);
  try { await chmod(abs, 0o600); } catch { /* Windows ACLs, not POSIX bits */ }
  return { ok: true, status: await credentialStatus(dir, sourceId, spec) };
}

/** Delete the stored credential for one source (idempotent). */
export async function clearCredential(dir, sourceId, spec) {
  const file = assertVaultFile(spec.file);
  try {
    await unlink(join(dir, file));
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { ok: false, reason: `删除 ${file} 失败：${String(error?.message ?? error).slice(0, 120)}` };
    }
  }
  return { ok: true, status: await credentialStatus(dir, sourceId, spec) };
}
