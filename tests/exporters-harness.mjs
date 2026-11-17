/**
 * exporters-harness — the three in-house exporters (Phase 3).
 *
 * Why this exists: the panel used to point at `weread-export`, `dsh-cubox` and
 * `dsh-email`. None of those packages is installed anywhere, and a package name
 * printed in guidance is a name someone else can register first. The exports are
 * implemented in lib/ now, so these tests pin the two things a user would feel:
 * a bad credential is refused with words they can act on, and a good response
 * becomes Markdown without silently losing their highlights or mail bodies.
 *
 * Nothing here touches the network: every fetch is injected, and the IMAP paths
 * exercised are the ones that fail before a socket is opened.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const lib = (name) => pathToFileURL(join(here, '..', 'lib', name)).href;

const weread = await import(lib('weread.js'));
const cubox = await import(lib('cubox.js'));
const mail = await import(lib('mailimap.js'));

let pass = 0;
const ok = (c, l) => { if (!c) throw new Error('FAIL: ' + l); pass += 1; console.log('PASS', l); };
const eq = (a, b, l) => ok(a === b, `${l} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

/** A fetch double that answers in order and records what it was asked for. */
function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (typeof next === 'function') return next(url, init);
    return {
      ok: next.ok !== false,
      status: next.status ?? 200,
      headers: { get: () => 'application/json' },
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
    };
  };
  impl.calls = calls;
  return impl;
}

const GOOD_COOKIE = 'wr_vid=123456; wr_skey=abcdefghijklmnop; wr_rt=web%40xyz';

/* ---------------------------------------------------------------- weread */

eq(weread.looksLikeWereadCookie(GOOD_COOKIE), true, 'accepts a cookie carrying wr_vid/wr_skey');
eq(weread.looksLikeWereadCookie('foo=1; bar=2'), false, 'rejects a cookie with no session fields');
eq(weread.looksLikeWereadCookie(''), false, 'rejects an empty cookie');
eq(weread.looksLikeWereadCookie('wr_vid=1'), false, 'rejects a too-short cookie');

const badCookie = await weread.listShelf('nope', { fetchImpl: fakeFetch([]) });
eq(badCookie.ok, false, 'a bad cookie is refused before any request');
ok(/Cookie/.test(badCookie.reason), 'the refusal names the cookie as the problem');

const shelfFetch = fakeFetch([{
  body: { books: [{ bookId: 'b1', title: ' 一本书 ', author: '某人', finishReading: 1 }, { bookId: '', title: '无 id' }] },
}]);
const shelf = await weread.listShelf(GOOD_COOKIE, { fetchImpl: shelfFetch });
eq(shelf.ok, true, 'reads the shelf');
eq(shelf.books.length, 1, 'drops shelf entries without a bookId');
eq(shelf.books[0].title, '一本书', 'trims the title');
eq(shelf.books[0].finished, true, 'maps finishReading=1 to finished');
ok(shelfFetch.calls[0].url.endsWith('/web/shelf/sync?synckey=0'), 'calls the official shelf endpoint');
ok(String(shelfFetch.calls[0].init.headers.cookie).includes('wr_vid'), 'sends the cookie as a cookie header');

const errEnvelope = await weread.listShelf(GOOD_COOKIE, {
  fetchImpl: fakeFetch([{ body: { errcode: -2012, errmsg: '登录超时' } }]),
});
eq(errEnvelope.ok, false, 'a non-zero errcode in a 200 response is a failure');
ok(/errcode=-2012/.test(errEnvelope.reason) && /登录超时/.test(errEnvelope.reason), 'the error carries the server code and message');

const notJson = await weread.listShelf(GOOD_COOKIE, { fetchImpl: fakeFetch([{ body: '<html>login</html>' }]) });
eq(notJson.ok, false, 'a non-JSON answer is a failure (HTML login page)');
ok(/重新登录/.test(notJson.reason), 'the failure suggests logging in again');

const httpFail = await weread.listShelf(GOOD_COOKIE, { fetchImpl: fakeFetch([{ ok: false, status: 503 }]) });
eq(httpFail.ok, false, 'an HTTP failure is reported');
eq(httpFail.status, 503, 'the status is preserved');

eq((await weread.listBookmarks('', GOOD_COOKIE, { fetchImpl: fakeFetch([]) })).ok, false, 'listBookmarks refuses an empty bookId');

const markFetch = fakeFetch([{
  body: {
    updated: [
      { chapterTitle: '第一章', markText: ' 一句划线 ', chapterUid: 1 },
      { chapterTitle: '第一章', markText: '', chapterUid: 1 },
      { chapterTitle: '', markText: '未分章的想法', chapterUid: 0 },
    ],
  },
}]);
const marks = await weread.listBookmarks('b1', GOOD_COOKIE, { fetchImpl: markFetch });
eq(marks.ok, true, 'reads bookmarks');
eq(marks.marks.length, 2, 'drops bookmarks with no text');
eq(marks.marks[0].markText, '一句划线', 'trims the highlight text');

const bookMd = weread.renderBookMarkdown(
  { bookId: 'b1', title: '一本书', author: '某人' },
  [{ chapterTitle: '第一章', markText: '第一句\n换行' }, { chapterTitle: '', markText: '另一条' }],
);
ok(bookMd.startsWith('---\n'), 'the book Markdown starts with YAML front-matter');
ok(bookMd.includes('highlights: 2'), 'the front-matter counts highlights');
ok(bookMd.includes('## 第一章'), 'groups by chapter');
ok(bookMd.includes('## （未分章）'), 'puts unchaptered notes in their own section');
ok(bookMd.includes('> 第一句 换行'), 'collapses newlines inside a highlight (a blockquote cannot span lines)');

// A shelf of 3 books but a limit of 2 must stop at 2 requests' worth of work.
const exportFetch = fakeFetch([
  { body: { books: [{ bookId: 'b1', title: 'A' }, { bookId: 'b2', title: 'B' }, { bookId: 'b3', title: 'C' }] } },
  { body: { updated: [{ chapterTitle: 'x', markText: 'a1' }] } },
  { body: { updated: [{ chapterTitle: 'x', markText: 'b1' }] } },
]);
const exported = await weread.exportHighlights(GOOD_COOKIE, { limit: 2, fetchImpl: exportFetch });
eq(exported.ok, true, 'exportHighlights succeeds');
eq(exported.shelfTotal, 3, 'reports the whole shelf size');
eq(exported.scanned, 2, 'honours the limit');
eq(exported.docs.length, 2, 'returns one document per book with highlights');
eq(exportFetch.calls.length, 3, 'makes exactly 1 shelf call plus 1 call per scanned book');

const failureFetch = fakeFetch([
  { body: { books: [{ bookId: 'b1', title: 'A' }, { bookId: 'b2', title: 'B' }] } },
  { body: { updated: [{ chapterTitle: 'x', markText: 'b1' }] } },
  { ok: false, status: 500 },
]);
const partial = await weread.exportHighlights(GOOD_COOKIE, { limit: 2, fetchImpl: failureFetch });
eq(partial.ok, true, 'a per-book failure does not abort the whole export');
eq(partial.failures.length, 1, 'the failed book is reported');
eq(partial.docs.length, 1, 'the successful book is still exported');
eq(partial.failures[0].bookId, 'b2', 'the failure names the book');

/* ----------------------------------------------------------------- cubox */

eq(cubox.parseCuboxApiUrl('https://cubox.pro/api/v1/cards?key=abc').ok, true, 'accepts a cubox.pro API link');
eq(cubox.parseCuboxApiUrl('https://api.cubox.pro/x').ok, true, 'accepts a cubox.pro subdomain');
ok(/cubox\.pro/.test(cubox.parseCuboxApiUrl('https://evil.example.com/x?key=abc').reason), 'refuses a non-cubox host');
ok(/cubox\.pro/.test(cubox.parseCuboxApiUrl('https://cubox.pro.evil.com/x').reason), 'refuses a cubox.pro suffix trick');
eq(cubox.parseCuboxApiUrl('http://cubox.pro/x').ok, false, 'refuses http');
eq(cubox.parseCuboxApiUrl('https://u:p@cubox.pro/x').ok, false, 'refuses a link carrying credentials');
eq(cubox.parseCuboxApiUrl('nonsense').ok, false, 'refuses a non-URL');

const cardsFetch = fakeFetch([{
  body: {
    code: 200,
    data: [
      { id: 'c1', title: '一条收藏', url: 'https://example.com/a', description: '摘要', content: '正文内容', createTime: 1700000000 },
      { cardId: 'c2', title: '', url: '', description: '', content: '' },
      {},
    ],
  },
}]);
const cards = await cubox.listCards('https://cubox.pro/api/v1/cards?key=abc', { limit: 5 }, { fetchImpl: cardsFetch });
eq(cards.ok, true, 'reads cards');
eq(cards.cards.length, 2, 'drops entries with neither id nor title');
eq(cards.cards[1].id, 'c2', 'accepts cardId as the id');
ok(cardsFetch.calls[0].url.includes('limit=5'), 'passes the limit as a query parameter');

for (const [shape, label] of [
  [{ data: { list: [{ id: 'x', title: 't' }] } }, 'data.list'],
  [{ list: [{ id: 'x', title: 't' }] }, 'list'],
]) {
  const r = await cubox.listCards('https://cubox.pro/api/v1/cards?key=abc', {}, { fetchImpl: fakeFetch([{ body: shape }]) });
  eq(r.cards.length, 1, `accepts the ${label} response shape`);
}

const cuboxErr = await cubox.listCards('https://cubox.pro/x?key=bad', {}, { fetchImpl: fakeFetch([{ body: { code: 401, message: 'invalid key' } }]) });
eq(cuboxErr.ok, false, 'a non-200 code field is a failure');
ok(/401/.test(cuboxErr.reason) && /invalid key/.test(cuboxErr.reason), 'the failure carries code and message');

const cardMd = cubox.renderCardMarkdown({ id: 'c1', title: '标题', url: 'https://example.com/a', description: '摘要', content: '正文', createTime: 1700000000 });
ok(cardMd.includes('source: cubox'), 'the card Markdown declares its source');
ok(cardMd.includes('- 原文：https://example.com/a'), 'keeps the original link');
ok(cardMd.includes('摘要') && cardMd.includes('正文'), 'keeps description and content');
const emptyCard = cubox.renderCardMarkdown({ id: 'c2', url: 'https://example.com/b' });
ok(/没有正文/.test(emptyCard), 'an empty card says so instead of rendering an empty record');
eq(emptyCard.includes('# https://example.com/b'), true, 'an untitled card falls back to its URL as the heading');

const cuboxExport = await cubox.exportCards('https://cubox.pro/api/v1/cards?key=abc', { limit: 2 }, { fetchImpl: fakeFetch([{ body: { data: [{ id: 'c1', title: 'A' }] } }]) });
eq(cuboxExport.ok, true, 'exportCards succeeds');
eq(cuboxExport.count, 1, 'exportCards counts the documents');
ok(cuboxExport.docs[0].markdown.includes('source: cubox'), 'exportCards renders Markdown');

/* ------------------------------------------------------------------ mail */

eq(mail.guessImapHost('a@qq.com'), 'imap.qq.com', 'guesses the qq IMAP host');
eq(mail.guessImapHost('A@Foxmail.com'), 'imap.qq.com', 'matches the host case-insensitively');
eq(mail.guessImapHost('a@163.com'), 'imap.163.com', 'guesses the 163 host');
eq(mail.guessImapHost('a@unknown.tld'), '', 'returns empty for an unknown domain');
eq(mail.guessImapHost('nonsense'), '', 'returns empty for a non-address');
eq(mail.DEFAULT_IMAP_PORT, 993, 'defaults to the implicit-TLS port');

eq(mail.decodeMimeWords('=?utf-8?B?5L2g5aW9?='), '你好', 'decodes a base64 UTF-8 encoded-word');
eq(mail.decodeMimeWords('=?UTF-8?Q?caf=C3=A9?='), 'café', 'decodes a quoted-printable encoded-word');
eq(mail.decodeMimeWords('plain subject'), 'plain subject', 'leaves a plain subject alone');

const multipart = [
  '--BND',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: 8bit',
  '',
  '纯文本正文',
  '--BND',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>HTML <b>正文</b></p>',
  '--BND--',
  '',
].join('\r\n');
// The boundary is case-sensitive: a lowercased copy of the header used to lose
// `BND` -> `bnd` and every multipart body came back empty.
const body = mail.extractReadableBody(multipart, 'multipart/alternative; boundary="BND"');
ok(body.includes('纯文本正文'), 'extracts the text/plain part of a multipart body');
ok(body.includes('HTML 正文') && !body.includes('<b>'), 'reduces the HTML part to text');

const htmlOnly = mail.extractReadableBody('<div><script>x</script>只有正文</div>', 'text/html; charset=utf-8');
eq(htmlOnly, '只有正文', 'a text/html body is reduced to text and the script is dropped');

// Only a body that DECLARES quoted-printable is decoded: running the QP decoder
// over already-decoded UTF-8 turns CJK text into mojibake.
const quoted = mail.extractReadableBody('caf=C3=A9', 'text/plain; charset=utf-8; Content-Transfer-Encoding: quoted-printable');
eq(quoted, 'café', 'decodes a body that declares quoted-printable');
eq(mail.extractReadableBody('只有正文', 'text/plain; charset=utf-8'), '只有正文', 'leaves an undeclared 8-bit body untouched');

const b64 = mail.extractReadableBody(Buffer.from('base64 正文', 'utf8').toString('base64'), 'text/plain; charset=utf-8; transfer-encoding: base64');
eq(b64, 'base64 正文', 'decodes a base64 body');

const attachmentPart = [
  '--BND',
  'Content-Type: text/plain',
  '',
  '正文留下',
  '--BND',
  'Content-Type: application/pdf; name="a.pdf"',
  'Content-Disposition: attachment; filename="a.pdf"',
  '',
  'JVBERi0xLjQK',
  '--BND--',
  '',
].join('\r\n');
const noAttach = mail.extractReadableBody(attachmentPart, 'multipart/mixed; boundary="BND"');
ok(noAttach.includes('正文留下'), 'keeps the text part');
ok(!noAttach.includes('JVBERi0'), 'drops the attachment payload');

// `{12}` is the BYTE length of 正文内容 (4 CJK chars = 12 UTF-8 bytes), which is
// what a real server sends. A parser that slices by character count over-reads.
const fetched = [
  '* 12 FETCH (UID 99 BODY[HEADER.FIELDS (DATE FROM TO SUBJECT MESSAGE-ID CONTENT-TYPE)] {146}\r\n',
  'Subject: =?utf-8?B?5L2g5aW9?=\r\nFrom: a@example.com\r\nTo: b@example.com\r\nDate: Mon, 17 Nov 2026 10:00:00 +0800\r\nMessage-ID: <abc@example.com>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n',
  ' BODY[TEXT] {12}\r\n',
  '正文内容',
  ')\r\n',
].join('');
const parsed = mail.parseFetchResponse(fetched);
eq(parsed.length, 1, 'parses one FETCH message');
eq(parsed[0].subject, '你好', 'decodes the subject encoded-word');
eq(parsed[0].from, 'a@example.com', 'reads the From header');
eq(parsed[0].messageId, 'abc@example.com', 'strips the angle brackets off the Message-ID');
eq(parsed[0].body.trim(), '正文内容', 'reads the literal body by its declared length');

const twoMessages = parsed.length === 1
  ? mail.parseFetchResponse(fetched + fetched.replace(/\* 12 FETCH/, '* 13 FETCH'))
  : [];
eq(twoMessages.length, 2, 'parses two consecutive messages');

const mailMd = mail.renderMailMarkdown({ subject: '主题', from: 'a@example.com', to: 'b@example.com', date: 'Mon', messageId: 'm1', body: '正文' });
ok(mailMd.includes('source: email'), 'the mail Markdown declares its source');
ok(mailMd.includes('BODY.PEEK'), 'the note tells the user the read did not mark the mail as read');
ok(mailMd.includes('正文'), 'keeps the body');
ok(mail.renderMailMarkdown({}).includes('(无主题)'), 'an empty subject is labelled');

// The failure paths that must not open a socket.
eq((await mail.fetchRecentMail({ host: '', user: 'a@b.c', password: 'x' })).ok, false, 'refuses a missing IMAP host');
const noCreds = await mail.fetchRecentMail({ host: 'imap.example.com', user: '', password: '' });
eq(noCreds.ok, false, 'refuses missing credentials');
ok(/授权码/.test(noCreds.reason), 'the refusal explains an app password is required (not the login password)');

const client = new mail.ImapClient({ host: 'imap.example.com' });
eq((await client.login('', 'pw')).ok, false, 'login refuses an empty user');
eq((await client.login('a@b.c', '')).ok, false, 'login refuses an empty password');
await client.logout();
eq(client.socket, null, 'logout on a never-connected client is a no-op');

console.log('\nEXPORTERS VERIFIED: weread shelf/bookmarks + cubox cards + IMAP parse/body/markdown.');
console.log(`${pass} checks passed.`);
