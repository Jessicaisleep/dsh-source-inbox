# dsh-source-inbox

统一素材收件箱 / 工作栏 DSH 插件：官方入口按钮 + 登录后分步引导 + 凭据粘贴框 + 受控浏览器自读 + 本地知识库归档。

把你自己散落在飞书、腾讯文档、网盘、微信、公众号、网页版 AI 对话等处的资料，汇聚进一个本地知识库，创作时不再手动复制粘贴给模型。设计细节见 [docs/DETAIL.zh.md](./docs/DETAIL.zh.md)。

## 版本与原则

- **Phase 0（底座，已交付）**：导入向导、统一 schema、双轨归档、分类索引、侧边栏工作栏、状态/引导面板、模型工具。不登录、不抓取。
- **Phase 1（本版）**：可插拔适配器框架 + 第一个自动源「投放区观察器」（file-producing 形态）。监视一个本地落地目录，新文件自动走 Phase 0 的导入向导 / 双轨 / 合规闸门。**官方 MCP / API 源仍需一次账号授权，当前未接通**，注册表里诚实标为 `needs-auth`，不会假装它能跑。
- **每源官方入口按钮（2026-11 增补）**：数据源清单里 **21/28** 条带一键按钮，点开由系统浏览器直达该平台**官方**页面（官方 API → 登录/控制台；只有网页登录态 → 登录页；只给导出 → 导出入口）。剩余 7 条是本地通道或必须在手机/客户端完成的官方备份，行内写明原因而不放死按钮。按钮只跳转：不嵌页面、不接凭据，URL 仅接受 https，走宿主 `window.open → shell.openExternal`。数据见 `lib/sources.js` 的 `links`/`auth`。
- **Phase 2（本版）：登录之后的分步引导 + 插件自己读**：
  - **28/28 行带 `steps`（共 86 步）**，每步写清「点哪里 → 拿到什么 → 填到哪里」。例：飞书 5 步（开发者后台建自建应用 → 勾 docx/drive/wiki/bitable 只读权限并批量开通 → 复制 App ID/Secret 存 `_secrets\feishu.json` → 版本管理与发布过审 → 换 user_access_token）；腾讯文档 4 步（含 `400006`/`400007` 错误码与 `Authorization: <token>` 不是 Bearer）；邮箱 4 步（「填授权码不是登录密码」）。只给按钮不给下一步的死路已被这段取代。
  - **7 个源 / 11 个页面可以「让插件自己读」**：插件启动**自己独占的** Chromium（Edge/Chrome + `--remote-debugging-port` + 插件私有 `--user-data-dir`，零 npm 依赖，走 Node 内置 WebSocket 的 CDP），用户在那个窗口扫码登录一次，之后插件直接读列表并归档成 Markdown 记录。**不动用户日常浏览器的 profile**，因为日常窗口没开调试端口且会暴露全部站点 cookie。
  - **白名单闸门**：只有源注册表里声明过的 https 页面能被读；没写白名单等于什么都不许读，重定向/后缀伪造（`quark.cn.evil.com`）也不行；`/browser/open` 只接受已注册的官方入口 URL。
  - **登录墙不假装成功**：登录态过期时页面会返回 200 + 几百字「扫码登录」，插件用 `looksLikeLoginWall()` 判定后返回 `loginRequired`、**不归档**、并替你把这个页在插件窗口里打开，扫码后再点一次即可。
- **凭据不再让你手写文件（Phase 2.3）**：以前引导写「拿到 App ID / App Secret → 填到 `_secrets\feishu.json`」，等于要你自己建文件、猜 JSON 键名、手敲格式，写错了没有任何报错。现在 **8 个需要凭据的源（14 个字段）行内直接给输入框**，粘贴后点「保存到本地」，由插件写进 `$DSH_HOME/_secrets/<file>.json`（未设 `DSH_HOME` 时是 `~/.dsh/_secrets`，可用 `config.secretsDir` 或 `DSH_SECRETS_DIR` 指到别处；tmp+rename 原子写、`0600`）；界面和任何接口只回显**打码预览**（`cli_****（12 位）`），明文不出现在响应、日志、工具返回里。文件名与字段都是注册表声明的，越权文件名（`../x`）、未声明字段、超长值、控制字符一律拒绝。故意**没有**「用工具保存凭据」的 tool：密钥一旦写进 tool 参数就会留在对话记录里，所以保存只走面板输入框。见 `lib/credentials.js`。
- **四级接入阶梯**：L0 官方 MCP/API → L1 受限官方 API → L2 网页登录态读取 → L3 官方导出/分享/剪藏兜底。
- **只取抓数据那部分**：授权 / 抓取 / 落盘型存储复用已有插件，本插件只做下游统一整理归档 + 统一 UI（详见规划 §5）。
- **合规红线**：个人微信 / QQ 聊天记录只走官方备份 / 合并转发 / 分享导出，绝不本地解密数据库。

## 目录

```
index.js            Host 半：HTTP 路由 + agent tools（零外部依赖）
client.js           Client 半：window.__ModuleLoader__ 工作栏面板
lib/schema.js       统一 schema + 双轨判定 + checksum
lib/store.js        _inbox 落盘 + manifest.jsonl 索引 + 安全读取
lib/import.js       导入向导：魔数嗅探 / 纠正扩展名 / ZIP / 去重 / 归一 + 合规闸门
lib/sources.js      四级阶梯 + 28 数据源登记 + auth/links 官方入口 + steps 分步引导 + reads 可读页 + credential 凭据字段 + 合规红线
lib/adapters.js     Phase 1：适配器注册表 + 投放区观察器（re-arming one-shot 定时）+ 配置持久化
lib/browser.js      Phase 2：受控 Chromium 桥（CDP，零依赖）+ 白名单闸门 + 登录墙判定
lib/credentials.js  Phase 2.3：凭据保险库（裸文件名 / 仅声明字段 / 打码回显 / 原子写 0600）
locale/*.json       本地化 meta（title / description / detail）
docs/DETAIL*.md     插件详情页
icon.svg            36×36 原创图标
cordis.patch.yml    bundle 注册行
```

## 数据位置

默认 `$DSH_HOME/data/dsh-source-inbox/`。可用 `config.dataDir` 或环境变量 `DSH_SOURCE_INBOX_DIR` 覆盖。结构：

```
_inbox root/
  manifest.jsonl         追加式索引（每行一条记录，后写覆盖同 id）
  _raw/<source>/<YYYY-MM>/        文字轨原件
  materialized/<source>/<YYYY-MM>/  文字轨 Markdown 副本
  reference/<source>/<YYYY-MM>/     素材轨「文字影子」占位
  assets/                          预留
  dropzone/                        默认投放区（Phase 1 观察目录）
  browser-profile/                 Phase 2 受控浏览器私有 profile（登录态只留在里面）
  adapters.json                   观察器配置（dir/pollMs/enabled/source/tags）
```

素材轨（reference）只存指针 + 文字影子，不复制大文件本体。

## 受控浏览器（Phase 2）

`lib/browser.js` 启动一台插件独占的 Chromium（默认 Edge，可用 `DSH_BROWSER_PATH` 覆盖，或 `config.browserPath`）：

```
--remote-debugging-port=<9333 或 config.browser.port>  # clampPort 限制在 1024–65535
--user-data-dir=<dataDir>/browser-profile              # 插件私有，不是用户日常 profile
--no-first-run --no-default-browser-check
```

- **为什么不用日常浏览器**：日常 Chrome/Edge 没开调试端口，附加不上；就算能附加也会读到用户所有站点的 cookie。私有 profile 把插件能看到的范围限制死。
- **登录**：`/browser/open` 或面板按钮以**有头**模式打开官方登录页 → 用户扫码 → cookie 留在该 profile → 之后 `/browser/read` 以无头模式读列表。
- **隐私边界**：读之前先过 `readAllowed(url, hosts)`（https + host 白名单，空白名单=拒绝）；`/browser/open` 只接受注册表里已有的 URL；从不读取或保存密码。
- **登录墙检测**：`looksLikeLoginWall(text, url)` 对「短页面 + 扫码/登录/验证码字样」或 `passport./login` URL 判为未登录，返回 `loginRequired` 并跳过归档，避免把「扫码登录」页当成内容存进知识库。

## API（loopback，Host webServer）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/dsh-source-inbox/api/status` | 概览：数据目录、统计、源状态 |
| GET | `/dsh-source-inbox/api/stats` | 纯统计 |
| GET | `/dsh-source-inbox/api/sources` | 阶梯 + 数据源（含 `auth`、`links[]` 官方入口、`steps[]`、`reads[]`、`credential` 字段表）+ 引导 + 红线 |
| GET | `/dsh-source-inbox/api/list?source=&storage=&tag=&q=&limit=` | 有界列表（不含文件本体） |
| GET | `/dsh-source-inbox/api/read?id=&maxChars=` | 读归一化文本（有界、防穿越） |
| POST | `/dsh-source-inbox/api/import` | `{path, source?, tags?}` 导入官方导出产物 |
| GET | `/dsh-source-inbox/api/adapters` | 适配器注册表 + 观察器状态（phase 1 / wired） |
| POST | `/dsh-source-inbox/api/adapters/dropzone` | `{dir, pollMs?, minAgeMs?, enabled?, source?, tags?}` 配置观察目录；拒绝相对路径与「落在归档目录内」的反馈环 |
| POST | `/dsh-source-inbox/api/adapters/dropzone/scan` | 强制立即扫描一次（便于确定性验证 / 手动触发） |
| GET | `/dsh-source-inbox/api/browser/status` | 受控浏览器状态（是否在跑 / 模式 / 端口 / 浏览器版本）+ 可读页面清单 |
| POST | `/dsh-source-inbox/api/browser/open` | `{url, headless?}` 在受控浏览器里打开**已注册的官方入口**页（默认有头，用于扫码） |
| POST | `/dsh-source-inbox/api/browser/read` | `{source, page?, maxChars?, archive?, headless?}` 读该源白名单内页面并归档；登录墙返回 `loginRequired:true` 且不归档 |
| POST | `/dsh-source-inbox/api/browser/stop` | 关闭受控浏览器 |
| GET | `/dsh-source-inbox/api/credentials?source=` | 凭据状态：每源 `file/path/configured/savedAt` + 每字段 `saved` 与**打码预览**（永不含明文） |
| POST | `/dsh-source-inbox/api/credentials/save` | `{source, values}` 粘贴保存到本地 `_secrets`；未知字段/超长/控制字符/全空 → 400 |
| POST | `/dsh-source-inbox/api/credentials/clear` | `{source}` 删除该源已存凭据（幂等） |
| POST | `/dsh-source-inbox/api/remove` | `{id}` 删除一条记录（重写 manifest 并删除它独占的文件）；用于撤回误归档，例如修复前被当成内容存下的登录页 |

观察器配置存 `<dataDir>/adapters.json`，**不**写 profile 的 `cordis.patch.yml`（configuration.md 禁止插件重写用户 patch 层）。`dir` 必须是绝对路径且不能落在归档目录内（唯一例外是默认的 `<root>/dropzone`），否则观察器会把自己产出的 `_raw/`、`materialized/` 反复吃回来。定时器为 re-arming one-shot（`setTimeout` + `unref()`），cleanup 里 `clearTimeout`。

所有路由带 Host / Origin loopback 校验（防 DNS rebinding）。

## Agent 工具

`inbox_status` · `inbox_sources` · `inbox_list` · `inbox_read` · `inbox_import` · `inbox_adapters` · `inbox_watch`（= 配置投放区） · `inbox_scan`（= 立即扫描） · `inbox_browser`（= 受控浏览器状态 + 可读页） · `inbox_open_login`（= 打开官方登录页） · `inbox_read_page`（= 读本人已登录页面并归档） · `inbox_credentials`（= 哪些源已有凭据 + 字段名，只读、打码） · `inbox_remove`（= 删除一条记录，撤回误归档）

**注意 `inbox_credentials` 只读**：没有「用工具保存凭据」的 tool，因为密钥一旦作为参数传进来就会留在对话记录里。保存只在面板的粘贴框里做。

## 安装

**从 npm（推荐）**：

```bash
dsh plugin --profile web add dsh-source-inbox
```

**从 GitHub**：

```bash
dsh plugin --profile web add git+https://github.com/Jessicaisleep/dsh-source-inbox
```

**从本地目录**（开发时）：在 DSH 里用 `plugin_manager action:install_bundle`，target 传本目录的绝对路径；或 `dsh plugin --profile web add ./dsh-source-inbox`。

安装结果需出现 `application:applied` 才算生效（宿主开着 HMR 时，覆盖安装会先报 `already-installed`，先 `remove` 再 `add`）。本包为纯 ESM JavaScript、**零外部依赖**、不需要构建步骤；`engines.dsh` 声明为 `^0.2.1-rc.1 || ^0.2.2-rc.1 || ^0.2.3-rc.1`，宿主在安装与启动时都会校验（每加一个 0.x 的 rc 分支都要显式写出来：node-semver 默认不让未列出的预发布版本满足范围，写 `^0.2.1-rc.1` 时 `0.2.3-rc.1` 是**不匹配**的）。

装好后：侧栏出现「素材收件箱」面板；agent 侧多出 13 个 `inbox_*` 工具。首次使用建议先看面板里「数据源清单」每行的 `↗` 入口与编号步骤。

## 许可

MIT。见 [LICENSE](./LICENSE)。

## 后续 Phase

Phase 1 已落「投放区观察器」作为所有 file-producing 源（Wandao / 微信合并转发 ZIP / DeepSeek 导出 / 元宝转文档）的统一底座。Phase 2 已落「登录后分步引导 + 插件自读本人已登录页」。下一步：**官方 MCP / API 适配器**（腾讯文档个人 Token / 飞书 App ID+Secret / 夸克登录）—— 需用户先给一次账号授权，按 L0→L3 逐个加；其后 Phase 3 万能导文字轨 → Phase 4 素材轨文字影子 + AI 对话片段。每个源做成可插拔适配器，逐个加。

## 测试

```
node tests/smoke.mjs               # schema / store / import 归一化
node tests/adapters-harness.mjs    # 观察器 + 配置持久化 + 合规闸门
node tests/browser-harness.mjs     # 白名单闸门 / 端口钳制 / 登录墙启发式 / 启动参数
node tests/credentials-harness.mjs # 凭据保险库：裸文件名 / 声明字段 / 打码 / 原子写 / 清除
node tests/host-harness.mjs        # 17 路由 + 13 工具 + 守卫 + 凭据不回传明文 + cleanup
node tests/client-harness.mjs      # 面板渲染 / 28 行按钮 / steps / 自读 / 凭据输入框 / 删除 / 词典
```

共 **496 项**，全部 `exit=0`。

两个已修的回归（都有对应用例，防止再犯）：

- **登录墙不能靠长度判断**。原来的 `looksLikeLoginWall` 首行 `if (t.length > 900) return false`，而真实登出的抖音页有 1127 字（登录框外面裹着 AI 工坊营销文案）—— 登录页被当成内容归档，还报「已归档」。现在只认登录框专属 UI 串（`扫码登录`/`请先登录`/`Log in to continue` …）或 URL 里的 `/login`、`/signin`、`passport.`。已知代价写在注释里：文章若逐字引用这些 UI 串会被判成墙，多点一次，换掉「把登录页永久存进知识库」。
- **同一来源同一月的两条记录不能共用一个文件**。`store.put()` 原来在 `id` 还没算出来时就用 `record.innerPath ?? 'file'` 定路径，两条记录都落到 `materialized/<source>/<YYYY-MM>/file.md`，后写的覆盖前一条的文件，于是读 A 的正文显示的是 B。现在先用 `id` 定路径（每条记录独占一个文件），`remove()` 也只删「没有别的记录仍在引用」的文件。
