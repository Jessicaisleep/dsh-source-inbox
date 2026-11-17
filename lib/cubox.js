/**
 * dsh-source-inbox — Phase 3: Cubox collection sync, in-house.
 *
 * The guidance used to say "dsh-cubox 定时同步". That package is not installed
 * and naming it hands the user a name to search for — the supply-chain problem
 * the author called out. The sync is implemented here instead: the user pastes
 * their own Cubox API link into the panel, the plugin calls it, and each card
 * becomes a Markdown record in the local knowledge base.
 *
 * SCOPE: the user's own API link only (that link IS the credential). Read-only.
 */

/** Validate the pasted API link before it is ever fetched. */
export function parseCuboxApiUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? '').trim()); } catch { return { ok: false, reason: 'API 链接不是合法 URL' }; }
  if (u.protocol !== 'https:') return { ok: false, reason: 'API 链接必须是 https' };
  if (u.username || u.password) return { ok: false, reason: 'API 链接里不能带账号密码' };
  if (!/(^|\.)cubox\.pro$/i.test(u.hostname)) {
    return { ok: false, reason: `API 链接的域名必须是 cubox.pro（收到 ${u.hostname}）` };
  }
  return { ok: true, url: u.href };
}

function headers(apiUrl) {
  return {
    accept: 'application/json',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 dsh-source-inbox',
    referer: 'https://cubox.pro/',
    // Cubox accepts the key as a query parameter, which is inside the pasted
    // link itself; no extra header is required.
  };
}

async function getJSON(url, opts = {}) {
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'this Node runtime has no fetch' };
  const timeoutMs = Math.max(1000, Math.min(60000, Number(opts.timeoutMs) || 15000));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctl.signal, headers: headers(url), redirect: 'follow' });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, status: res.status };
    const text = await res.text();
    if (!text.trim()) return { ok: false, reason: '接口返回空响应（API 链接可能已失效）' };
    let body;
    try { body = JSON.parse(text); } catch { return { ok: false, reason: '返回的不是 JSON（API 链接可能已失效）' }; }
    if (body && typeof body === 'object' && body.code !== undefined && Number(body.code) !== 200) {
      return { ok: false, reason: `接口返回 code=${body.code}${body.message ? `（${body.message}）` : ''}` };
    }
    return { ok: true, body };
  } catch (e) {
    return { ok: false, reason: ctl.signal.aborted ? `请求超时（${timeoutMs}ms）` : `请求失败：${e?.message ?? e}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull one page of cards. Cubox's public API shape:
 *   { code, data: [ { id, title, description, url, content, createTime, ... } ] }
 * The exact field set has changed over time, so the reader stays defensive and
 * keeps whichever of the known names is present.
 */
export async function listCards(apiUrl, { limit = 20, lastCardId = '' } = {}, opts = {}) {
  const parsed = parseCuboxApiUrl(apiUrl);
  if (!parsed.ok) return parsed;
  const n = Math.max(1, Math.min(50, Math.trunc(Number(limit) || 20)));
  const q = new URL(parsed.url);
  q.searchParams.set('limit', String(n));
  if (lastCardId) q.searchParams.set('lastCardId', String(lastCardId));
  const r = await getJSON(q.href, opts);
  if (!r.ok) return r;
  const list = Array.isArray(r.body?.data) ? r.body.data
    : Array.isArray(r.body?.data?.list) ? r.body.data.list
      : Array.isArray(r.body?.list) ? r.body.list
        : [];
  const cards = list.map((c) => ({
    id: String(c?.id ?? c?.cardId ?? ''),
    title: String(c?.title ?? '').trim(),
    url: String(c?.url ?? c?.targetUrl ?? '').trim(),
    description: String(c?.description ?? c?.desc ?? '').trim(),
    content: String(c?.content ?? c?.markdown ?? '').trim(),
    createTime: Number(c?.createTime ?? 0),
  })).filter((c) => c.id || c.title);
  return { ok: true, cards, raw: cards.length === 0 ? Object.keys(r.body ?? {}) : undefined };
}

/** One card as Markdown, with front-matter so the KB can filter by source. */
export function renderCardMarkdown(card) {
  const title = String(card?.title ?? '').trim() || String(card?.url ?? '').trim() || '未命名收藏';
  const iso = card?.createTime ? new Date(card.createTime * 1000).toISOString() : new Date().toISOString();
  const body = [];
  if (card?.url) body.push(`- 原文：${card.url}`);
  body.push(`- 收藏时间：${iso}`);
  const desc = String(card?.description ?? '').trim();
  const content = String(card?.content ?? '').trim();
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    'source: cubox',
    `url: ${JSON.stringify(String(card?.url ?? ''))}`,
    `savedAt: ${JSON.stringify(iso)}`,
    '---',
    '',
    `# ${title}`,
    '',
    ...body,
    '',
    '> 由 dsh-source-inbox 按本人 Cubox API 链接直接导出；仅本地归档。',
    '',
    desc ? `${desc}\n` : '',
    content || '(这条收藏没有正文，只有标题与链接)',
    '',
  ].filter((line) => line !== '').join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/** Pull up to `limit` cards and render them all. */
export async function exportCards(apiUrl, { limit = 20 } = {}, opts = {}) {
  const r = await listCards(apiUrl, { limit }, opts);
  if (!r.ok) return r;
  return { ok: true, count: r.cards.length, docs: r.cards.map((c) => ({ card: c, markdown: renderCardMarkdown(c) })) };
}
