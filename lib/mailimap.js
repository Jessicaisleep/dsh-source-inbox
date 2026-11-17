/**
 * dsh-source-inbox — Phase 3: a small IMAP reader, in-house.
 *
 * The guidance used to say "本机 dsh-email 用 IMAP 增量取新邮件正文". That
 * package does not exist; naming it sends the user looking for something to
 * install, which is the supply-chain risk the author objected to. So the IMAP
 * client lives here, built on node:tls only — no dependency.
 *
 * WHAT IT DOES (deliberately small)
 *   connect over implicit TLS -> LOGIN -> SELECT a mailbox -> fetch the newest
 *   N messages -> decode the parts a knowledge base can index (text/plain,
 *   text/html reduced to text) -> return plain objects.
 *
 * WHAT IT DOES NOT DO
 *   - no sending, no deleting, no flag changes, no folder creation: every
 *     command it issues is SELECT / FETCH / LOGOUT, all read-only
 *   - no OAuth flow: it takes the IMAP app password / 授权码 the user pasted
 *   - it never logs the password; errors carry the server's words only
 *
 * WHY NOT A LIBRARY: this needs ~300 lines of protocol for the read path, and a
 * mail library would be the single largest dependency in the plugin. The subset
 * used here is stable (RFC 3501 since 2003).
 */

import { connect as tlsConnect } from 'node:tls';

export const DEFAULT_IMAP_PORT = 993;
export const MAX_FETCH_MESSAGES = 50;

/** Hosts the panel pre-fills, so the user does not have to look them up. */
export const COMMON_IMAP_HOSTS = Object.freeze({
  'qq.com': 'imap.qq.com',
  'foxmail.com': 'imap.qq.com',
  '163.com': 'imap.163.com',
  '126.com': 'imap.126.com',
  'yeah.net': 'imap.yeah.net',
  'gmail.com': 'imap.gmail.com',
  'outlook.com': 'outlook.office365.com',
  'hotmail.com': 'outlook.office365.com',
  'live.com': 'outlook.office365.com',
  'icloud.com': 'imap.mail.me.com',
  'sina.com': 'imap.sina.com',
  'aliyun.com': 'imap.aliyun.com',
});

/** Best-effort host guess from the address; '' when unknown. */
export function guessImapHost(email) {
  const addr = String(email ?? '').trim().toLowerCase();
  const at = addr.lastIndexOf('@');
  if (at < 0) return '';
  return COMMON_IMAP_HOSTS[addr.slice(at + 1)] ?? '';
}

/* ------------------------------------------------------------- tiny client */

/**
 * A minimal IMAP4rev1 client: enough to read, nothing more.
 *
 * Every public method resolves to `{ok:true,...}` or `{ok:false,reason}` —
 * callers never see a thrown socket error, because a mail server refusing a
 * connection is a normal outcome for a user with a wrong password.
 */
export class ImapClient {
  constructor(opts = {}) {
    this.host = String(opts.host ?? '').trim();
    this.port = Number(opts.port) || DEFAULT_IMAP_PORT;
    this.timeoutMs = Math.max(3000, Math.min(120000, Number(opts.timeoutMs) || 20000));
    this.socket = null;
    this.buffer = '';
    this.waiters = [];
    this.tagSeq = 0;
    this.closed = false;
  }

  /** Greeting + capabilities are consumed before the first command. */
  async connect() {
    if (!this.host) return { ok: false, reason: '缺少 IMAP 服务器地址' };
    if (this.socket) return { ok: true };
    const connected = await new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      let sock;
      try {
        sock = tlsConnect(
          { host: this.host, port: this.port, servername: this.host, rejectUnauthorized: true },
          () => done({ ok: true }),
        );
      } catch (e) {
        done({ ok: false, reason: `无法建立 TLS 连接：${e?.message ?? e}` });
        return;
      }
      sock.setTimeout(this.timeoutMs, () => {
        try { sock.destroy(); } catch { /* ignore */ }
        done({ ok: false, reason: `连接 ${this.host}:${this.port} 超时` });
      });
      sock.on('error', (e) => done({ ok: false, reason: `连接失败：${e?.message ?? e}` }));
      sock.on('data', (chunk) => this._onData(chunk));
      sock.on('close', () => { this.closed = true; this._flushWaiters({ ok: false, reason: '连接已关闭' }); });
      this.socket = sock;
    });
    if (!connected.ok) return connected;
    // The server greets with `* OK ...` before any command is legal.
    const greeting = await this._readUntil((buf) => /\* OK/i.test(buf) || /^\* (NO|BYE)/im.test(buf));
    if (!greeting.ok) return greeting;
    if (/^\* (NO|BYE)/im.test(greeting.text)) return { ok: false, reason: `服务器拒绝连接：${greeting.text.trim()}` };
    return { ok: true };
  }

  _onData(chunk) {
    this.buffer += chunk.toString('utf8');
    const pending = this.waiters.slice();
    for (const w of pending) {
      if (w.test(this.buffer)) {
        this.waiters = this.waiters.filter((x) => x !== w);
        const text = this.buffer;
        this.buffer = '';
        w.resolve({ ok: true, text });
      }
    }
  }

  _flushWaiters(result) {
    const pending = this.waiters.slice();
    this.waiters = [];
    for (const w of pending) w.resolve(result);
  }

  _readUntil(test) {
    return new Promise((resolve) => {
      if (test(this.buffer)) {
        const text = this.buffer;
        this.buffer = '';
        resolve({ ok: true, text });
        return;
      }
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== wrapped);
        resolve({ ok: false, reason: `等待服务器响应超时（${this.timeoutMs}ms）` });
      }, this.timeoutMs);
      const wrapped = (v) => { clearTimeout(timer); resolve(v); };
      this.waiters.push({ test, resolve: wrapped });
    });
  }

  async _command(line) {
    this.tagSeq += 1;
    const tag = `a${this.tagSeq}`;
    try { this.socket.write(`${tag} ${line}\r\n`); } catch (e) { return { ok: false, reason: `发送失败：${e?.message ?? e}` }; }
    const res = await this._readUntil((buf) => new RegExp(`(^|\\r\\n)${tag} (OK|NO|BAD)`, 'i').test(buf));
    if (!res.ok) return res;
    const m = res.text.match(new RegExp(`(^|\\r\\n)${tag} (OK|NO|BAD)([^\\r\\n]*)`, 'i'));
    const status = (m?.[2] ?? '').toUpperCase();
    return { ok: status === 'OK', status, text: res.text, detail: String(m?.[3] ?? '').trim() };
  }

  async login(user, password) {
    if (!user || !password) return { ok: false, reason: '缺少邮箱地址或授权码' };
    const connected = await this.connect();
    if (!connected.ok) return connected;
    // Quote the strings: passwords may contain spaces or specials.
    const esc = (v) => String(v).replace(/([\\"])/g, '\\$1');
    const r = await this._command(`LOGIN "${esc(user)}" "${esc(password)}"`);
    if (!r.ok) {
      // Never echo the password; the server's own words are enough.
      return { ok: false, reason: `登录被拒绝：${r.detail || r.status}` };
    }
    return { ok: true };
  }

  async select(mailbox = 'INBOX') {
    const esc = String(mailbox).replace(/([\\"])/g, '\\$1');
    const r = await this._command(`SELECT "${esc}"`);
    if (!r.ok) return { ok: false, reason: `无法打开信箱 ${mailbox}：${r.detail || r.status}` };
    const m = r.text.match(/\*\s+(\d+)\s+EXISTS/i);
    return { ok: true, exists: m ? Number(m[1]) : 0 };
  }

  /** Fetch the newest `limit` messages as header + decoded text body. */
  async fetchRecent(limit = 10) {
    const n = Math.max(1, Math.min(MAX_FETCH_MESSAGES, Math.trunc(Number(limit) || 10)));
    const exists = await this.select('INBOX');
    if (!exists.ok) return exists;
    if (exists.exists === 0) return { ok: true, messages: [], exists: 0 };
    const from = Math.max(1, exists.exists - n + 1);
    const range = `${from}:${exists.exists}`;
    // BODY.PEEK keeps the \Seen flag untouched — reading the user's mail must not
    // mark it read in their real client.
    const r = await this._command(`FETCH ${range} (UID BODY.PEEK[HEADER.FIELDS (DATE FROM TO SUBJECT MESSAGE-ID CONTENT-TYPE)] BODY.PEEK[TEXT])`);
    if (!r.ok) return { ok: false, reason: `取邮件失败：${r.detail || r.status}` };
    return { ok: true, exists: exists.exists, messages: parseFetchResponse(r.text) };
  }

  async logout() {
    if (!this.socket) return;
    try { await this._command('LOGOUT'); } catch { /* ignore */ }
    try { this.socket.end(); } catch { /* ignore */ }
    this.socket = null;
  }
}

/* ------------------------------------------------------------ parsing bits */

/**
 * Split a FETCH response into messages.
 *
 * IMAP literals are `{123}\r\n<123 bytes>`; a regex over the byte stream would
 * miscount on multibyte text, so the parser walks the string and honours the
 * declared byte lengths.
 */
export function parseFetchResponse(raw) {
  const text = String(raw ?? '');
  const messages = [];
  const startRe = /(?:^|\r?\n)\*\s+\d+\s+FETCH\s+\(/gi;
  let m;
  while ((m = startRe.exec(text)) !== null) {
    const bodyStart = m.index + m[0].length;
    const slice = text.slice(bodyStart);
    // Header block first, then the text body; both arrive as literals.
    const header = readLiteral(slice, 0);
    if (!header) continue;
    const afterHeader = header.end;
    const body = readLiteral(slice, afterHeader);
    const fields = parseHeaderFields(header.value);
    messages.push({
      subject: decodeMimeWords(fields.subject ?? ''),
      from: decodeMimeWords(fields.from ?? ''),
      to: decodeMimeWords(fields.to ?? ''),
      date: fields.date ?? '',
      messageId: (fields['message-id'] ?? '').replace(/[<>]/g, '').trim(),
      contentType: fields['content-type'] ?? '',
      body: body ? extractReadableBody(body.value, fields['content-type'] ?? '') : '',
    });
    startRe.lastIndex = bodyStart + (body ? body.end : afterHeader);
  }
  return messages;
}

function readLiteral(s, from) {
  const re = /\{(\d+)\}\r?\n/g;
  re.lastIndex = from;
  const m = re.exec(s);
  if (!m) return null;
  const start = m.index + m[0].length;
  const len = Number(m[1]);
  if (!Number.isFinite(len) || len < 0) return null;
  // `{n}` counts BYTES, but slice counts UTF-16 code units. Slicing by n over a
  // Chinese body over-reads (4 CJK chars are 12 bytes = 4 units), so the slice
  // must walk the string and stop when n bytes have been consumed.
  let end = start;
  let bytes = 0;
  while (end < s.length && bytes < len) {
    const cp = s.codePointAt(end);
    const width = cp > 0xffff ? 2 : 1;
    bytes += Buffer.byteLength(String.fromCodePoint(cp), 'utf8');
    end += width;
  }
  return { value: s.slice(start, end), end };
}

function parseHeaderFields(raw) {
  const out = {};
  const unfolded = String(raw ?? '').replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

/** RFC 2047 encoded-words (=?utf-8?B?...?=) -> plain text. */
export function decodeMimeWords(input) {
  return String(input ?? '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, charset, enc, data) => {
    try {
      const buf = enc.toUpperCase() === 'B'
        ? Buffer.from(data, 'base64')
        : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_x, h) => String.fromCharCode(parseInt(h, 16))), 'binary');
      const cs = String(charset).toLowerCase();
      if (/^(utf-?8|us-ascii|ascii)$/.test(cs)) return buf.toString('utf8');
      if (/^(gb2312|gbk|gb18030)$/.test(cs)) return new TextDecoder('gb18030', { fatal: false }).decode(buf);
      return new TextDecoder('utf-8', { fatal: false }).decode(buf);
    } catch { return m; }
  });
}

function decodeQuotedPrintable(input) {
  const s = String(input ?? '').replace(/=\r?\n/g, '');
  const bytes = [];
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(bytes));
}

/**
 * Pull readable text out of a body.
 *
 * A knowledge base wants prose, not MIME scaffolding: multipart boundaries,
 * base64 blobs and HTML tags are all dropped. Attachments are ignored on
 * purpose — the archive keeps text, and a 20 MB PDF inside a mail is not a
 * record.
 */
export function extractReadableBody(body, contentType = '') {
  const raw = String(body ?? '');
  const declared = String(contentType ?? '');
  const ct = declared.toLowerCase();
  // The boundary is CASE-SENSITIVE: taking it from the lowercased copy turns
  // `boundary="BND"` into `bnd`, the split then finds nothing, and every
  // multipart mail came out empty. Read it from the original string.
  const boundaryMatch = declared.match(/boundary\s*=\s*"?([^";]+)"?/i);
  if (/multipart/i.test(ct) && boundaryMatch) {
    const boundary = `--${boundaryMatch[1]}`;
    const parts = raw.split(boundary);
    const texts = [];
    for (const part of parts) {
      const split = part.indexOf('\r\n\r\n') >= 0 ? part.indexOf('\r\n\r\n') + 4 : part.indexOf('\n\n') + 2;
      if (split <= 1 || split > part.length) continue;
      const head = part.slice(0, split).toLowerCase();
      const payload = part.slice(split);
      const partType = (head.match(/content-type:\s*([^;\r\n]+)/i) ?? [])[1] ?? '';
      const enc = (head.match(/content-transfer-encoding:\s*([^\r\n;]+)/i) ?? [])[1] ?? '';
      if (/attachment|name=/.test(head) && !/text\//.test(partType)) continue;
      let decoded = payload;
      if (/base64/i.test(enc)) {
        try { decoded = Buffer.from(payload.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch { continue; }
      } else if (/quoted-printable/i.test(enc)) {
        decoded = decodeQuotedPrintable(payload);
      }
      if (/text\/html/i.test(partType)) texts.push(htmlToText(decoded));
      else if (/text\/plain/i.test(partType) || !partType) texts.push(decoded.trim());
    }
    return texts.filter(Boolean).join('\n\n').trim();
  }
  // The transfer encoding normally arrives as its own header, but callers that
  // only have the body may pass it inside the contentType string, so look at both.
  const enc = ((`${declared}\r\n${raw}`.match(/content-transfer-encoding:\s*([^\r\n;]+)/i) ?? [])[1] ?? '').trim();
  if (/base64/i.test(ct) || /base64/i.test(enc)) {
    try { return Buffer.from(raw.replace(/\s+/g, ''), 'base64').toString('utf8').trim(); } catch { return raw.trim(); }
  }
  // Only decode quoted-printable when the mail says it used it. A body that is
  // already 8-bit text (the common case for CJK mail) must be left alone:
  // decodeQuotedPrintable walks charCodeAt & 0xff, so running it over decoded
  // UTF-8 turns 「只有正文」 into mojibake.
  const qp = /quoted-printable/i.test(enc) ? decodeQuotedPrintable(raw) : raw;
  if (/text\/html/i.test(ct)) return htmlToText(qp).trim();
  return qp.trim();
}

function htmlToText(html) {
  return String(html ?? '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\b[^>]*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** One mail as a Markdown record. */
export function renderMailMarkdown(msg) {
  const subject = String(msg?.subject ?? '').trim() || '(无主题)';
  return [
    '---',
    `title: ${JSON.stringify(subject)}`,
    'source: email',
    `from: ${JSON.stringify(String(msg?.from ?? ''))}`,
    `date: ${JSON.stringify(String(msg?.date ?? ''))}`,
    `messageId: ${JSON.stringify(String(msg?.messageId ?? ''))}`,
    '---',
    '',
    `# ${subject}`,
    '',
    msg?.from ? `- 发件人：${msg.from}` : null,
    msg?.to ? `- 收件人：${msg.to}` : null,
    msg?.date ? `- 日期：${msg.date}` : null,
    '',
    '> 由 dsh-source-inbox 用本人 IMAP 只读拉取（BODY.PEEK，不改变已读状态）；仅本地归档。',
    '',
    String(msg?.body ?? '').trim() || '(这封邮件没有可提取的纯文本正文)',
    '',
  ].filter((line) => line !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** Connect, log in, pull the newest `limit` mails, always log out. */
export async function fetchRecentMail({ host, user, password, mailbox = 'INBOX', limit = 10 } = {}) {
  const client = new ImapClient({ host: String(host ?? '').trim() });
  try {
    const logged = await client.login(String(user ?? '').trim(), String(password ?? ''));
    if (!logged.ok) return logged;
    const r = await client.fetchRecent(limit);
    if (!r.ok) return r;
    return {
      ok: true,
      exists: r.exists,
      count: r.messages.length,
      docs: r.messages.map((m) => ({ message: m, markdown: renderMailMarkdown(m) })),
    };
  } finally {
    await client.logout();
  }
}
