/**
 * fetchdoc-harness — the in-house link-to-Markdown reader (Phase 3).
 *
 * Why this exists: the panel used to tell the user "交给 envoy-dsh /
 * dsh-link-parse". Those packages are not installed anywhere on this machine,
 * and a name printed in guidance is a name someone else can register. The
 * reading is now done here, so these tests police the two things that matter:
 * it refuses everything it should refuse, and it turns real HTML into Markdown
 * without inventing or dropping text.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const LIB = pathToFileURL(join(here, '..', 'lib', 'fetchdoc.js')).href;
const {
  isPublicHttpUrl, decodeEntities, htmlToMarkdown, extractTitle, fetchDocument,
  slugFromTitle, MAX_BYTES, DEFAULT_MAX_CHARS,
} = await import(LIB);

let pass = 0;
const ok = (c, l) => { if (!c) throw new Error('FAIL: ' + l); pass += 1; console.log('PASS', l); };
const eq = (a, b, l) => ok(a === b, `${l} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

/* --------------------------------------------------------- host whitelist */

// Only https, never a credential inside the URL, never a loopback/private host.
// A reader that will fetch any URL is an SSRF gadget, so each refusal matters.
eq(isPublicHttpUrl('https://example.com/a').ok, true, 'accepts a plain https page');
eq(isPublicHttpUrl('https://sub.example.com/a?b=1#c').ok, true, 'accepts a subdomain with query and hash');
eq(isPublicHttpUrl('http://example.com').ok, false, 'refuses http');
ok(/https/.test(isPublicHttpUrl('http://example.com').reason), 'http refusal explains https is required');
eq(isPublicHttpUrl('file:///C:/Windows/win.ini').ok, false, 'refuses file:');
eq(isPublicHttpUrl('javascript:alert(1)').ok, false, 'refuses javascript:');
eq(isPublicHttpUrl('https://user:pw@example.com/x').ok, false, 'refuses a URL carrying credentials');
eq(isPublicHttpUrl('not a url').ok, false, 'refuses a non-URL');
eq(isPublicHttpUrl('').ok, false, 'refuses an empty string');
eq(isPublicHttpUrl(null).ok, false, 'refuses null');
for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254', '0.0.0.0', 'svc.internal', 'nas.local', '[::1]']) {
  const r = isPublicHttpUrl(`https://${host}/x`);
  eq(r.ok, false, `refuses the private host ${host}`);
}
eq(isPublicHttpUrl('https://172.15.0.1/x').ok, true, '172.15 is public even though 172.16-31 is not');
eq(isPublicHttpUrl('https://172.32.0.1/x').ok, true, '172.32 is public');
// Case-insensitive scheme, but the host check must not be fooled by it.
eq(isPublicHttpUrl('HTTPS://Example.com/x').ok, true, 'accepts an upper-case scheme');

/* -------------------------------------------------------------- entities */

eq(decodeEntities('a&amp;b'), 'a&b', 'decodes the named amp entity');
eq(decodeEntities('&lt;p&gt;'), '<p>', 'decodes angle brackets');
// nbsp becomes a plain space on purpose: a U+00A0 in the middle of Chinese text
// breaks search and copy-paste, and Markdown treats it as a hard space anyway.
eq(decodeEntities('&nbsp;x'), ' x', 'decodes a non-breaking space to a plain space');
eq(decodeEntities('&#65;&#x42;'), 'AB', 'decodes decimal and hex numeric entities');
eq(decodeEntities('plain'), 'plain', 'leaves text without entities alone');

/* ------------------------------------------------------------- converter */

const page = [
  '<html><head><title>页面标题 | 站点</title>',
  '<meta property="og:title" content="分享标题"></head><body>',
  '<nav>导航栏不要</nav>',
  '<script>var evil = 1;</script><style>.a{}</style>',
  '<article>',
  '<h1>第一章</h1>',
  '<p>普通段落，<strong>加粗</strong> 与 <em>斜体</em>。</p>',
  '<p>链接：<a href="/relative/path">相对地址</a>，外链 <a href="https://other.example.com/x">外链</a>。</p>',
  '<ul><li>项目一</li><li>项目二</li></ul>',
  '<blockquote>引用一句</blockquote>',
  '<pre><code>const s = "```";</code></pre>',
  '<table><tr><th>表头A</th><th>表头B</th></tr><tr><td>1</td><td>2</td></tr></table>',
  '<img src="/pic.png" alt="图片说明">',
  '</article>',
  '<footer>页脚不要</footer>',
  '</body></html>',
].join('');

const md = htmlToMarkdown(page, 'https://example.com/post/1');
ok(md.includes('# 第一章'), 'renders a heading');
ok(md.includes('**加粗**') && md.includes('*斜体*'), 'renders strong and em');
ok(/\[相对地址\]\(https:\/\/example\.com\/relative\/path\)/.test(md), 'resolves a relative href against the page URL');
ok(/\[外链\]\(https:\/\/other\.example\.com\/x\)/.test(md), 'keeps an absolute href as-is');
ok(md.includes('- 项目一') && md.includes('- 项目二'), 'renders list items');
ok(md.includes('> 引用一句'), 'renders a blockquote');
ok(/!\[图片说明\]\(https:\/\/example\.com\/pic\.png\)/.test(md), 'renders an image with alt text and an absolute src');
ok(md.includes('| 表头A | 表头B |'), 'renders table cells separated by pipes');
ok(!md.includes('导航栏不要'), 'drops the nav block');
ok(!md.includes('页脚不要'), 'drops the footer block');
ok(!md.includes('var evil'), 'drops the script body');
ok(!md.includes('.a{}'), 'drops the style body');
// A fenced block whose own content contains ``` must get a LONGER fence,
// otherwise the Markdown is corrupt at the exact place the user wanted code.
ok(/````/.test(md) && md.includes('const s = "```";'), 'lengthens the fence when the code itself contains backticks');
eq(md.endsWith('\n\n'), false, 'does not end with trailing blank lines');

eq(extractTitle(page), '分享标题', 'prefers og:title over <title>');
eq(extractTitle('<html><head><title>只有标题</title></head></html>'), '只有标题', 'falls back to <title>');
eq(extractTitle('<html><body><h1>无头</h1></body></html>'), '', 'returns empty when there is no title');
eq(extractTitle('<meta content="反序属性" property="og:title">'), '反序属性', 'reads og:title with the attributes reversed');

// Body isolation: a page with a real article and a lot of chrome must yield the
// article, not the sidebar. 120 chars is the threshold in isolateBody.
const noisy = '<html><body><div class="sidebar">' + '侧栏噪声'.repeat(200) + '</div>'
  + '<div class="article-content"><p>' + '这是正文。'.repeat(60) + '</p></div></body></html>';
const noisyMd = htmlToMarkdown(noisy, 'https://example.com/x');
ok(noisyMd.includes('这是正文'), 'keeps the article body');
ok(!noisyMd.includes('侧栏噪声'), 'prefers the article container over the sidebar');

eq(slugFromTitle('a/b:c*d?"e"<f>|g'), 'a b c d e f g', 'strips path-hostile characters from a slug');
eq(slugFromTitle(''), 'document', 'falls back to "document" for an empty title');

/* --------------------------------------------------------------- fetch */

const HTML = '<html><head><title>抓到的标题</title></head><body><article><p>正文内容足够长，用来通过空正文检查。' + '补充'.repeat(40) + '</p></article></body></html>';
const fakeOk = (body, contentType = 'text/html; charset=utf-8', extra = {}) => async () => ({
  ok: true, status: 200, url: 'https://example.com/final',
  headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
  text: async () => body, ...extra,
});

const got = await fetchDocument('https://example.com/a', { fetchImpl: fakeOk(HTML) });
eq(got.ok, true, 'fetchDocument returns ok for a normal page');
eq(got.title, '抓到的标题', 'fetchDocument extracts the title');
ok(got.markdown.includes('正文内容足够长'), 'fetchDocument returns Markdown');
eq(got.truncated, false, 'a short page is not marked truncated');

const refusal = await fetchDocument('http://example.com/a', { fetchImpl: fakeOk(HTML) });
eq(refusal.ok, false, 'fetchDocument refuses http BEFORE making a request');
ok(/https/.test(refusal.reason), 'the refusal says https is required');

const tooBig = await fetchDocument('https://example.com/a', {
  fetchImpl: async () => ({
    ok: true, status: 200, url: 'https://example.com/a',
    headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(MAX_BYTES + 1) : 'text/html') },
    text: async () => HTML,
  }),
});
eq(tooBig.ok, false, 'a content-length above the cap is refused');

const http500 = await fetchDocument('https://example.com/a', {
  fetchImpl: async () => ({ ok: false, status: 500, url: 'https://example.com/a', headers: { get: () => null }, text: async () => '' }),
});
eq(http500.ok, false, 'a 5xx is reported as a failure, not as empty content');
eq(http500.status, 500, 'the failure carries the status code');

// A redirect is the classic SSRF bypass: the first URL is public, the target is
// not. The final URL has to pass the same gate.
const redirectToPrivate = await fetchDocument('https://example.com/a', {
  fetchImpl: async () => ({
    ok: true, status: 200, url: 'https://127.0.0.1/admin',
    headers: { get: () => 'text/html' }, text: async () => HTML,
  }),
});
eq(redirectToPrivate.ok, false, 'refuses a redirect that lands on a private host');

const emptyPage = await fetchDocument('https://example.com/a', { fetchImpl: fakeOk('<html><body>   </body></html>') });
eq(emptyPage.ok, false, 'an empty body is a failure, not an empty record');
ok(/正文/.test(emptyPage.reason), 'the empty-body reason mentions the missing body');

const jsonBody = await fetchDocument('https://api.example.com/x', { fetchImpl: fakeOk('{"a":1}', 'application/json') });
eq(jsonBody.ok, true, 'accepts a JSON response');
ok(jsonBody.markdown.includes('"a": 1'), 'pretty-prints JSON into a fenced block');

const plainBody = await fetchDocument('https://example.com/x.txt', { fetchImpl: fakeOk('纯文本内容', 'text/plain') });
eq(plainBody.ok, true, 'accepts a text/plain response');
ok(plainBody.markdown.includes('纯文本内容'), 'keeps plain text verbatim');

// clip() floors the cap at 500, so the body has to be longer than that for the
// truncation path to be exercisable at all.
const LONG = '<html><body><article><p>' + '长正文片段。'.repeat(300) + '</p></article></body></html>';
const capped = await fetchDocument('https://example.com/long', { fetchImpl: fakeOk(LONG), maxChars: 500 });
eq(capped.truncated, true, 'a maxChars below the body length marks the result truncated');
// chars is the length of what the caller receives, which includes the marker
// clip() appends, so the cap is a body cap rather than a total cap.
ok(capped.markdown.includes('[truncated at 500 chars]'), 'the clipped body says where it was cut');
ok(capped.chars <= 500 + 40, 'truncated markdown stays within the cap plus its marker');
ok(capped.fullChars > capped.chars, 'the full length is reported alongside the clipped one');
eq(DEFAULT_MAX_CHARS, 60000, 'the default cap is the documented 60000');

const throwing = await fetchDocument('https://example.com/a', { fetchImpl: async () => { throw new Error('boom'); } });
eq(throwing.ok, false, 'a throwing fetch is reported, not propagated');
ok(/boom/.test(throwing.reason), 'the failure keeps the underlying message');

console.log(`\nFETCHDOC VERIFIED: URL gate + entity decode + HTML->Markdown + fetch guards.`);
console.log(`${pass} checks passed.`);
