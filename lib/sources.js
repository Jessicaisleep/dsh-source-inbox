/**
 * Source registry for the status / guidance panel (§4.1 four-tier ladder, §6
 * source list). This is descriptive metadata + user-facing guidance only.
 * Phase 0 does NOT fetch from any platform: authorization, scraping and any
 * existing on-disk storage stay owned by the source plugins we will reuse in
 * later phases (§5). Nothing here reads a local chat database.
 *
 * `auth` + `links` (Phase 2) make every registry row actionable: the panel
 * renders one button per link that opens the OFFICIAL login / authorization /
 * export page. The plugin itself never collects a password and never stores a
 * token; `links` are absolute https URLs only, and a row with no web entry says
 * so instead of inventing one.
 *
 * `steps` (Phase 2.1) is the answer to "登录完之后呢?" — an ordered list of what
 * to click, WHAT YOU GET, and WHERE TO PUT IT. A button without steps is a dead
 * end, which is exactly what the first version shipped.
 *
 * `reads` (Phase 2.2) is what makes L2 more than a link: a page the plugin may
 * open in its OWN controlled browser profile and read as the logged-in user
 * (lib/browser.js). `hosts` is the whitelist — an empty list means "never read
 * this", and a page is only readable when its host matches. This is not a
 * general-purpose scraper: it reads the user's own account pages, nothing else.
 *
 * `action` (Phase 3) is the button for a capability implemented IN THIS PLUGIN.
 * The earlier guidance told the user to install envoy-dsh / dsh-link-parse /
 * weread-export / dsh-cubox / dsh-email — packages that are not installed and
 * whose names anyone could register. Naming them is a supply-chain invitation,
 * so the capability now lives here and the row carries a button instead of a
 * "go find this package" sentence.
 */

export const LADDER = Object.freeze([
  { tier: 'L0', label: '官方 MCP / API', hint: 'Official API or MCP available — prefer automatic pull.' },
  { tier: 'L1', label: '受限官方 API', hint: 'Official API exists but is limited (scope / verified account).' },
  { tier: 'L2', label: '网页登录态读取', hint: 'No usable API — reuse an existing logged-in browser session to read your own account.' },
  { tier: 'L3', label: '导出 / 分享 / 剪藏', hint: 'Last resort — guide the user to the platform official export / share, then import.' },
  { tier: 'BAN', label: '禁止', hint: 'No compliant automatic path — never decrypt a local chat database.' },
]);

/**
 * How the user authorizes this source. Drives the button caption in the panel:
 *  oauth  -> 第三方 OAuth / 集成授权页
 *  token  -> 手工取 Token / API Key 的控制台页
 *  login  -> 官方网页登录页（登录后由 L2 登录态读取）
 *  export -> 官方导出 / 分享 / 下载页
 *  local  -> 本地目录或本地工具，没有网页登录入口
 */
export const AUTH_KINDS = Object.freeze(['oauth', 'token', 'login', 'export', 'local']);

export const AUTH_LABELS = Object.freeze({
  oauth: '授权登录',
  token: '获取凭据',
  login: '网页登录',
  export: '官方导出',
  local: '本地通道',
});

const link = (label, url) => Object.freeze({ label, url });
/** One step: what to do; optionally what it yields and where that value goes. */
const step = (doing, get, where) => Object.freeze({
  doing,
  ...(get ? { get } : {}),
  ...(where ? { where } : {}),
});
/**
 * One credential the user has to obtain. `secret` fields are typed into a
 * password box and never echoed back (lib/credentials.js masks them).
 */
const field = (key, label, help, opts = {}) => Object.freeze({
  key, label, help,
  secret: opts.secret !== false,
  required: opts.required !== false,
});
/**
 * A paste-and-save box for one source. `file` is a BARE file name inside the
 * vault dir — the registry names it, the user never types a path. That is the
 * whole point: the old guidance said "填到：<secrets-dir>\feishu.json", which
 * silently demanded that the user create a file and guess the JSON keys.
 */
const credential = (file, note, fields) => Object.freeze({
  file,
  note,
  fields: Object.freeze(fields),
});
const readTarget = (label, url, hosts, scrollSteps = 0) => Object.freeze({
  label, url, hosts: Object.freeze(hosts), scrollSteps,
});
/**
 * A capability button for something THIS PLUGIN does.
 *
 * `kind` picks the host route the panel calls:
 *   'fetch'  -> POST /fetch/url       (paste a link, get Markdown)
 *   'weread' -> POST /export/weread   (highlights from the saved Cookie)
 *   'cubox'  -> POST /export/cubox    (cards from the saved API link)
 *   'mail'   -> POST /export/mail     (newest mail over IMAP)
 * `input` is 'url' when the button needs a link typed in first, else ''.
 * `credential` is the vault field that must be saved before it can run.
 */
const action = (kind, label, note, opts = {}) => Object.freeze({
  kind,
  label,
  note,
  input: opts.input ?? '',
  credential: opts.credential ?? '',
});
/** Kinds the panel knows how to render; anything else is ignored, not crashed on. */
export const ACTION_KINDS = Object.freeze(['fetch', 'weread', 'cubox', 'mail']);
const freezeSource = (s) => Object.freeze({
  ...s,
  links: Object.freeze(s.links ?? []),
  steps: Object.freeze(s.steps ?? []),
  reads: Object.freeze(s.reads ?? []),
  actions: Object.freeze(s.actions ?? []),
  ...(s.credential ? { credential: Object.freeze({ ...s.credential, fields: Object.freeze(s.credential.fields) }) } : {}),
});

/**
 * tier: ladder level; delivery: one of the three §5 shapes
 * (file-producing | tool-returning | context-injecting).
 * auth / links / steps / reads: see the header comment above.
 */
export const SOURCES = Object.freeze([
  // A. Documents / knowledge bases (text track)
  {
    id: 'feishu', label: '飞书云文档 / 知识库 / 多维表格 / 云盘', group: 'A', tier: 'L0', delivery: 'tool-returning', auth: 'token',
    links: [link('飞书开放平台 · 开发者后台', 'https://open.feishu.cn/app'), link('飞书网页版', 'https://www.feishu.cn')],
    guide: '应用身份（App ID/Secret）或用户身份（user_access_token）调开放平台 API，凭据存在下面的输入框里。',
    steps: [
      step('点「飞书开放平台 · 开发者后台」，用飞书账号登录 →「创建企业自建应用」，填名称和图标提交。'),
      step('进应用详情 →「权限管理」，搜索并勾选要读的权限：docx:document:readonly、drive:drive:readonly、wiki:wiki:readonly、bitable:app:readonly，点「批量开通」。'),
      step('「凭证与基础信息」里复制 App ID 和 App Secret。', 'App ID / App Secret', '下方输入框 → 点保存，自动写进 _secrets\\feishu.json'),
      step('「版本管理与发布」创建版本并申请发布 —— 管理员审核通过前，接口一律报 permission denied（这一步最容易漏）。'),
      step('要「以我本人身份」读（而不是应用身份）时，改用用户授权拿 user_access_token；两者权限范围不同，应用身份读不到私有云文档。'),
    ],
    credential: credential('feishu.json', '粘贴后由插件写入本地 _secrets 目录，界面上只回显打码预览，不会出现在任何接口响应或日志里。', [
      field('appId', 'App ID', '应用凭证页的 app_id，形如 cli_a1b2c3d4'),
      field('appSecret', 'App Secret', '同一页的 app_secret，只显示在开发者后台'),
      field('userAccessToken', 'user_access_token（可选）', '要「以本人身份」读私有文档时才需要；用应用身份可留空', { required: false }),
    ]),
  },
  {
    id: 'qqdocs', label: '腾讯文档', group: 'A', tier: 'L0', delivery: 'tool-returning', auth: 'token',
    links: [link('腾讯文档 · 获取 MCP Token', 'https://docs.qq.com/open/auth/mcp.html'), link('腾讯文档', 'https://docs.qq.com')],
    guide: '官方 MCP https://docs.qq.com/openapi/mcp （个人 Token，Header 必须带 Authorization）。',
    steps: [
      step('点「获取 MCP Token」页，用 QQ / 微信登录腾讯文档。'),
      step('进入腾讯文档工作台 → 右上角 ≡（或头像菜单）→「使用 MCP」→「获取 MCP token」→ 复制。', 'MCP Token（有效期 1 年）', '下方输入框 → 点保存，自动写进 _secrets\\qqdocs.json'),
      step('调用端点 https://docs.qq.com/openapi/mcp，HTTP 头写 `Authorization: <token>`（注意不是 Bearer 前缀）。'),
      step('报 400007 = 账号不是超级会员（Token 页会提示开通）；报 400006 = Token 写错或已过期。'),
    ],
    credential: credential('qqdocs.json', '腾讯文档个人 Token；插件只把它写进本地 _secrets，界面上只显示打码预览。', [
      field('token', 'MCP Token', '「使用 MCP」页里那串 token，有效期一年'),
    ]),
  },
  {
    id: 'quark', label: '夸克网盘', group: 'A', tier: 'L0', delivery: 'tool-returning', auth: 'login',
    links: [link('夸克网盘登录', 'https://pan.quark.cn')],
    guide: '本机已装官方 Skill quarkclouddrive（上传/下载/搜索/分享/转存），登录一次后由它调官方接口。',
    steps: [
      step('点「夸克网盘登录」，用手机 App 扫码或账号登录。'),
      step('登录后回到会话里直接说「用夸克网盘列一下我的文件」—— quarkclouddrive Skill 会走官方接口，不需要本插件抓页面。'),
      step('要让本插件自己读目录时，点这一行的「让插件自己读」：弹出的是插件专用的独立浏览器窗口，登录态只存在插件自己的 profile 里，不动你的日常浏览器。'),
    ],
    reads: [readTarget('夸克网盘 · 我的文件', 'https://pan.quark.cn/list', ['pan.quark.cn'])],
  },
  {
    id: 'yuque', label: '语雀', group: 'A', tier: 'L3', delivery: 'file-producing', auth: 'export',
    links: [link('语雀登录', 'https://www.yuque.com/login')],
    guide: '官方「导出 Markdown」拿 zip，拖进投放区或填进导入向导；不需要装任何额外工具。',
    steps: [
      step('点「语雀登录」登录。'),
      step('打开要导出的知识库 →「设置」→「导出」→ 选 Markdown → 下载 zip。', 'Markdown zip（含图片附件）', '投放区目录，或导入向导的绝对路径'),
      step('知识库多时逐个导出即可；单个文档也可以复制链接，用「贴链接转 Markdown」直接抓正文。'),
    ],
    actions: [
      action('fetch', '贴链接转 Markdown', '贴一条语雀文档链接，插件自己抓正文并归档。', { input: 'url' }),
    ],
  },
  {
    id: 'notion', label: 'Notion', group: 'A', tier: 'L0', delivery: 'tool-returning', auth: 'oauth',
    links: [link('Notion 集成授权页', 'https://www.notion.so/profile/integrations'), link('Notion 登录', 'https://www.notion.so/login')],
    guide: 'Notion 官方 MCP + OAuth PKCE；或自建 integration 拿 Internal Secret 直连 API。',
    steps: [
      step('点「Notion 集成授权页」登录 →「New integration」，填名称、选要授权的 workspace → 保存。'),
      step('在该页「Internal Integration Secret」复制密钥（只显示一次）。', 'Integration Secret', '下方输入框 → 点保存，自动写进 _secrets\\notion.json'),
      step('回到 Notion 打开目标页面 → 右上「⋯」→「Connections」→ 添加刚建的 integration。不做这一步，API 读到的永远是空列表。'),
      step('或用官方 MCP https://mcp.notion.com/mcp，走 OAuth PKCE 授权页，不需要手工 secret。'),
    ],
    credential: credential('notion.json', 'Internal Integration Secret 只显示一次；存本地，界面上只回显打码预览。', [
      field('secret', 'Integration Secret', '形如 ntn_… 或 secret_…；只显示一次，没存到就得重建'),
      field('workspace', 'Workspace（可选）', '记一下这个集成属于哪个 workspace，便于日后辨认', { secret: false, required: false }),
    ]),
  },
  {
    id: 'obsidian', label: 'Obsidian 本地库', group: 'A', tier: 'L0', delivery: 'file-producing', auth: 'local', links: [],
    guide: '直接指向本地 vault 目录做目录观察者 / 导入（无需任何网页登录）。',
    steps: [
      step('准备 vault 的绝对路径（例如 D:\\Notes\\vault），这里没有网页可登录。'),
      step('在「自动源适配器」把观察目录指到该 vault，或直接把目录填进导入向导；只索引 .md 与附件。'),
    ],
  },
  {
    id: 'baidu-netdisk', label: '百度网盘 / 微云', group: 'A', tier: 'L0', delivery: 'tool-returning', auth: 'oauth',
    links: [link('百度网盘开放平台', 'https://pan.baidu.com/union')],
    guide: '官方开放接口（OpenAPI）+ 授权码模式换 AccessToken；部分权限需应用审核。',
    steps: [
      step('点「百度网盘开放平台」，用百度账号登录。'),
      step('「控制台」→「创建应用」→ 选网盘 → 填应用名提交（个人开发者可建，部分权限要审核）。'),
      step('复制 AppKey / SecretKey。', 'AppKey / SecretKey', '下方输入框 → 点保存，自动写进 _secrets\\baidu-netdisk.json'),
      step('用授权码模式换 AccessToken（redirect_uri 必须与后台登记一致），再调 /rest/2.0/xpan/file?method=list 列文件。'),
    ],
    credential: credential('baidu-netdisk.json', '开放平台应用的 AppKey / SecretKey，存本地；AccessToken 由后续授权流程换取，不在这里填。', [
      field('appKey', 'AppKey', '控制台 → 应用详情里的 API Key'),
      field('secretKey', 'SecretKey', '同一页的 Secret Key'),
    ]),
  },

  // B. Reading / highlights / read-later (text track)
  {
    id: 'weread', label: '微信读书划线 / 想法', group: 'B', tier: 'L3', delivery: 'file-producing', auth: 'export',
    links: [link('微信读书网页版登录', 'https://weread.qq.com')],
    guide: '插件按 Cookie 直连官方阅读接口，把划线/想法导成 Markdown（含 front-matter），不需要额外工具。',
    steps: [
      step('点「微信读书网页版登录」，用微信扫码登录。'),
      step('打开浏览器开发者工具 → Network → 任一 weread 请求 → 复制 Cookie（只存本地 _secrets，不外发）。', '登录 Cookie', '下方输入框 → 点保存，自动写进 _secrets\\weread.json'),
      step('保存后点这一行的「导出划线」——插件自己按 Cookie 请求官方接口并生成 Markdown，归档进知识库。', 'Markdown 记录', '自动归档，无需再导'),
    ],
    credential: credential('weread.json', '登录 Cookie 等同登录态，只写本地；界面上只回显长度，不回显内容。', [
      field('cookie', '登录 Cookie', 'Network 面板里 Copy as cURL 后取 Cookie 头，或直接复制 Cookie 请求头的值'),
    ]),
    actions: [
      action('weread', '导出划线', '插件自己按保存的 Cookie 调微信读书官方接口，把划线导成 Markdown 归档。', { credential: 'cookie' }),
    ],
  },
  {
    id: 'cubox', label: 'Cubox 收藏', group: 'B', tier: 'L2', delivery: 'file-producing', auth: 'login',
    links: [link('Cubox 登录', 'https://cubox.pro')],
    guide: '插件按 API 链接直接拉收藏，每条转 Markdown 归档；也可由本插件直接读收藏页。',
    steps: [
      step('点「Cubox 登录」登录。'),
      step('「设置」→「扩展与 API」里复制 API 链接（形如 https://cubox.pro/c/api/…）。', 'API 链接', '下方输入框 → 点保存，自动写进 _secrets\\cubox.json'),
      step('保存后点「同步收藏」——插件自己调该 API 拉取并转 Markdown；想立刻看页面内容就点「让插件自己读」。'),
    ],
    credential: credential('cubox.json', 'Cubox 的 API 链接本身就是凭据（带 key），存本地，界面只回显前 4 位。', [
      field('apiUrl', 'API 链接', '形如 https://cubox.pro/c/api/xxx，整条粘贴'),
    ]),
    reads: [readTarget('Cubox · 我的收藏', 'https://cubox.pro/my/card', ['cubox.pro'], 2)],
    actions: [
      action('cubox', '同步收藏', '插件自己按保存的 API 链接拉取最新收藏并逐条转 Markdown。', { credential: 'apiUrl' }),
    ],
  },
  {
    id: 'flomo', label: 'flomo', group: 'B', tier: 'L3', delivery: 'file-producing', auth: 'export',
    links: [link('flomo 登录', 'https://flomoapp.com'), link('flomo 导出说明', 'https://help.flomoapp.com/faq.html')],
    guide: '官方 HTML 导出 https://help.flomoapp.com/faq.html 后导入。',
    steps: [
      step('点「flomo 登录」登录网页版。'),
      step('「设置」→「数据导出」→ 导出 HTML → 下载 zip。', 'HTML zip', '导入向导的绝对路径'),
      step('找不到入口就看第二个按钮「flomo 导出说明」，官方 FAQ 里有同样步骤的截图。'),
    ],
  },
  {
    id: 'webclip', label: '网页剪藏 / 稍后读', group: 'B', tier: 'L2', delivery: 'tool-returning', auth: 'local', links: [],
    guide: '插件内置链接转 Markdown：贴链接直接抓正文落盘（无需先登录，也不需要额外工具）。',
    steps: [
      step('无需登录：把要剪藏的链接贴进「贴链接转 Markdown」，插件自己抓正文并归档。'),
      step('需要登录才可见的页面，先按对应源登录，再用「让插件自己读」。'),
    ],
    actions: [
      action('fetch', '贴链接转 Markdown', '贴一条 https 链接，插件自己抓正文并归档。', { input: 'url' }),
    ],
  },
  {
    id: 'bookmarks', label: '浏览器书签', group: 'B', tier: 'L3', delivery: 'file-producing', auth: 'local', links: [],
    guide: '浏览器「书签管理器 → 导出书签」得到 HTML 后导入；这一步在浏览器内完成，没有可跳转的官方登录页。',
    steps: [
      step('浏览器打开「书签管理器」→ 右上「⋯」→「导出书签」→ 得到 bookmarks.html。', 'bookmarks.html', '导入向导的绝对路径'),
      step('导入后按目录结构生成 Markdown 索引，标题即书签标题。'),
    ],
  },

  // C. Audio / video / images (reference track)
  {
    id: 'xiaoyuzhou', label: '小宇宙 / 喜马拉雅', group: 'C', tier: 'L2', delivery: 'file-producing', auth: 'login',
    links: [link('小宇宙', 'https://www.xiaoyuzhoufm.com'), link('喜马拉雅', 'https://www.ximalaya.com')],
    guide: '登录态同步订阅；音轨只存指针并生成文字影子（transcript）。',
    steps: [
      step('点「小宇宙」或「喜马拉雅」登录。'),
      step('登录后点「让插件自己读」，插件在独立窗口里读「我的订阅 / 最近收听」列表（自动滚动加载）。'),
      step('音轨本体只存指针；要能检索得让转录适配器生成文字影子。'),
    ],
    reads: [
      readTarget('小宇宙 · 我的订阅', 'https://www.xiaoyuzhoufm.com/', ['www.xiaoyuzhoufm.com'], 1),
      readTarget('喜马拉雅 · 我的', 'https://www.ximalaya.com/', ['www.ximalaya.com']),
    ],
  },
  {
    id: 'feishu-minutes', label: '飞书妙记逐字稿', group: 'C', tier: 'L0', delivery: 'tool-returning', auth: 'token',
    links: [link('飞书开放平台 · 妙记权限', 'https://open.feishu.cn/app')],
    guide: '开放平台妙记接口取逐字稿（文字轨），原音频只存指针。',
    steps: [
      step('在飞书开发者后台（同一个应用）→「权限管理」加妙记权限 minutes:minutes:readonly。'),
      step('「版本管理与发布」重新发版并经管理员审核。', '审核通过的版本', '—'),
      step('按 minute token 调妙记接口取逐字稿；原音频只存指针，文字影子里存转录文本。'),
    ],
  },
  {
    id: 'images', label: '图片素材 / Figma', group: 'C', tier: 'L2', delivery: 'file-producing', auth: 'login',
    links: [link('Figma 登录', 'https://www.figma.com/files')],
    guide: '图片落素材轨，OCR/AI 摘要作文字影子；Figma 只读本人文件。',
    steps: [
      step('点「Figma 登录」登录。'),
      step('「Settings」→「Security」→「Personal access tokens」→ Generate new token，复制。', 'Personal Access Token', '下方输入框 → 点保存，自动写进 _secrets\\figma.json'),
      step('要读文件列表也可点「让插件自己读」直接读「我的文件」页；图片进素材轨，OCR/摘要作文字影子。'),
    ],
    credential: credential('figma.json', 'Figma PAT 形如 figd_…，只显示一次；存本地，界面只回显打码预览。', [
      field('token', 'Personal Access Token', 'Settings → Security → Personal access tokens 里生成'),
    ]),
    reads: [readTarget('Figma · 我的文件', 'https://www.figma.com/files', ['www.figma.com'])],
  },
  {
    id: 'creator-video', label: '抖音 / 小红书 / 视频号 / 即梦「我的作品」', group: 'C', tier: 'L2', delivery: 'file-producing', auth: 'login',
    links: [
      link('抖音创作者中心', 'https://creator.douyin.com'),
      link('小红书创作中心', 'https://creator.xiaohongshu.com/login'),
      link('视频号助手', 'https://channels.weixin.qq.com'),
      link('即梦 AI', 'https://jimeng.jianying.com'),
    ],
    guide: '本插件的独立浏览器窗口登录一次，之后由插件自己读「我的作品」列表；视频本体只存目录 + 字幕/OCR/摘要文字影子。',
    steps: [
      step('抖音：点「抖音创作者中心」→ 扫码登录 → 左侧「内容管理」→「作品管理」，确认能看到自己的作品列表。'),
      step('小红书：点「小红书创作中心」登录 →「笔记管理」。视频号：点「视频号助手」扫码 →「内容管理」。即梦：登录后进「我的作品」。'),
      step('登录完成后点「让插件自己读」——插件用同一份登录态读作品列表（标题、发布时间、数据），不需要你复制粘贴。'),
      step('视频本体只存目录（指针），可检索的是字幕 / OCR / 摘要生成的文字影子。'),
    ],
    reads: [
      readTarget('抖音 · 我的作品', 'https://creator.douyin.com/creator-micro/content/manage', ['creator.douyin.com'], 3),
      readTarget('小红书 · 笔记管理', 'https://creator.xiaohongshu.com/new/note-manager', ['creator.xiaohongshu.com'], 3),
      readTarget('视频号 · 内容管理', 'https://channels.weixin.qq.com/platform/post/list', ['channels.weixin.qq.com'], 3),
      readTarget('即梦 · 我的作品', 'https://jimeng.jianying.com/ai-tool/home', ['jimeng.jianying.com'], 1),
    ],
  },

  // D. Social / Q&A / system data
  {
    id: 'zhihu', label: '知乎收藏 / 回答', group: 'D', tier: 'L2', delivery: 'tool-returning', auth: 'login',
    links: [link('知乎登录', 'https://www.zhihu.com/signin')],
    guide: '插件内置链接转 Markdown：收藏列表由本插件按登录态自读，正文可逐条贴链接抓取。',
    steps: [
      step('点「知乎登录」登录。'),
      step('登录后确认「我的 → 收藏」能打开收藏夹列表。'),
      step('点「让插件自己读」读收藏页（自动滚动加载更多）；要单篇正文就把问题链接贴进「贴链接转 Markdown」，插件自己抓。'),
    ],
    reads: [readTarget('知乎 · 我的收藏', 'https://www.zhihu.com/collections', ['www.zhihu.com'], 3)],
    actions: [
      action('fetch', '贴链接转 Markdown', '贴一条问题/专栏链接，插件自己抓正文并归档。', { input: 'url' }),
    ],
  },
  {
    id: 'email', label: '邮件', group: 'D', tier: 'L1', delivery: 'tool-returning', auth: 'token',
    links: [link('QQ 邮箱 · 帮助中心（IMAP 授权码）', 'https://service.mail.qq.com'), link('网易邮箱 · 帮助中心（客户端授权码）', 'https://help.mail.163.com')],
    guide: '插件自己用 IMAP 增量取新邮件正文（内置客户端）；凭据是授权码 / 应用专用密码，不是登录密码。',
    steps: [
      step('QQ 邮箱：「设置」→「账号」→ 开启 IMAP/SMTP 服务 → 按短信提示生成「授权码」。'),
      step('网易邮箱：「设置」→「POP3/SMTP/IMAP」→ 开启 IMAP → 新增「客户端授权密码」。', '授权码 / 应用专用密码', '下方输入框 → 点保存，自动写进 _secrets\\email.json'),
      step('注意：凭据填授权码，不是邮箱登录密码 —— 填错会一直认证失败。'),
      step('保存后点「收取新邮件」，插件自己连 IMAP 拉取最近邮件正文并归档。'),
    ],
    credential: credential('email.json', 'IMAP 授权码不是登录密码；存本地，界面只回显打码预览。', [
      field('host', 'IMAP 服务器', '如 imap.qq.com / imap.163.com', { secret: false }),
      field('user', '邮箱地址', '完整邮箱地址，如 you@qq.com', { secret: false }),
      field('password', '授权码 / 应用专用密码', '邮箱设置里生成的那串，不是登录密码'),
    ]),
    actions: [
      action('mail', '收取新邮件', '插件自己连 IMAP 读最近邮件正文并归档（只读，不改已读状态）。', { credential: 'password' }),
    ],
  },
  {
    id: 'calendar', label: '日历 / 待办', group: 'D', tier: 'L1', delivery: 'tool-returning', auth: 'local', links: [],
    guide: '系统日历 App 导出 .ics，拖进投放区或填进导入向导；这一步在日历 App 内完成，不需要任何第三方工具。',
    steps: [
      step('打开系统日历 App（Windows 日历 / macOS 日历 / 手机日历），找到「导出」或「导出为 .ics」。'),
      step('把导出的 .ics 拖进投放区目录，或填进导入向导的绝对路径。', '.ics 文件', '投放区目录，或导入向导的绝对路径'),
    ],
  },

  // E. Own-account media content
  {
    id: 'wechat-mp', label: '公众号「自己账号」已发布图文', group: 'E', tier: 'L1', delivery: 'tool-returning', auth: 'login',
    links: [link('公众号后台登录', 'https://mp.weixin.qq.com')],
    guide: 'freepublish/batchget 仅认证主体；个人主体走 L2 网页后台「已发表 / 素材管理」，或由插件自读列表。',
    steps: [
      step('点「公众号后台登录」，用管理员微信扫码登录。'),
      step('左侧「内容与互动」→「已发表」看图文列表；「素材管理」看草稿与图片素材。'),
      step('点「让插件自己读」读已发表列表（标题、发布时间、阅读数）。'),
      step('认证主体才能用 freepublish/batchget 接口；个人主体只能走这条网页登录态路径。'),
    ],
    reads: [readTarget('公众号 · 已发表', 'https://mp.weixin.qq.com/', ['mp.weixin.qq.com'])],
  },
  {
    id: 'link-parse', label: '公众号 / 知乎 / 微信链接', group: 'E', tier: 'L2', delivery: 'tool-returning', auth: 'local', links: [],
    guide: '插件内置「贴链接转 Markdown」：贴一条 https 链接，插件自己抓正文、转 Markdown 并归档（无需先登录，也不需要额外工具）。',
    steps: [
      step('把要归档的链接贴进「贴链接转 Markdown」输入框，点「抓取并归档」。'),
      step('插件自己下载页面、抽取正文、转成 Markdown 存进知识库；公众号、知乎专栏、通用文章都用这一条。'),
      step('需要登录才可见的链接（付费文、私密分享），先按对应源登录，再用「让插件自己读」。'),
    ],
    actions: [
      action('fetch', '贴链接转 Markdown', '贴一条 https 链接，插件自己抓正文、转 Markdown 并归档。', { input: 'url' }),
    ],
  },

  // G. Web free-model chats
  {
    id: 'deepseek-web', label: 'DeepSeek 网页版对话', group: 'G', tier: 'L0', delivery: 'file-producing', auth: 'export',
    links: [link('DeepSeek 网页版（设置 → 数据管理 → 导出所有历史对话）', 'https://chat.deepseek.com')],
    guide: '设置 → 数据管理 → 导出所有历史对话（下载链接有效 7 天）；导出 ZIP 用导入向导接住，做片段级索引。',
    steps: [
      step('点按钮登录 chat.deepseek.com。'),
      step('左下头像 →「设置」→「数据管理」→「导出所有历史对话」。'),
      step('等页面/邮件给出下载链接（有效期 7 天），下载 ZIP。', '导出 ZIP', '导入向导的绝对路径'),
      step('导入后按对话做片段级索引；过期就得重新申请，别囤链接。'),
    ],
  },
  {
    id: 'yuanbao', label: '腾讯元宝对话', group: 'G', tier: 'L3', delivery: 'file-producing', auth: 'export',
    links: [link('腾讯元宝', 'https://yuanbao.tencent.com')],
    guide: '无一键全量导出：单条对话「分享 → 转为文档」跳腾讯文档另存 Word/PDF，或「我的收藏」，再导入。',
    steps: [
      step('点按钮登录腾讯元宝，打开要归档的对话。'),
      step('对话右上「分享」→「转为文档」→ 在腾讯文档里「另存为」Word/PDF 下载。', 'Word / PDF', '导入向导'),
      step('没有一键全量导出，对话多时逐条走；也可先「我的收藏」再批量处理。'),
    ],
  },
  {
    id: 'doubao', label: '豆包对话', group: 'G', tier: 'L0', delivery: 'file-producing', auth: 'export',
    links: [link('豆包', 'https://www.doubao.com')],
    guide: '官方「数据导出」申请（约 14 天出 JSON）；或浏览器扩展走页面同源接口导出 MD。',
    steps: [
      step('点按钮登录豆包。'),
      step('「设置」→「数据管理」→ 申请导出（官方约 14 天出 JSON，邮件通知）。', '导出 JSON', '导入向导'),
      step('急用就单条对话复制文本导入；或用浏览器扩展走页面同源接口导出 MD（只操作本人账号）。'),
    ],
  },
  {
    id: 'ai-chats', label: '通义 / Kimi / 智谱等 AI 对话', group: 'G', tier: 'L3', delivery: 'file-producing', auth: 'export',
    links: [link('通义千问', 'https://tongyi.aliyun.com'), link('Kimi', 'https://kimi.moonshot.cn'), link('智谱清言', 'https://chatglm.cn')],
    guide: '类推：官方导出优先，读不了则分享/复制文本导入；记录必须标注模型/对话/时间，避免循环引用。',
    steps: [
      step('先在该站「设置 → 数据 / 隐私」里找「导出」；有就导出，没有就单条复制文本。'),
      step('导入时每条记录标注模型 / 对话标题 / 时间 —— 否则日后无法判断这条结论是哪个模型何时说的。'),
    ],
  },

  // F. Personal IM — compliant channels only
  {
    id: 'wechat-chat', label: '个人微信聊天记录', group: 'F', tier: 'L3', delivery: 'file-producing', auth: 'export', links: [],
    guide: '仅官方通道：手机「设置 → 聊天 → 聊天记录备份与迁移」或 macOS 微信 4.1.13+「合并转发」打成 ZIP；绝不本地解密数据库。',
    steps: [
      step('手机微信「设置 → 聊天 → 聊天记录备份与迁移」，把记录备份/迁移到电脑。'),
      step('或 macOS 微信 4.1.13+ 用「合并转发」打成 ZIP（TXT + 原图视频）。', 'ZIP', '导入向导的绝对路径'),
      step('导入向导按魔数纠正扩展名后归集。该通道在手机/客户端内完成，没有可跳转的网页 —— 硬红线：绝不本地解密数据库。'),
    ],
  },
  {
    id: 'qq-chat', label: '个人 QQ 聊天记录', group: 'F', tier: 'L3', delivery: 'file-producing', auth: 'export', links: [],
    guide: '仅官方导出 / 合并转发分享通道（在 QQ 客户端内完成，无可跳转网页）；绝不本地解密数据库。',
    steps: [
      step('QQ 客户端「消息管理器」→ 选中会话 →「导出消息记录」（txt / mht）。', '消息记录文件', '导入向导的绝对路径'),
      step('或手机 QQ「聊天记录备份到电脑」。同样只走官方通道，绝不本地解密数据库。'),
    ],
  },
].map(freezeSource));

export const GROUP_LABELS = Object.freeze({
  A: '文档 / 知识库（文字轨）',
  B: '阅读 / 划线 / 剪藏（文字轨）',
  C: '音视频 / 图片（素材轨）',
  D: '社交 / 问答 / 系统数据',
  E: '公众号 / 自媒体本人内容',
  F: '个人微信 / QQ 聊天记录（仅合规通道）',
  G: '网页免费模型「随手查的资料」',
});

/** Hard compliance red line — never cross (chatlog takedown + Tencent complaint). */
export const HARD_BAN = Object.freeze({
  title: '绝不本地解密微信 / QQ 聊天数据库',
  reasons: [
    'chatlog 作者 2025-10-20 收到微信官方函件后主动删除全部代码与历史。',
    '腾讯 2026-01-22 向 GitHub 投诉要求下架「导出/分析自己微信聊天记录」类项目，理由含逆向破解本地数据库密钥、绕过客户端加密。',
  ],
  rule: '个人微信 / QQ 聊天历史只走官方备份 / 合并转发 / 分享，导入向导接住导出文件；不读、不解密本地数据库。',
});

/**
 * All official entry points across the registry, de-duplicated. Used by the
 * panel's link count and by tests that police URL hygiene (https only).
 */
export function allLinks() {
  const seen = new Map();
  for (const s of SOURCES) {
    for (const l of s.links) {
      const key = l.url;
      if (!seen.has(key)) seen.set(key, { url: l.url, label: l.label, sources: [] });
      seen.get(key).sources.push(s.id);
    }
  }
  return [...seen.values()];
}

/** Look one source up by id (undefined when unknown). */
export function sourceById(id) {
  const key = String(id ?? '').trim();
  return SOURCES.find((s) => s.id === key);
}

/** Flatten every readable page across the registry (host whitelist included). */
export function readablePages() {
  const out = [];
  for (const s of SOURCES) {
    s.reads.forEach((r, index) => {
      out.push({ sourceId: s.id, sourceLabel: s.label, index, label: r.label, url: r.url, hosts: r.hosts, scrollSteps: r.scrollSteps });
    });
  }
  return out;
}

/** Sources that accept a pasted credential, in registry order. */
export function credentialSources() {
  return SOURCES.filter((s) => s.credential);
}

/** The credential spec (file name + declared fields) for one source, or null. */
export function credentialSpec(sourceId) {
  const s = sourceById(sourceId);
  if (!s || !s.credential) return null;
  return { sourceId: s.id, label: s.label, ...s.credential };
}

/** Flatten every in-plugin capability button across the registry. */
export function sourceActions() {
  const out = [];
  for (const s of SOURCES) {
    for (const a of s.actions) {
      out.push({ sourceId: s.id, sourceLabel: s.label, kind: a.kind, label: a.label, note: a.note, input: a.input, credential: a.credential });
    }
  }
  return out;
}

/**
 * Compact source status for the panel + tools (bounded, no full transcripts).
 * `adaptersWired` defaults to 0 so callers that predate Phase 1 (and their
 * tests) keep seeing the Phase 0 snapshot; the Host passes the live count.
 */
export function sourceStatus(adaptersWired = 0) {
  const byTier = {};
  for (const t of LADDER) byTier[t.tier] = 0;
  for (const s of SOURCES) byTier[s.tier] = (byTier[s.tier] ?? 0) + 1;
  const n = Number.isFinite(adaptersWired) ? Math.max(0, Math.trunc(adaptersWired)) : 0;
  const phase = n > 0 ? 1 : 0;
  const withLinks = SOURCES.filter((s) => s.links.length > 0).length;
  const withSteps = SOURCES.filter((s) => s.steps.length >= 2).length;
  const stepTotal = SOURCES.reduce((acc, s) => acc + s.steps.length, 0);
  const readable = SOURCES.filter((s) => s.reads.length > 0).length;
  const withCreds = SOURCES.filter((s) => s.credential).length;
  const credFields = SOURCES.reduce((acc, s) => acc + (s.credential ? s.credential.fields.length : 0), 0);
  const withActions = SOURCES.filter((s) => s.actions.length > 0).length;
  const actionCount = sourceActions().length;
  return {
    total: SOURCES.length,
    byTier,
    phase,
    adaptersWired: n,
    entriesWithOfficialLink: withLinks,
    officialLinks: allLinks().length,
    entriesWithSteps: withSteps,
    stepCount: stepTotal,
    readableSources: readable,
    readablePages: readablePages().length,
    credentialSources: withCreds,
    credentialFields: credFields,
    actionSources: withActions,
    actions: actionCount,
    note: n > 0
      ? `Phase 3: ${withLinks}/${SOURCES.length} rows carry an official entry link, ${withSteps}/${SOURCES.length} carry step-by-step guidance (${stepTotal} steps), ${withCreds} take a pasted credential in a box that saves it for you, ${withActions} have a button for a capability built into this plugin (${actionCount} buttons) and ${readable} let the plugin read your own logged-in pages. Nothing in the panel asks you to install a third-party package.`
      : `Phase 0: registry + guidance only. ${withLinks}/${SOURCES.length} rows carry an official entry link.`,
  };
}
