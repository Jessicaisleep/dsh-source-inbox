/**
 * dsh-source-inbox — Phase 3: in-house link reader.
 *
 * WHY THIS EXISTS (and why it lives here, not in a dependency)
 * The panel used to tell the user "把链接交给 envoy-dsh / dsh-link-parse" and
 * "用 dsh-scrape-webpage / dsh-read-url 取正文". None of those packages exist on
 * the machine — the user was being pointed at names they would have to search
 * for. That is a supply-chain trap: whoever registers `dsh-link-parse` first
 * owns the code that runs with the user's browser data. So the capability is
 * implemented HERE, with node builtins only, and the guidance never names a
 * third-party package again.
 *
 * WHAT IT DOES
 * GET an https URL, decide what it is from the content type, and turn it into
 * Markdown the knowledge base can index:
 *   - text/html  -> isolated main content, HTML reduced to Markdown
 *   - text/markdown | text/plain -> passed through
 *   - application/json -> pretty-printed fenced block
 *
 * SAFETY (this half runs on the host, so it must not become an SSRF hole)
 *   - https only; a URL carrying username/password is refused
 *   - loopback / private / link-local / *.local / *.internal hosts refused
 *   - response size capped, request timeout enforced, redirects followed but
 *     the FINAL url is re-checked against the same rules
 *   - zero dependencies; no HTML parser, no jsdom — a small, predictable reducer
 *
 * NOT A SCRAPER FOR OTHER PEOPLE'S SITES: it reads one page the user names, the
 * same way a browser would. Pages that need a login are handed to the
 * controlled browser (lib/browser.js) instead of being faked here.
 */

export const MAX_BYTES = 5 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 20000;
export const DEFAULT_MAX_CHARS = 60000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 dsh-source-inbox';

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/i,
  /^\[?fc/i,
  /^\[?fd/i,
  /^\[?fe80/i,
  /\.local$/i,
  /\.internal$/i,
  /\.localhost$/i,
];

/** Is this a URL the host may fetch on the user's behalf? */
export function isPublicHttpUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? '').trim()); } catch { return { ok: false, reason: '不是合法的 URL' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: '只接受 https 链接' };
  if (u.username || u.password) return { ok: false, reason: 'URL 里不能带账号密码' };
  const host = u.hostname.toLowerCase();
  if (!host) return { ok: false, reason: '缺少主机名' };
  if (PRIVATE_HOST_PATTERNS.some((re) => re.test(host))) {
    return { ok: false, reason: `拒绝内网/本机地址：${host}` };
  }
  return { ok: true, url: u.href };
}

/* ------------------------------------------------------------------ entities */

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', bull: '•',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®', trade: '™',
  times: '×', divide: '÷', deg: '°', plusmn: '±', laquo: '«', raquo: '»',
  ensp: ' ', emsp: ' ', thinsp: ' ', zwj: '', zwnj: '',
};

export function decodeEntities(input) {
  return String(input ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED, key) ? NAMED[key] : m;
  });
}

/* --------------------------------------------------------- html -> markdown */

const DROP_BLOCKS = ['script', 'style', 'noscript', 'svg', 'canvas', 'iframe', 'form', 'nav', 'footer', 'aside', 'template'];

function stripDropped(html) {
  let out = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of DROP_BLOCKS) {
    out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
    out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '');
  }
  return out;
}

/**
 * Pick the densest plausible content container. Publication pages wrap the
 * article in one of a handful of shapes; falling back to <body> keeps recall
 * high for pages we do not recognise (the cost is navigation boilerplate, not
 * missing content).
 */
function isolateBody(html) {
  const candidates = [
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<div\b[^>]*(?:id|class)\s*=\s*["'][^"']*(?:article|post|content|markdown|rich_media|entry|正文|article-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
  ];
  for (const re of candidates) {
    const m = html.match(re);
    if (m && m[1] && m[1].replace(/<[^>]+>/g, '').trim().length > 120) return m[1];
  }
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return body ? body[1] : html;
}

function resolveUrl(href, base) {
  try { return new URL(href, base).href; } catch { return href; }
}

/**
 * Reduce an HTML fragment to Markdown. Deliberately a sequence of regex
 * replacements over a string: no DOM, no dependency, and every rule is visible
 * in one screen so a wrong rule is easy to spot and test.
 */
export function htmlToMarkdown(html, baseUrl = '') {
  let s = stripDropped(String(html ?? ''));
  s = isolateBody(s);
  // Fenced code first: protect its contents from the inline rules below.
  const fences = [];
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner) => {
    const code = decodeEntities(String(inner).replace(/<[^>]+>/g, '')).replace(/\s+$/, '');
    fences.push(code);
    return `\u0000FENCE${fences.length - 1}\u0000`;
  });
  // Links and images before the generic tag strip.
  s = s.replace(/<a\b[^>]*href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
    const label = decodeEntities(String(text).replace(/<[^>]+>/g, '')).trim();
    if (!label) return '';
    const url = resolveUrl(decodeEntities(href), baseUrl);
    return /^https?:/i.test(url) ? `[${label}](${url})` : label;
  });
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = (tag.match(/src\s*=\s*["']([^"']+)["']/i) ?? [])[1];
    const alt = (tag.match(/alt\s*=\s*["']([^"']*)["']/i) ?? [])[1] ?? '';
    if (!src) return '';
    const url = resolveUrl(decodeEntities(src), baseUrl);
    return /^https?:/i.test(url) ? `![${decodeEntities(alt)}](${url})` : '';
  });
  // Headings.
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, text) => {
    const t = decodeEntities(String(text).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    return t ? `\n\n${'#'.repeat(Number(lvl))} ${t}\n\n` : '\n\n';
  });
  // Lists.
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, text) => {
    const t = decodeEntities(String(text).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    return t ? `\n- ${t}` : '';
  });
  // Blockquotes.
  s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, text) => {
    const t = decodeEntities(String(text).replace(/<[^>]+>/g, '')).trim();
    if (!t) return '';
    return `\n\n${t.split('\n').map((line) => `> ${line.trim()}`).join('\n')}\n\n`;
  });
  // Emphasis and inline code.
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, text) => `**${decodeEntities(String(text).replace(/<[^>]+>/g, '')).trim()}**`);
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, text) => `*${decodeEntities(String(text).replace(/<[^>]+>/g, '')).trim()}*`);
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, text) => `\`${decodeEntities(String(text).replace(/<[^>]+>/g, '')).trim()}\``);
  // Table cells and structural breaks. A cell opens with "| " and a row closes
  // with " |" so the output is a Markdown pipe row instead of bare text with
  // stray separators. `tr` is handled here rather than in the structural list
  // below, otherwise every row would be split by a blank line and no longer
  // read as one table.
  s = s.replace(/<t[dh]\b[^>]*>\s*/gi, '| ');
  s = s.replace(/<\/t[dh]>\s*/gi, ' ');
  s = s.replace(/<\/tr>\s*/gi, '|\n');
  s = s.replace(/<tr\b[^>]*>\s*/gi, '');
  s = s.replace(/<hr\b[^>]*\/?>/gi, '\n\n---\n\n');
  s = s.replace(/<br\b[^>]*\/?>/gi, '\n');
  s = s.replace(/<\/?(p|div|section|table|ul|ol|figure|figcaption|article|main|header)\b[^>]*>/gi, '\n\n');
  // Everything else is a tag to drop.
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\u00a0/g, ' ');
  // Tidy: trim line ends, collapse runs of blank lines, strip leading separators.
  s = s
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s+/, '')
    .replace(/\s+$/, '');
  // Restore fenced code blocks.
  s = s.replace(/\u0000FENCE(\d+)\u0000/g, (_m, i) => {
    const code = fences[Number(i)] ?? '';
    const longest = Math.max(3, ...(code.match(/`+/g) ?? ['']).map((run) => run.length + 1));
    const fence = '`'.repeat(longest);
    return `\n\n${fence}\n${code}\n${fence}\n\n`;
  });
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

export function extractTitle(html) {
  const s = String(html ?? '');
  const og = s.match(/<meta\b[^>]*property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']*)["']/i)
    ?? s.match(/<meta\b[^>]*content\s*=\s*["']([^"']*)["'][^>]*property\s*=\s*["']og:title["']/i);
  if (og && og[1].trim()) return decodeEntities(og[1]).trim();
  const t = s.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (t && t[1].trim()) return decodeEntities(t[1]).replace(/\s+/g, ' ').trim();
  return '';
}

/* ---------------------------------------------------------------- fetching */

function clip(text, maxChars) {
  const limit = Math.max(500, Math.min(200000, Math.trunc(Number(maxChars) || DEFAULT_MAX_CHARS)));
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}\n…[truncated at ${limit} chars]`, truncated: true };
}

/**
 * Fetch one URL and return Markdown.
 *
 * `fetchImpl` exists so tests can drive the reducer without the network; the
 * default is the global fetch that Node 22+ ships.
 */
export async function fetchDocument(rawUrl, opts = {}) {
  const check = isPublicHttpUrl(rawUrl);
  if (!check.ok) return { ok: false, reason: check.reason, url: String(rawUrl ?? '') };

  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'this Node runtime has no fetch', url: check.url };

  const timeoutMs = Math.max(1000, Math.min(120000, Number(opts.timeoutMs) || FETCH_TIMEOUT_MS));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(check.url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/markdown,text/plain,application/json;q=0.8,*/*;q=0.5' },
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = ctl.signal.aborted;
    return { ok: false, reason: aborted ? `请求超时（${timeoutMs}ms）` : `抓取失败：${e?.message ?? e}`, url: check.url };
  }

  try {
    const finalUrl = String(res.url || check.url);
    if (finalUrl !== check.url) {
      const again = isPublicHttpUrl(finalUrl);
      if (!again.ok) return { ok: false, reason: `重定向到不被允许的地址（${again.reason}）`, url: finalUrl };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, reason: `HTTP ${res.status} ${res.statusText ?? ''}`.trim(), url: finalUrl };
    }
    const type = String(res.headers?.get?.('content-type') ?? '').toLowerCase();
    const declared = Number(res.headers?.get?.('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      return { ok: false, reason: `内容太大（${declared} 字节，上限 ${MAX_BYTES}）`, url: finalUrl };
    }
    const raw = await res.text();
    if (raw.length > MAX_BYTES) {
      return { ok: false, reason: `内容太大（超过 ${MAX_BYTES} 字节）`, url: finalUrl };
    }

    let title = '';
    let markdown = '';
    if (/json/.test(type)) {
      let pretty = raw;
      try { pretty = JSON.stringify(JSON.parse(raw), null, 2); } catch { /* keep raw */ }
      markdown = `\`\`\`json\n${pretty}\n\`\`\``;
      title = finalUrl;
    } else if (/markdown|x-markdown/.test(type)) {
      markdown = raw.trim();
      title = (raw.match(/^#\s+(.+)$/m) ?? [])[1]?.trim() ?? '';
    } else if (/text\/plain/.test(type)) {
      markdown = raw.trim();
      title = finalUrl;
    } else if (/html|xml/.test(type) || /^\s*</.test(raw)) {
      title = extractTitle(raw);
      markdown = htmlToMarkdown(raw, finalUrl);
    } else {
      markdown = raw.trim();
      title = finalUrl;
    }

    if (!markdown.trim()) {
      return { ok: false, reason: '页面没有可提取的正文（可能整页需要登录，或内容由脚本渲染）', url: finalUrl, title };
    }
    const clipped = clip(markdown, opts.maxChars);
    return {
      ok: true,
      url: finalUrl,
      requestedUrl: check.url,
      title: title || finalUrl,
      contentType: type,
      chars: clipped.text.length,
      fullChars: markdown.length,
      truncated: clipped.truncated,
      markdown: clipped.text,
    };
  } catch (e) {
    return { ok: false, reason: `读取失败：${e?.message ?? e}`, url: check.url };
  } finally {
    clearTimeout(timer);
  }
}

/** A file-name-safe slug for the archive title. */
export function slugFromTitle(title, fallback = 'document') {
  const base = String(title ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const s = base.slice(0, 80).trim();
  return s || fallback;
}
