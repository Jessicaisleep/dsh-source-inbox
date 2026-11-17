/**
 * dsh-source-inbox — Phase 3: WeRead highlights, in-house.
 *
 * The guidance used to say "用 weread-export 带上 Cookie 导出 Markdown".
 * `weread-export` is not installed on this machine and is not an official
 * package — telling the user to go find it is exactly the supply-chain risk the
 * author objected to. So the export lives here: the plugin holds the user's own
 * Cookie (in the credential vault) and calls the same read-only endpoints the
 * weread web app calls, then renders Markdown.
 *
 * SCOPE: only the user's own account, only read endpoints, only highlights and
 * notes they can already see in the web app. Nothing is uploaded anywhere; the
 * Markdown goes into the local knowledge base like any other record.
 */

export const WEREAD_BASE = 'https://weread.qq.com';

/** Headers that make the request look like the web app the Cookie came from. */
function headers(cookie) {
  return {
    cookie: String(cookie ?? '').trim(),
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 dsh-source-inbox',
    accept: 'application/json, text/plain, */*',
    referer: `${WEREAD_BASE}/`,
  };
}

/** A Cookie is only usable if it actually carries the session keys. */
export function looksLikeWereadCookie(cookie) {
  const c = String(cookie ?? '');
  if (!c || c.length < 20) return false;
  return /\b(vr_[a-z_]+|wr_[a-z_]+|wr_vid|wr_skey)\s*=/i.test(c);
}

async function getJSON(url, cookie, opts = {}) {
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'this Node runtime has no fetch' };
  const timeoutMs = Math.max(1000, Math.min(60000, Number(opts.timeoutMs) || 15000));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal, headers: headers(cookie), redirect: 'follow' });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, status: res.status };
    const text = await res.text();
    if (!text.trim()) return { ok: false, reason: '接口返回空响应（Cookie 可能已失效）' };
    try {
      const body = JSON.parse(text);
      // WeRead answers 200 with an error envelope when the session is gone.
      if (body && typeof body === 'object' && body.errcode && body.errcode !== 0) {
        return { ok: false, reason: `接口报错 errcode=${body.errcode}${body.errmsg ? `（${body.errmsg}）` : ''}` };
      }
      return { ok: true, body };
    } catch {
      return { ok: false, reason: '返回的不是 JSON（Cookie 可能已失效，或被要求重新登录）' };
    }
  } catch (e) {
    return { ok: false, reason: ctl.signal.aborted ? `请求超时（${timeoutMs}ms）` : `请求失败：${e?.message ?? e}` };
  } finally {
    clearTimeout(timer);
  }
}

/** The user's shelf: one entry per book they have on it. */
export async function listShelf(cookie, opts = {}) {
  if (!looksLikeWereadCookie(cookie)) {
    return { ok: false, reason: 'Cookie 看起来不完整：需要带 wr_vid / wr_skey 这类会话字段' };
  }
  const r = await getJSON(`${WEREAD_BASE}/web/shelf/sync?synckey=0`, cookie, opts);
  if (!r.ok) return r;
  const books = Array.isArray(r.body?.books) ? r.body.books : [];
  return {
    ok: true,
    books: books.map((b) => ({
      bookId: String(b?.bookId ?? ''),
      title: String(b?.title ?? '').trim(),
      author: String(b?.author ?? '').trim(),
      finished: Number(b?.finishReading ?? 0) === 1,
      updateTime: Number(b?.updateTime ?? 0),
    })).filter((b) => b.bookId && b.title),
  };
}

/** Bookmarks (highlights + notes) for one book. */
export async function listBookmarks(bookId, cookie, opts = {}) {
  const id = String(bookId ?? '').trim();
  if (!id) return { ok: false, reason: '缺少 bookId' };
  const r = await getJSON(`${WEREAD_BASE}/web/book/bookmarklist?bookId=${encodeURIComponent(id)}`, cookie, opts);
  if (!r.ok) return r;
  const updated = Array.isArray(r.body?.updated) ? r.body.updated : [];
  return {
    ok: true,
    marks: updated.map((m) => ({
      chapterUid: Number(m?.chapterUid ?? 0),
      chapterTitle: String(m?.chapterTitle ?? '').trim(),
      markText: String(m?.markText ?? '').trim(),
      createTime: Number(m?.createTime ?? 0),
      style: Number(m?.style ?? 0),
    })).filter((m) => m.markText),
  };
}

/**
 * Render one book's highlights as Markdown with a YAML front-matter block, so
 * a knowledge base can filter by book / author / date without a side table.
 */
export function renderBookMarkdown(book, marks) {
  const title = String(book?.title ?? '未命名').trim();
  const author = String(book?.author ?? '').trim();
  const iso = new Date().toISOString();
  const byChapter = new Map();
  for (const m of marks ?? []) {
    const key = m.chapterTitle || '（未分章）';
    if (!byChapter.has(key)) byChapter.set(key, []);
    byChapter.get(key).push(m);
  }
  const lines = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `author: ${JSON.stringify(author)}`,
    `source: weread`,
    `bookId: ${JSON.stringify(String(book?.bookId ?? ''))}`,
    `highlights: ${(marks ?? []).length}`,
    `exportedAt: ${JSON.stringify(iso)}`,
    '---',
    '',
    `# ${title}`,
    '',
    author ? `- 作者：${author}` : null,
    `- 划线/想法：${(marks ?? []).length} 条`,
    `- 导出时间：${iso}`,
    '',
    '> 由 dsh-source-inbox 按本人账号的登录 Cookie 直接调用官方只读接口导出；仅本地归档。',
    '',
  ].filter(Boolean);
  for (const [chapter, items] of byChapter) {
    lines.push(`## ${chapter}`, '');
    for (const m of items) {
      lines.push(`> ${m.markText.replace(/\n+/g, ' ').trim()}`, '');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/**
 * Full export: shelf -> per-book bookmarks -> one Markdown document per book.
 * `limit` bounds how many books one run touches, so a huge shelf cannot turn a
 * single click into hundreds of requests.
 */
export async function exportHighlights(cookie, opts = {}) {
  const limit = Math.max(1, Math.min(50, Math.trunc(Number(opts.limit) || 10)));
  const shelf = await listShelf(cookie, opts);
  if (!shelf.ok) return shelf;
  const books = shelf.books.slice(0, limit);
  const docs = [];
  const failures = [];
  for (const book of books) {
    const marks = await listBookmarks(book.bookId, cookie, opts);
    if (!marks.ok) { failures.push({ bookId: book.bookId, title: book.title, reason: marks.reason }); continue; }
    if (marks.marks.length === 0) continue;
    docs.push({
      book,
      count: marks.marks.length,
      markdown: renderBookMarkdown(book, marks.marks),
    });
  }
  return { ok: true, scanned: books.length, shelfTotal: shelf.books.length, docs, failures };
}
