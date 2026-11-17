/**
 * browser.js harness — the controlled-browser bridge (Phase 2).
 *
 * Pure-unit: no Edge is launched. Covers the pieces that can silently become a
 * privacy hole (the whitelist gate), the pieces a refactor easily breaks
 * (launch args, port clamping), and the login-wall heuristic the UI depends on.
 *
 * Run: node tests/browser-harness.mjs
 */
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const mod = await import(pathToFileURL(join(root, 'lib', 'browser.js')).href);

let pass = 0;
const ok = (c, l) => { if (!c) throw new Error('FAIL: ' + l); pass++; console.log('PASS', l); };

const { readAllowed, clampPort, findBrowserPath, looksLikeLoginWall, BrowserBridge, DEFAULT_PORT, BROWSER_CANDIDATES } = mod;

// ---- the whitelist gate: silence must never mean "read anything" ----
ok(readAllowed('https://pan.quark.cn/list', ['pan.quark.cn']) === true, 'allows an exact whitelisted host');
ok(readAllowed('https://drive-pc.quark.cn/x', ['quark.cn']) === true, 'allows a subdomain of a whitelisted host');
ok(readAllowed('https://evilquark.cn/x', ['quark.cn']) === false, 'refuses a host that merely shares a suffix (evilquark.cn)');
ok(readAllowed('https://quark.cn.evil.com/x', ['quark.cn']) === false, 'refuses a suffix attack (quark.cn.evil.com)');
ok(readAllowed('https://pan.quark.cn/list', []) === false, 'an EMPTY whitelist refuses everything');
ok(readAllowed('https://pan.quark.cn/list', undefined) === false, 'a missing whitelist refuses everything');
ok(readAllowed('http://pan.quark.cn/list', ['pan.quark.cn']) === false, 'refuses http');
ok(readAllowed('file:///C:/Windows/win.ini', ['pan.quark.cn']) === false, 'refuses file:');
ok(readAllowed('javascript:alert(1)', ['pan.quark.cn']) === false, 'refuses javascript:');
ok(readAllowed('https://user:pw@pan.quark.cn/x', ['pan.quark.cn']) === false, 'refuses credentials embedded in the url');
ok(readAllowed('not a url', ['pan.quark.cn']) === false, 'refuses garbage');
ok(readAllowed(null, ['pan.quark.cn']) === false, 'refuses null');
ok(readAllowed('https://PAN.QUARK.CN/list', ['pan.quark.cn']) === true, 'host matching is case-insensitive');
ok(readAllowed('https://pan.quark.cn/list', [' pan.quark.cn ']) === true, 'whitelist entries are trimmed');

// ---- port clamping (a stray value must not open a privileged port) ----
ok(clampPort(9333) === 9333, 'keeps a normal port');
ok(clampPort('9444') === 9444, 'accepts a numeric string');
ok(clampPort(80) === DEFAULT_PORT, 'refuses a privileged port (<1024)');
ok(clampPort(70000) === DEFAULT_PORT, 'refuses an out-of-range port');
ok(clampPort('abc') === DEFAULT_PORT, 'refuses NaN input');
ok(clampPort(undefined) === DEFAULT_PORT, 'defaults when missing');

// ---- browser discovery ----
ok(BROWSER_CANDIDATES.length >= 5, `knows several browser locations (got ${BROWSER_CANDIDATES.length})`);
ok(findBrowserPath({ DSH_BROWSER_PATH: 'C:\\fake\\chrome.exe' }, () => true) === 'C:\\fake\\chrome.exe', 'DSH_BROWSER_PATH overrides discovery');
ok(findBrowserPath({ DSH_BROWSER_PATH: 'C:\\nope.exe' }, () => false) === '', 'a missing override falls through and yields "" when nothing exists');
ok(findBrowserPath({}, () => false) === '', 'reports no browser instead of guessing a path');

// ---- login-wall heuristic ----
ok(looksLikeLoginWall('打开知乎App 在「我的页」右上角打开扫一扫 验证码登录密码登录 登录/注册') === true, 'detects a 扫码登录 page');
ok(looksLikeLoginWall('Sign in to continue') === true, 'detects an English sign-in wall');
ok(looksLikeLoginWall('请稍候…', 'https://passport.example.com/login') === true, 'a passport url marks a short page as a wall');
ok(looksLikeLoginWall('我的作品 作品数据 播放量 12.3万 粉丝画像 评论管理 最近发布', 'https://creator.douyin.com/creator-micro/content/manage') === false, 'a real creator list is NOT a wall');
ok(looksLikeLoginWall(`${'作品列表 '.repeat(400)}请先登录`, 'https://example.com/x') === true, 'a long page still showing 请先登录 is a wall');
ok(looksLikeLoginWall(`${'这是一篇讲创作经验的长文，里面提到有一次登录不上后台，后来重装了浏览器就好了。'.repeat(40)}`) === false, 'a long article that merely mentions 登录 is not a wall');
ok(looksLikeLoginWall('') === false, 'empty text is not classified as a wall by itself');

// REGRESSION (2026-11-17, real capture): the logged-out 抖音创作者中心 came back
// as 1127 chars because its login box is wrapped in marketing copy. The old
// "length <= 900" guard let it through and ARCHIVED the login page as if it were
// the user's 作品列表. Length must never outvote a login-box phrase.
const MARKETING = '抖音创作者的一站式创作与服务平台 AI 赋能创作者 高效创作投稿及运营 AI 工坊 把好想法变成好玩法 创作灵感 热点榜单 数据参谋 粉丝画像 评论管理 内容分析 我的收藏 任务中心 学会用数据看懂你的作品 播放完成率 互动率 涨粉来源 平均播放时长 流量诊断 官方训练营 新手入门 进阶运营 变现指南 案例拆解 每周更新 随时随地学习 服务市场 剪辑工具 数据分析 版权保护 内容合规 申诉通道 客服中心 帮助文档 我是创作者 我是MCN机构 ';
const LOGIN_BOX = '扫码登录 如何扫码 打开「抖音APP」点击左上角 扫一扫 验证码登录 密码登录 获取验证码 登录 登录即代表同意用户协议和隐私政策';
const DOUYIN_LOGGED_OUT = `${MARKETING.repeat(6)}${LOGIN_BOX}`;
ok(DOUYIN_LOGGED_OUT.length > 900, `the logged-out 抖音 page is long (${DOUYIN_LOGGED_OUT.length} chars) — this is why a length guard failed`);
ok(looksLikeLoginWall(DOUYIN_LOGGED_OUT, 'https://creator.douyin.com/creator-micro/content/manage') === true, 'a LONG logged-out 抖音 page full of marketing copy is STILL a login wall');
ok(looksLikeLoginWall('扫码登录 请用抖音App扫描二维码') === true, 'two login affordances suffice on a short page too');
ok(looksLikeLoginWall('这是一篇讲登录体验的长文，作者抱怨每次登录都很麻烦，登不上去只能重装浏览器。'.repeat(30)) === false, 'prose that merely uses the word 登录 is not a wall');
// Known, accepted trade-off: a page that literally QUOTES login-box UI strings
// ("密码登录"、"验证码登录") is treated as a wall even if it is an article. The
// cost of that false positive is one extra "click again"; the cost of the
// opposite mistake is silently archiving a login page as content.
ok(looksLikeLoginWall('教程：页面上有「密码登录」和「验证码登录」两个页签，点前面的就是密码登录。'.repeat(20)) === true, 'documented trade-off: quoted login-box UI reads as a wall');

// ---- launch args: the profile must be plugin-owned and isolated ----
const bridge = new BrowserBridge('C:\\tmp\\inbox-test', { port: 9444, browserPath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' });
const headlessArgs = bridge.launchArgs({ headless: true });
const headfulArgs = bridge.launchArgs({ headless: false });
ok(headlessArgs[0] === '--headless=new', 'headless puts --headless=new first');
ok(!headfulArgs.some((a) => a.startsWith('--headless')), 'headful has no headless flag');
ok(headlessArgs.some((a) => a === '--remote-debugging-port=9444'), 'debugging port comes from the constructor');
ok(headlessArgs.some((a) => a === '--user-data-dir=C:\\tmp\\inbox-test\\browser-profile'), 'uses the plugin-owned profile dir');
ok(!headlessArgs.some((a) => /user-data-dir=.*AppData\\.*Edge\\User Data/i.test(a)), 'NEVER points at the user\'s daily Edge profile');
ok(bridge.profileDir.endsWith('browser-profile'), 'profileDir lives under the plugin data dir');

const noBrowser = new BrowserBridge('C:\\tmp\\inbox-test', { browserPath: '', port: 59999 });
noBrowser.browserPath = '';
const failed = await noBrowser.ensure({ headless: true, waitMs: 50 });
ok(failed.ok === false && /no Chromium browser found/.test(failed.reason), 'ensure() fails honestly when no browser exists');
const st = await noBrowser.status();
// Port 59999 keeps this deterministic: probing the default 9333 would report
// running:true whenever the user (or a previous run) left a real Edge listening,
// which says nothing about this code path.
ok(st.running === false && st.available === false, 'status() reports not running and not available');

console.log(`\n${pass} checks passed.`);
console.log('BRIDGE VERIFIED: whitelist gate + port clamp + discovery + login-wall + launch args.');
