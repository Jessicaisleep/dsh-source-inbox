/**
 * dsh-source-inbox — Client half (Phase 0): the unified 工作栏 panel.
 *
 * Pure ESM JavaScript loaded through window.__ModuleLoader__. React comes from
 * the host module table (require('react')); NO host Client UI package is
 * imported (practices.md), and styling uses only --dsw-alias-* theme tokens so
 * light/dark themes are inherited. All registrations live in one ctx.effect
 * with a single cleanup. Prefix-aware api() avoids the root-absolute-path bug
 * documented at dshmarket/client/client.js:2787-2804, AND keeps the query
 * string (?id=, ?limit=) that a pathname-only return used to silently drop.
 */
window.__ModuleLoader__.load({
  id: 'dsh-source-inbox',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    const NS = 'dsh-source-inbox';
    const PANEL_ID = 'dsh-source-inbox';
    const API = '/dsh-source-inbox/api';
    const GRID = '1fr 110px 90px 130px 70px 130px';
    const ROW_MIN = '540px';

    const DICT = {
      zh: {
        nav: '素材收件箱',
        title: '素材收件箱',
        subtitle: '把散落在飞书 / 云文档 / 网盘 / 微信 / 公众号 / 网页模型的资料，统一归档成一个可检索的本地知识库。',
        phase: 'Phase 1 · 底座+观察器',
        statTotal: '已归档',
        statText: '文字轨',
        statRef: '素材轨',
        statShadow: '待补文字影子',
        statRoot: '数据目录',
        shadowHint: '素材轨记录待补的文字影子（摘要 / 转录 / OCR），补齐后才能被检索。',
        importTitle: '导入向导',
        importHint: '填入官方导出 / 合并转发 / 剪藏产物的绝对路径（文件或目录）。按魔数纠正扩展名、去重、归一化后落盘；不读取任何本地聊天数据库。',
        pathPh: '绝对路径，例如 E:\\exports\\wechat-forward.zip',
        sourcePh: '来源 id（默认 import），如 wechat-chat / deepseek-web',
        tagsPh: '标签，逗号分隔（可选）',
        importBtn: '导入',
        importing: '导入中…',
        importOk: '导入完成',
        importResult: '新增 {i} · 重复 {d} · 跳过 {s} · 错误 {e}',
        recordsTitle: '归档记录',
        refresh: '刷新',
        qPh: '按标题搜索',
        allStorage: '全部存储轨',
        textTrack: '文字轨 materialized',
        refTrack: '素材轨 reference',
        colTitle: '标题',
        colSource: '来源',
        colTrack: '轨道',
        colMime: '类型',
        colSize: '大小',
        colTime: '归档时间',
        loading: '正在加载归档数据…',
        empty: '还没有归档记录。先在上方导入一个官方导出文件吧。',
        noMatch: '没有符合当前筛选条件的记录。',
        loadFailed: '加载失败',
        readHint: '点击任意记录查看归一化后的 Markdown / 文字影子（有长度上限）。',
        readTitle: '内容预览',
        truncated: '（内容已按长度上限截断，仅显示前一段）',
        missingText: '该记录暂无归一化文本：素材轨记录需先生成「文字影子」（摘要 / 转录 / OCR）后才能预览与检索。',
        removeLabel: '删除这条记录',
        removeConfirm: '确定删除这条记录？文件会一起删掉，不可撤销。',
        removeOk: '已删除',
        removeFail: '删除失败',
        adapterTitle: '自动源适配器',
        adapterHint: '投放区观察器已接线：监视一个本地落地目录，新文件自动走导入向导 / 双轨归档 / 合规闸门。官方 MCP / API 源需要用户先给一次账号授权，当前未接通——不会假装它能跑。',
        adapterDir: '观察目录（绝对路径；不得落在归档目录内，防反馈环）',
        adapterDirPh: '例如 E:\\exports\\dropzone',
        adapterPoll: '轮询间隔 ms（500–600000）',
        adapterSource: '来源 id',
        adapterTags: '标签，逗号分隔',
        adapterEnabled: '启用自动轮询',
        adapterSave: '保存配置',
        adapterScan: '立即扫描一次',
        adapterScanning: '扫描中…',
        adapterWired: '已接线',
        adapterNeedsAuth: '需授权',
        adapterRunning: '运行中',
        adapterStopped: '已停止',
        adapterScans: '扫描次数',
        adapterImported: '自动归档',
        adapterLastScan: '上次扫描',
        adapterConfigOk: '配置已保存',
        adapterScanOk: '扫描完成',
        adapterBadge: '自动源状态',
        ladderTitle: '数据源接入阶梯',
        ladderHint: 'Phase 1 已接通「投放区观察器」一个自动适配器（file-producing 形态）。官方 MCP / API 源仍需一次账号授权，按 L0→L3 逐个接入。',
        banTitle: '合规红线',
        groupTitle: '数据源清单（按分组）',
        guideLabel: '引导',
        showGroup: '展开',
        hideGroup: '收起',
        authOauth: '授权登录',
        authToken: '获取凭据',
        authLogin: '网页登录',
        authExport: '官方导出',
        authLocal: '本地通道',
        authOpen: '打开官方页面',
        authNoLinkLocal: '本地通道：没有网页登录入口，在本地目录 / 客户端内完成，无需跳转。',
        authNoLinkExport: '官方通道在手机 / 客户端内完成（备份、合并转发、导出书签），没有可跳转的网页登录页。',
        authNoLinkToken: '凭据到该服务商自己的后台 / 客户端生成，没有统一的官方授权网页。',
        groupHint: '每一行都给出直达入口：官方有接口的打开登录 / 授权 / 取 Token 页，官方没接口的打开官方登录页或导出页；点按钮用系统浏览器打开，插件不收集你的密码。',
        stepLabel: '登录之后怎么做',
        stepGet: '拿到',
        stepWhere: '填到',
        readSelf: '让插件自己读',
        readBusy: '正在读取…',
        readOk: '已读取并归档',
        readFail: '读取失败',
        readPageHint: '插件用自己独立的浏览器 profile 打开这一页（不动你的日常浏览器）；第一次点会弹出登录窗口，登录完再点一次就能读到列表。',
        readLoginNeeded: '这一页还是登录框——已帮你打开插件自己的浏览器窗口，扫码登录后再点一次「让插件自己读」。',
        credLabel: '凭据（粘贴后直接保存）',
        credSave: '保存到本地',
        credSaving: '保存中…',
        credClear: '清除',
        credClearConfirm: '清除这个数据源已保存的凭据？',
        credOk: '已保存到本地',
        credCleared: '已清除',
        credFail: '保存失败',
        credSavedBadge: '已保存',
        credEmptyBadge: '未保存',
        credNeedRequired: '必填项还没填：{x}',
        credSecretNote: '只写本地磁盘，界面只回显打码预览；任何接口响应、日志、工具返回里都不会出现明文。',
        actFetch: '贴链接转 Markdown',
        actFetchHint: '贴一条 https 链接，插件自己下载、抽正文、转 Markdown 并归档；不用装任何额外工具。',
        actFetchPlaceholder: 'https://…',
        actFetchGo: '抓取并归档',
        actWeread: '导出划线',
        actCubox: '同步收藏',
        actMail: '收取新邮件',
        actBusy: '正在处理…',
        actOk: '已完成',
        actNeedCred: '先在上面把凭据粘贴保存，再点这个按钮。',
        actResult: '已归档 {n} 条',
        errNetwork: '请求失败（宿主未就绪或路径不可达）',
        noBrowser: '宿主未声明 sidebar.panellist 侧栏 slot；工作栏仍作为 main 页面可用，工具与 API 正常。',
      },
      en: {
        nav: 'Source inbox',
        title: 'Source inbox',
        subtitle: 'Unify your scattered notes, docs, drive files, chats, articles and web-AI chats into one searchable local knowledge base.',
        phase: 'Phase 1 · foundation+watcher',
        statTotal: 'Archived',
        statText: 'Text track',
        statRef: 'Asset track',
        statShadow: 'Shadows pending',
        statRoot: 'Data dir',
        shadowHint: 'Asset-track records awaiting a text shadow (summary / transcript / OCR); needed before they can be searched.',
        importTitle: 'Import wizard',
        importHint: 'Give an ABSOLUTE path to an official export / share bundle (file or directory). Files are sniffed by magic bytes, de-duplicated and normalized; no local chat database is read.',
        pathPh: 'Absolute path, e.g. E:\\exports\\wechat-forward.zip',
        sourcePh: 'Source id (default import), e.g. wechat-chat / deepseek-web',
        tagsPh: 'Tags, comma separated (optional)',
        importBtn: 'Import',
        importing: 'Importing…',
        importOk: 'Imported',
        importResult: 'Added {i} · duplicates {d} · skipped {s} · errors {e}',
        recordsTitle: 'Archived records',
        refresh: 'Refresh',
        qPh: 'Search by title',
        allStorage: 'All tracks',
        textTrack: 'Text (materialized)',
        refTrack: 'Asset (reference)',
        colTitle: 'Title',
        colSource: 'Source',
        colTrack: 'Track',
        colMime: 'Type',
        colSize: 'Size',
        colTime: 'Captured',
        loading: 'Loading archived data…',
        empty: 'Nothing archived yet. Import an official export above to get started.',
        noMatch: 'No records match the current filter.',
        loadFailed: 'Load failed',
        readHint: 'Click a record to preview its normalized Markdown / text shadow (bounded).',
        readTitle: 'Preview',
        truncated: '(truncated at the length limit — showing the first part only)',
        missingText: 'No normalized text yet: an asset-track record needs its text shadow (summary / transcript / OCR) generated before it can be previewed or searched.',
        removeLabel: 'Delete this record',
        removeConfirm: 'Delete this record? Its files are removed too — this cannot be undone.',
        removeOk: 'Deleted',
        removeFail: 'Delete failed',
        adapterTitle: 'Automatic source adapters',
        adapterHint: 'Dropzone watcher is wired: it watches a local drop directory, and new files flow through the import wizard / dual-track archive / compliance gate. Official MCP/API sources need a one-time account authorization and are NOT connected yet — no pretending they run.',
        adapterDir: 'Watch directory (absolute; must not sit inside the archive root — feedback-loop guard)',
        adapterDirPh: 'e.g. E:\\exports\\dropzone',
        adapterPoll: 'Poll interval ms (500–600000)',
        adapterSource: 'Source id',
        adapterTags: 'Tags, comma separated',
        adapterEnabled: 'Enable auto polling',
        adapterSave: 'Save config',
        adapterScan: 'Scan now',
        adapterScanning: 'Scanning…',
        adapterWired: 'Wired',
        adapterNeedsAuth: 'Needs auth',
        adapterRunning: 'Running',
        adapterStopped: 'Stopped',
        adapterScans: 'Scans',
        adapterImported: 'Auto-archived',
        adapterLastScan: 'Last scan',
        adapterConfigOk: 'Config saved',
        adapterScanOk: 'Scan complete',
        adapterBadge: 'Adapter status',
        ladderTitle: 'Source access ladder',
        ladderHint: 'Phase 1 wires one automatic adapter (the file-producing dropzone watcher). Official MCP/API sources still need a one-time account authorization and are added L0→L3 one by one.',
        banTitle: 'Compliance red line',
        groupTitle: 'Source registry (by group)',
        guideLabel: 'Guide',
        showGroup: 'Expand',
        hideGroup: 'Collapse',
        authOauth: 'Authorize',
        authToken: 'Get credentials',
        authLogin: 'Web login',
        authExport: 'Official export',
        authLocal: 'Local channel',
        authOpen: 'Open official page',
        authNoLinkLocal: 'Local channel: no web login page — done inside the local folder / client app, nothing to open.',
        authNoLinkExport: 'The official channel runs inside the phone / desktop client (backup, merge-forward, bookmark export) — there is no web login page to open.',
        authNoLinkToken: 'The credential is created in that provider’s own admin console / client; there is no single official authorization page.',
        groupHint: 'Every row carries a direct entry point: official-API sources open their login / authorization / token page, sources without an API open their official login or export page. Buttons open the system browser; the plugin never collects your password.',
        stepLabel: 'After you log in',
        stepGet: 'You get',
        stepWhere: 'Put it in',
        readSelf: 'Read it for me',
        readBusy: 'Reading…',
        readOk: 'Read and archived',
        readFail: 'Read failed',
        readPageHint: 'The plugin opens the page in its own separate browser profile (your daily browser is untouched). The first click shows a login window; log in, then click again to read the list.',
        readLoginNeeded: 'That page is still a login wall — I opened the plugin\'s own browser window; scan the QR code, then click "Read it for me" once more.',
        credLabel: 'Credential (paste, then save)',
        credSave: 'Save locally',
        credSaving: 'Saving…',
        credClear: 'Clear',
        credClearConfirm: 'Clear the saved credential for this source?',
        credOk: 'Saved locally',
        credCleared: 'Cleared',
        credFail: 'Save failed',
        credSavedBadge: 'Saved',
        credEmptyBadge: 'Not saved',
        credNeedRequired: 'Required field still empty: {x}',
        credSecretNote: 'Written to local disk only; the panel shows a masked preview. The plaintext never appears in an API response, a log line, or a tool result.',
        actFetch: 'Link to Markdown',
        actFetchHint: 'Paste one https link: the plugin downloads it, extracts the article, converts it to Markdown and archives it. Nothing else to install.',
        actFetchPlaceholder: 'https://…',
        actFetchGo: 'Fetch and archive',
        actWeread: 'Export highlights',
        actCubox: 'Sync cards',
        actMail: 'Fetch new mail',
        actBusy: 'Working…',
        actOk: 'Done',
        actNeedCred: 'Paste and save the credential above first, then press this button.',
        actResult: 'Archived {n} record(s)',
        errNetwork: 'Request failed (host not ready or path unreachable)',
        noBrowser: 'The host did not declare the sidebar.panellist slot; the workbench is still available as a main page, and tools/API keep working.',
      },
    };

    /**
     * Prefix-aware path (never root-absolute). Mirrors dshmarket api(), but
     * ALSO keeps the query string: returning only .pathname silently dropped
     * ?id= / ?limit= so record previews 404'd (independent review MAJOR #1).
     */
    function api(path) {
      const relative = String(path).replace(/^\/+/, '');
      if (typeof document === 'undefined') return '/' + relative;
      try {
        const u = new URL(relative, document.baseURI);
        return u.pathname + u.search;
      } catch { return '/' + relative; }
    }

    // Plain function: this runs at module/factory scope, NOT inside a React
    // render, so a hook (useCallback) would throw "Invalid hook call" here.
    const getJSON = async (path) => {
      const res = await fetch(api(path), { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`${res.status} ${path}`);
      return res.json();
    };

    // ---- small presentational helpers (inline styles, theme tokens only) ----
    const C = {
      bgBase: 'var(--dsw-alias-bg-base,#ffffff)',
      bgLayer1: 'var(--dsw-alias-bg-layer-1,#f7f8fa)',
      bgLayer2: 'var(--dsw-alias-bg-layer-2,#eef0f4)',
      border: 'var(--dsw-alias-border-l2,#d9dee6)',
      label: 'var(--dsw-alias-label-primary,#1f2328)',
      label2: 'var(--dsw-alias-label-secondary,#5c6570)',
      label3: 'var(--dsw-alias-label-tertiary,#8b93a1)',
      hover: 'var(--dsw-alias-interactive-bg-hover,#2631480f)',
      brand: 'var(--dsw-alias-brand-primary,#4f6ef7)',
      warn: 'var(--dsw-alias-state-warn-primary,#d98f0b)',
      success: 'var(--dsw-alias-state-success-primary,#1a9c5b)',
      error: 'var(--dsw-alias-state-error-primary,#d64545)',
      radius: 'var(--dsw-radius-sm,8px)',
      radiusMd: 'var(--dsw-radius-md,12px)',
    };

    // Keyboard focus ring that works with inline styles (no :focus-visible).
    const focusRing = { outline: '2px solid transparent', outlineOffset: '1px' };
    const onFocus = (e) => { try { e.target.style.outlineColor = C.brand; } catch { /* noop */ } };
    const onBlur = (e) => { try { e.target.style.outlineColor = 'transparent'; } catch { /* noop */ } };
    const focusable = { onFocus, onBlur };

    /**
     * Open an official entry page in the SYSTEM browser. The host installs a
     * window setWindowOpenHandler that turns any window.open('https:…') into
     * shell.openExternal and denies the in-app popup, so we never embed the
     * page ourselves and never touch credentials. Only absolute https URLs are
     * accepted here — the registry is the single source of truth for them.
     */
    function openExternal(url) {
      const s = String(url ?? '').trim();
      if (!/^https:\/\/[^\s]+$/i.test(s)) return false;
      const w = typeof window !== 'undefined' ? window : globalThis;
      try {
        if (typeof w.open === 'function') { w.open(s, '_blank', 'noopener,noreferrer'); return true; }
      } catch { /* fall through */ }
      return false;
    }

    // ---- registry row rendering (module scope so it is unit-testable) ----
    // auth kind -> DICT key. The host sends the raw kind; the caption is local.
    const AUTH_KEY = { oauth: 'authOauth', token: 'authToken', login: 'authLogin', export: 'authExport', local: 'authLocal' };
    // A row without any web entry point explains WHY instead of a dead button.
    const NO_LINK_KEY = { local: 'authNoLinkLocal', export: 'authNoLinkExport', token: 'authNoLinkToken', oauth: 'authNoLinkToken', login: 'authNoLinkLocal' };
    // action kind -> DICT key for the button caption. The row carries a spec
    // label too, but the panel translates so both locales read naturally.
    const ACT_LABEL = { fetch: 'actFetch', weread: 'actWeread', cubox: 'actCubox', mail: 'actMail' };
    // Secondary "open official page" button used by every registry row.
    const LINK_BTN = {
      font: 'inherit', fontSize: '11px', fontWeight: 600, color: C.brand, background: C.bgBase,
      border: `1px solid ${C.border}`, borderRadius: '999px', padding: '2px 10px', cursor: 'pointer',
      whiteSpace: 'nowrap', ...focusRing,
    };
    const CHIP = { fontSize: '10px', color: C.label3, border: `1px solid ${C.border}`, borderRadius: '999px', padding: '1px 7px' };
    // Credential input styling lives at module scope because SourceRow (also
    // module scope) renders it; Panel's own `inputStyle` is out of scope there.
    const CRED_INPUT = {
      font: 'inherit', fontSize: '11px', color: C.label, background: C.bgBase,
      border: `1px solid ${C.border}`, borderRadius: C.radius, padding: '5px 9px', ...focusRing,
    };

    /**
     * One registry row: title + tier/delivery/auth chips + the official entry
     * buttons + the step-by-step guidance + (for L2 rows) a "read it for me"
     * action + (for rows with a credential) a paste-and-save box.
     *
     * The steps matter as much as the button: a login page with no follow-up is
     * the dead end this replaced ("飞书登录了开发者后台之后呢?"). Each step says
     * what to click, optionally what you get, and where that value goes.
     *
     * The credential box replaced an even worse dead end: a step that said
     * "填到 E:\...\_secrets\feishu.json" expected the user to create the file
     * and guess the JSON keys. Now they paste into a field and press save.
     *
     * Deliberately dumb/pure: no hooks, so tests can call it directly.
     */
    function SourceRow({ s, t, onRead, reading, cred, credBusy, onSaveCred, onClearCred, actBusy, onAction }) {
      const links = Array.isArray(s?.links) ? s.links : [];
      const steps = Array.isArray(s?.steps) ? s.steps : [];
      const reads = Array.isArray(s?.reads) ? s.reads : [];
      const actions = Array.isArray(s?.actions) ? s.actions : [];
      return h('div', { style: { background: C.bgBase, border: `1px solid ${C.border}`, borderRadius: C.radius, padding: '8px 10px' } },
        h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
          h('span', { style: { fontWeight: 600, fontSize: '12px' } }, s.label),
          h('span', { style: CHIP }, s.tier),
          h('span', { style: { fontSize: '10px', color: C.label3 } }, s.delivery),
          h('span', { style: { ...CHIP, color: links.length ? C.brand : C.label3 } }, t(AUTH_KEY[s.auth] ?? 'authLocal')),
        ),
        h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' } },
          links.length === 0
            ? h('span', { style: { fontSize: '11px', color: C.label3, lineHeight: '17px' } }, t(NO_LINK_KEY[s.auth] ?? 'authNoLinkLocal'))
            : links.map((l) => h('button', {
              key: l.url,
              type: 'button',
              title: `${t('authOpen')}：${l.url}`,
              'aria-label': `${t('authOpen')}：${l.label}`,
              ...focusable,
              style: LINK_BTN,
              onClick: () => openExternal(l.url),
            }, `↗ ${l.label}`)),
        ),
        h('div', { style: { fontSize: '11px', color: C.label2, lineHeight: '17px', marginTop: '4px', wordBreak: 'break-word' } }, `${t('guideLabel')}：${s.guide}`),
        steps.length === 0 ? null : h('ol', {
          style: { margin: '6px 0 0', padding: '0 0 0 18px', fontSize: '11px', color: C.label2, lineHeight: '17px' },
          'aria-label': t('stepLabel'),
        }, steps.map((st, i) => h('li', { key: `step-${i}`, style: { marginBottom: '2px' } },
          h('span', null, st.doing),
          st.get ? h('span', { style: { color: C.brand } }, ` — ${t('stepGet')}：${st.get}`) : null,
          st.where ? h('span', { style: { color: C.label3 } }, ` → ${t('stepWhere')}：${st.where}`) : null,
        ))),
        // One entry point per platform when a row covers several (抖音 / 小红书 /
        // 视频号 / 即梦), so the user picks the list they actually logged into
        // instead of silently getting whichever page happened to be first.
        reads.length === 0 ? null : h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginTop: '6px' } },
          reads.map((pg, i) => h('button', {
            key: `read-${i}`,
            type: 'button',
            title: `${t('readPageHint')}\n${pg.url}`,
            'aria-label': `${t('readSelf')}：${pg.label}`,
            ...focusable,
            disabled: typeof onRead !== 'function' || !!reading,
            style: { ...LINK_BTN, color: reading ? C.label3 : C.brand, cursor: typeof onRead === 'function' && !reading ? 'pointer' : 'default', opacity: reading ? 0.6 : 1 },
            onClick: () => { if (typeof onRead === 'function' && !reading) onRead(s, pg); },
          }, reading ? t('readBusy') : `⟳ ${t('readSelf')}·${pg.label}`)),
          h('span', { style: { fontSize: '10px', color: C.label3, lineHeight: '15px', flex: '1 1 220px' } }, t('readPageHint')),
        ),
        // Paste-and-save box. The row spec (s.credential) declares the file name
        // and the field list; the live saved state comes from the host (cred),
        // so the box can say "已保存 · cli_****（N 位）" without ever holding the
        // secret. Inputs are uncontrolled on purpose: the value lives in the
        // DOM until the user presses save, never in component state that could
        // be logged, and we clear the field on success.
        s.credential ? h('div', {
          style: { marginTop: '8px', paddingTop: '8px', borderTop: `1px dashed ${C.border}` },
        },
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '4px' } },
            h('span', { style: { fontWeight: 600, fontSize: '11px' } }, t('credLabel')),
            h('span', { style: { ...CHIP, color: (cred?.configured ? C.success : C.label3) } }, cred?.configured ? t('credSavedBadge') : t('credEmptyBadge')),
            cred?.path ? h('span', { style: { fontSize: '10px', color: C.label3, wordBreak: 'break-all' } }, cred.path) : null,
          ),
          (s.credential.fields || []).map((f) => {
            const state = (cred?.fields || []).find((x) => x.key === f.key);
            return h('div', { key: f.key, style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '4px' } },
              h('label', { style: { fontSize: '11px', color: C.label2, minWidth: '150px' } },
                f.label,
                f.required ? h('span', { style: { color: C.error } }, ' *') : null,
              ),
              h('input', {
                type: f.secret === false ? 'text' : 'password',
                'data-cred-field': f.key,
                'aria-label': f.label,
                placeholder: state?.saved ? state.preview : (f.help || ''),
                autoComplete: 'off',
                spellCheck: false,
                ...focusable,
                style: { ...CRED_INPUT, flex: '1 1 220px' },
              }),
            );
          }),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '6px' } },
            h('button', {
              type: 'button', ...focusable,
              disabled: typeof onSaveCred !== 'function' || !!credBusy,
              style: { ...LINK_BTN, opacity: credBusy ? 0.6 : 1 },
              onClick: (e) => {
                if (typeof onSaveCred !== 'function' || credBusy) return;
                // Read the inputs out of the DOM subtree of this row, keyed by
                // data-cred-field, so no state ever holds the plaintext.
                const root = e?.currentTarget?.parentElement?.parentElement;
                const values = {};
                if (root && typeof root.querySelectorAll === 'function') {
                  for (const el of root.querySelectorAll('[data-cred-field]')) {
                    values[el.getAttribute('data-cred-field')] = el.value ?? '';
                  }
                }
                onSaveCred(s, values);
              },
            }, credBusy ? t('credSaving') : t('credSave')),
            h('button', {
              type: 'button', ...focusable,
              disabled: typeof onClearCred !== 'function' || !!credBusy || !cred?.configured,
              style: { ...LINK_BTN, color: C.error, opacity: (!cred?.configured || credBusy) ? 0.5 : 1 },
              onClick: () => { if (typeof onClearCred === 'function' && !credBusy && cred?.configured) onClearCred(s); },
            }, t('credClear')),
            h('span', { style: { fontSize: '10px', color: C.label3, lineHeight: '15px', flex: '1 1 220px' } }, s.credential.note || t('credSecretNote')),
          ),
        ) : null,
        // Buttons for capabilities this plugin implements itself (Phase 3).
        // Before this, the row said "交给 envoy-dsh / 走 Wandao / 用 dsh-cubox"
        // — names the user would have to search for, and a name nobody owns is
        // a name an attacker can register. Each button here hits a route in
        // index.js; the work happens in lib/.
        actions.length === 0 ? null : h('div', {
          style: { marginTop: '8px', paddingTop: '8px', borderTop: `1px dashed ${C.border}` },
        },
          actions.map((a, i) => {
            const busy = !!actBusy;
            const caption = actBusy === `run:${s.id}`
              ? t('actBusy')
              : (ACT_LABEL[a.kind] ? t(ACT_LABEL[a.kind]) : a.label);
            const needsUrl = a.input === 'url';
            return h('div', { key: `act-${i}`, style: { marginTop: i === 0 ? 0 : '6px' } },
              h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' } },
                needsUrl ? h('input', {
                  type: 'url',
                  'data-act-url': s.id,
                  'aria-label': `${caption}：${t('actFetchPlaceholder')}`,
                  placeholder: t('actFetchPlaceholder'),
                  autoComplete: 'off',
                  spellCheck: false,
                  ...focusable,
                  style: { ...CRED_INPUT, flex: '1 1 260px' },
                }) : null,
                h('button', {
                  type: 'button',
                  ...focusable,
                  'data-act-kind': a.kind,
                  title: a.note || caption,
                  'aria-label': `${caption}：${s.label}`,
                  disabled: typeof onAction !== 'function' || busy,
                  style: { ...LINK_BTN, opacity: busy ? 0.6 : 1 },
                  onClick: (e) => {
                    if (typeof onAction !== 'function' || busy) return;
                    // The link is read from the DOM subtree, not from state: no
                    // reason to keep a pasted URL in component state either.
                    let url = '';
                    if (needsUrl) {
                      const root = e?.currentTarget?.parentElement?.parentElement;
                      const el = root && typeof root.querySelector === 'function'
                        ? root.querySelector(`[data-act-url="${s.id}"]`) : null;
                      url = String(el?.value ?? '').trim();
                      if (!url) return;
                    }
                    onAction(s, a, url);
                  },
                }, `▶ ${caption}`),
                h('span', { style: { fontSize: '10px', color: C.label3, lineHeight: '15px', flex: '1 1 220px' } }, a.note),
              ),
            );
          }),
        ),
      );
    }

    /** Variadic on purpose: several call sites pass multiple children. */
    function Card(title, subtitle, ...children) {
      return h('section', {
        style: {
          background: C.bgLayer1, border: `1px solid ${C.border}`, borderRadius: C.radiusMd,
          padding: '14px 16px', marginBottom: '14px', color: C.label,
        },
      },
        h('h3', { style: { margin: '0 0 2px', fontSize: '14px', fontWeight: 600, lineHeight: '20px' } }, title),
        subtitle ? h('p', { style: { margin: '0 0 12px', fontSize: '12px', lineHeight: '18px', color: C.label3 } }, subtitle) : null,
        ...children,
      );
    }

    function StatCell(value, label, title) {
      return h('div', {
        title,
        style: {
          flex: '1 1 110px', minWidth: '96px', background: C.bgBase, border: `1px solid ${C.border}`,
          borderRadius: C.radius, padding: '10px 12px',
        },
      },
        h('div', { style: { fontSize: '20px', fontWeight: 600, lineHeight: '26px', color: C.label } }, String(value)),
        h('div', { style: { fontSize: '11px', lineHeight: '16px', color: C.label3 } }, label),
      );
    }

    function InboxIcon(props) {
      const s = props?.size ?? 16;
      return h('svg', { width: s, height: s, viewBox: '0 0 36 36', 'aria-hidden': true, style: { display: 'block' } },
        h('path', { d: 'M6 20v7a2 2 0 0 0 2 2h20a2 2 0 0 0 2-2v-7', fill: 'none', stroke: '#247bbf', strokeWidth: 2.4, strokeLinejoin: 'round' }),
        h('path', { d: 'M6 20l4-11h16l4 11', fill: '#5b9bd5', stroke: '#247bbf', strokeWidth: 2.4, strokeLinejoin: 'round' }),
        h('path', { d: 'M18 8v9m0 0-3.5-3.5M18 17l3.5-3.5', fill: 'none', stroke: '#ffffff', strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      );
    }

    // ---- the main panel component (hooks live here, rendered by host React) ----
    function Panel({ t }) {
      const [status, setStatus] = useState(null);
      const [catalog, setCatalog] = useState(null);
      const [rows, setRows] = useState([]);
      const [q, setQ] = useState('');
      const [storage, setStorage] = useState('');
      const [path, setPath] = useState('');
      const [source, setSource] = useState('import');
      const [tags, setTags] = useState('');
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState('');
      const [msgOk, setMsgOk] = useState(false);
      const [selected, setSelected] = useState(null);
      const [openGroups, setOpenGroups] = useState({});
      const [loadError, setLoadError] = useState('');
      // Phase 1 adapter state
      const [adapters, setAdapters] = useState(null);
      const [adzDir, setAdzDir] = useState('');
      const [adzPoll, setAdzPoll] = useState('5000');
      const [adzSource, setAdzSource] = useState('dropzone');
      const [adzTags, setAdzTags] = useState('');
      const [adzEnabled, setAdzEnabled] = useState(true);
      const [adzBusy, setAdzBusy] = useState(false);
      const [adzMsg, setAdzMsg] = useState('');
      const [adzMsgOk, setAdzMsgOk] = useState(false);
      // Phase 2: which source id is being read right now ('' = idle).
      const [readBusy, setReadBusy] = useState('');
      const [readMsg, setReadMsg] = useState('');
      const [readMsgOk, setReadMsgOk] = useState(false);
      // Phase 2.3: credential vault state, keyed by source id. Only ever holds
      // the host's masked status — never a plaintext secret.
      const [creds, setCreds] = useState({});
      const [credBusy, setCredBusy] = useState('');
      const [credMsg, setCredMsg] = useState('');
      const [credMsgOk, setCredMsgOk] = useState(false);
      // Phase 3: in-plugin capability buttons (fetch a link / export highlights
      // / sync cards / fetch mail). actBusy is `${sourceId}` while running.
      const [actBusy, setActBusy] = useState('');
      const [actMsg, setActMsg] = useState('');
      const [actMsgOk, setActMsgOk] = useState(false);
      const mounted = useRef(true);
      const adzSeeded = useRef(false);

      const loadAll = useCallback(async () => {
        try {
          const [st, cat, list, ad] = await Promise.all([
            getJSON(`${API}/status`),
            getJSON(`${API}/sources`),
            getJSON(`${API}/list?limit=200`),
            getJSON(`${API}/adapters`),
          ]);
          // The vault is optional (a host without an absolute secretsDir answers
          // 503): a failure here must not blank out the whole panel.
          const cr = await getJSON(`${API}/credentials`).catch(() => null);
          if (!mounted.current) return;
          setStatus(st); setCatalog(cat); setRows(list.rows ?? []); setAdapters(ad); setLoadError('');
          if (cr?.items) {
            setCreds(Object.fromEntries(cr.items.map((i) => [i.source, i])));
          }
          // Seed the adapter form only once (don't clobber in-progress edits on refresh).
          if (!adzSeeded.current) {
            adzSeeded.current = true;
            const dz = ad?.dropzone ?? {};
            setAdzDir(dz.dir ?? '');
            setAdzPoll(String(dz.pollMs ?? 5000));
            setAdzSource(dz.source || 'dropzone');
            setAdzTags((dz.tags ?? []).join(', '));
            setAdzEnabled(dz.enabled !== false);
          }
        } catch (e) {
          // Keep the error in the records card, not the import card.
          if (mounted.current) setLoadError(t('errNetwork'));
        }
      }, [t]);

      useEffect(() => {
        mounted.current = true;
        loadAll();
        return () => { mounted.current = false; };
      }, [loadAll]);

      const doImport = useCallback(async () => {
        if (!path.trim() || busy) return;
        setBusy(true); setMessage(''); setMsgOk(false);
        try {
          const res = await fetch(api(`${API}/import`), {
            method: 'POST', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: path.trim(), source: source.trim() || 'import', tags: tags.split(',').map((s) => s.trim()).filter(Boolean) }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(`${res.status} ${data?.error ?? ''}`);
          const line = t('importResult')
            .replace('{i}', data.imported).replace('{d}', data.duplicates)
            .replace('{s}', data.skipped).replace('{e}', data.errors);
          setMsgOk(true); setMessage(`✓ ${t('importOk')} · ${line}`);
          await loadAll();
        } catch (e) { setMsgOk(false); setMessage(String(e?.message ?? t('errNetwork'))); }
        finally { setBusy(false); }
      }, [path, source, tags, busy, loadAll, t]);

      const openRecord = useCallback(async (id) => {
        try {
          const r = await getJSON(`${API}/read?id=${encodeURIComponent(id)}`);
          if (mounted.current) setSelected(r);
        } catch (e) { setMsgOk(false); setMessage(String(e?.message ?? t('errNetwork'))); }
      }, [t]);

      const postJSON = useCallback(async (path, payload) => {
        const res = await fetch(api(path), {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(`${res.status} ${data?.error ?? data?.reason ?? ''}`);
        return data;
      }, []);

      // Removing a record is the only way to take a wrong read back out of the
      // knowledge base (e.g. a login page archived before the wall detector
      // could recognise it). Declared after postJSON — a dependency array is
      // evaluated during render, so referencing a later const would throw TDZ.
      const removeRecord = useCallback(async (id) => {
        // /read answers { record, text, truncated, missing }, so the id lives on
        // selected.record.id. Passing selected.id handed this function undefined
        // and the old `if (!id) return` swallowed the click without a word — the
        // button looked dead. Fail loudly instead of silently.
        if (!id) { setMsgOk(false); setMessage(t('removeFail')); return; }
        const w = typeof window !== 'undefined' ? window : globalThis;
        if (typeof w.confirm === 'function' && !w.confirm(t('removeConfirm'))) return;
        try {
          await postJSON(`${API}/remove`, { id });
          if (mounted.current) setSelected((cur) => (cur && cur.record?.id === id ? null : cur));
          setMsgOk(true); setMessage(`✓ ${t('removeOk')}：${id}`);
          await loadAll();
        } catch (e) { setMsgOk(false); setMessage(`${t('removeFail')}：${String(e?.message ?? t('errNetwork'))}`); }
      }, [postJSON, loadAll, t]);

      const saveAdapters = useCallback(async () => {
        if (adzBusy) return;
        setAdzBusy(true); setAdzMsg(''); setAdzMsgOk(false);
        try {
          const data = await postJSON(`${API}/adapters/dropzone`, {
            dir: adzDir.trim(), pollMs: Number(adzPoll) || 5000,
            enabled: !!adzEnabled, source: adzSource.trim() || 'dropzone',
            tags: adzTags.split(',').map((s) => s.trim()).filter(Boolean),
          });
          if (!data.ok) throw new Error(data.reason || 'config rejected');
          setAdapters(await getJSON(`${API}/adapters`));
          setAdzMsgOk(true); setAdzMsg(`✓ ${t('adapterConfigOk')}`);
        } catch (e) { setAdzMsgOk(false); setAdzMsg(String(e?.message ?? t('errNetwork'))); }
        finally { setAdzBusy(false); }
      }, [adzDir, adzPoll, adzEnabled, adzSource, adzTags, adzBusy, postJSON, t]);

      const scanAdapters = useCallback(async () => {
        if (adzBusy) return;
        setAdzBusy(true); setAdzMsg(''); setAdzMsgOk(false);
        try {
          const data = await postJSON(`${API}/adapters/dropzone/scan`, {});
          setAdapters(await getJSON(`${API}/adapters`));
          const line = t('importResult')
            .replace('{i}', data.imported ?? 0).replace('{d}', data.duplicates ?? 0)
            .replace('{s}', data.skipped ?? 0).replace('{e}', data.errors ?? 0);
          setAdzMsgOk(true); setAdzMsg(`✓ ${t('adapterScanOk')} · ${line}`);
          await loadAll();
        } catch (e) { setAdzMsgOk(false); setAdzMsg(String(e?.message ?? t('errNetwork'))); }
        finally { setAdzBusy(false); }
      }, [adzBusy, postJSON, loadAll, t]);

      /**
       * "让插件自己读": open the row's whitelisted page in the plugin's OWN
       * browser profile and archive the visible text. The first call for a
       * source usually fails with "login required" in the page text — we open
       * the login page visibly instead of pretending it worked, then the second
       * click reads real content. Reads are archived, so the result is a record
       * and a refresh shows it.
       */
      const readSource = useCallback(async (src, page) => {
        if (!src || readBusy) return;
        const wanted = page ?? (Array.isArray(src.reads) && src.reads.length ? src.reads[0] : null);
        if (!wanted) return;
        setReadBusy(src.id); setReadMsg(''); setReadMsgOk(false);
        try {
          const data = await postJSON(`${API}/browser/read`, { source: src.id, page: wanted.label, headless: false, archive: true });
          if (data?.loginRequired) {
            // Not a failure: the page loaded but it is a login wall. Bring up the
            // plugin's own window on that exact page so the user can scan, then
            // they click once more.
            await postJSON(`${API}/browser/open`, { url: wanted.url, headless: false }).catch(() => {});
            setReadMsgOk(false);
            setReadMsg(`${t('readLoginNeeded')}（${wanted.label}）`);
            return;
          }
          setReadMsgOk(true);
          const archived = data?.archived?.id ? ` · ${data.archived.id}` : '';
          setReadMsg(`✓ ${t('readOk')}：${data.page}（${data.chars} 字${archived}）`);
          await loadAll();
        } catch (e) {
          setReadMsgOk(false);
          setReadMsg(`${t('readFail')}：${String(e?.message ?? t('errNetwork'))}`);
        } finally { setReadBusy(''); }
      }, [readBusy, postJSON, loadAll, t]);

      /**
       * Save a pasted credential. The values arrive straight from the inputs
       * (never from component state, so the plaintext has no second home); the
       * reply carries only the masked status, which is what we store for render.
       */
      const saveCredential = useCallback(async (src, values) => {
        if (!src || credBusy) return;
        const fields = src.credential?.fields ?? [];
        const missing = fields.filter((f) => f.required && !String(values?.[f.key] ?? '').trim());
        if (missing.length) {
          setCredMsgOk(false);
          setCredMsg(t('credNeedRequired').replace('{x}', missing.map((f) => f.label).join('、')));
          return;
        }
        setCredBusy(src.id); setCredMsg(''); setCredMsgOk(false);
        try {
          const data = await postJSON(`${API}/credentials/save`, { source: src.id, values });
          if (!data.ok) throw new Error(data.reason || 'rejected');
          setCreds((cur) => ({ ...cur, [src.id]: data.status }));
          setCredMsgOk(true);
          setCredMsg(`✓ ${t('credOk')}：${data.status?.path ?? src.credential?.file ?? src.id}`);
        } catch (e) {
          setCredMsgOk(false);
          setCredMsg(`${t('credFail')}：${String(e?.message ?? t('errNetwork'))}`);
        } finally { setCredBusy(''); }
      }, [credBusy, postJSON, t]);

      const clearCredential = useCallback(async (src) => {
        if (!src || credBusy) return;
        const w = typeof window !== 'undefined' ? window : globalThis;
        if (typeof w.confirm === 'function' && !w.confirm(t('credClearConfirm'))) return;
        setCredBusy(src.id); setCredMsg(''); setCredMsgOk(false);
        try {
          const data = await postJSON(`${API}/credentials/clear`, { source: src.id });
          if (!data.ok) throw new Error(data.reason || 'rejected');
          setCreds((cur) => ({ ...cur, [src.id]: data.status }));
          setCredMsgOk(true);
          setCredMsg(`✓ ${t('credCleared')}：${src.label}`);
        } catch (e) {
          setCredMsgOk(false);
          setCredMsg(`${t('credFail')}：${String(e?.message ?? t('errNetwork'))}`);
        } finally { setCredBusy(''); }
      }, [credBusy, postJSON, t]);

      /**
       * Run one in-plugin capability. Each kind maps to a route that does the
       * work locally — there is no third-party package behind any of these
       * buttons, which is the point: the old guidance named tools the user would
       * have to go find.
       */
      const runAction = useCallback(async (src, a, url) => {
        if (!src || !a || actBusy) return;
        const kind = String(a.kind ?? '');
        const routeFor = {
          fetch: `${API}/fetch/url`,
          weread: `${API}/export/weread`,
          cubox: `${API}/export/cubox`,
          mail: `${API}/export/mail`,
        }[kind];
        if (!routeFor) return;
        setActBusy(src.id); setActMsg(''); setActMsgOk(false);
        try {
          const payload = kind === 'fetch'
            ? { url, source: src.id, archive: true }
            : { source: src.id, archive: true };
          const data = await postJSON(routeFor, payload);
          if (!data?.ok) throw new Error(data?.error || data?.reason || 'rejected');
          const n = kind === 'fetch' ? (data.archived ? 1 : 0) : Number(data.exported ?? 0);
          // An exporter that found nothing is not a success worth dressing up:
          // say what happened instead of claiming "已归档 0 条".
          const parts = [`✓ ${t('actOk')}`];
          if (n > 0) parts.push(t('actResult').replace('{n}', String(n)));
          else if (kind !== 'fetch') parts.push('没有新增内容');
          if (Array.isArray(data.failures) && data.failures.length) parts.push(`${data.failures.length} 条失败`);
          setActMsgOk(true);
          setActMsg(parts.join(' · '));
          await loadAll();
        } catch (e) {
          setActMsgOk(false);
          setActMsg(`${t('readFail')}：${String(e?.message ?? t('errNetwork'))}`);
        } finally { setActBusy(''); }
      }, [actBusy, postJSON, loadAll, t]);

      const filtered = rows.filter((r) => {
        if (storage && r.storage !== storage) return false;
        if (q && !String(r.title).toLowerCase().includes(q.toLowerCase())) return false;
        return true;
      });

      const stats = status?.stats ?? {};
      const ladder = catalog?.ladder ?? [];
      const sources = catalog?.sources ?? [];
      const groups = catalog?.groups ?? {};
      const hardBan = catalog?.hardBan;
      const tierCount = status?.sources?.byTier ?? {};

      const inputStyle = {
        flex: '1 1 180px', minWidth: '140px', font: 'inherit', fontSize: '12px',
        color: C.label, background: C.bgBase, border: `1px solid ${C.border}`,
        borderRadius: C.radius, padding: '7px 10px', ...focusRing,
      };
      const btnStyle = {
        font: 'inherit', fontSize: '12px', fontWeight: 600, color: '#fff', background: C.brand,
        border: 'none', borderRadius: C.radius, padding: '8px 16px', cursor: 'pointer', whiteSpace: 'nowrap',
        ...focusRing,
      };

      return h('div', {
        style: {
          boxSizing: 'border-box', height: '100%', overflowY: 'auto', padding: '16px 18px 40px',
          background: C.bgBase, color: C.label, fontSize: '13px', lineHeight: '1.5',
        },
      },
        // Header
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginBottom: '14px' } },
          h(InboxIcon, { size: 26 }),
          h('div', { style: { flex: '1 1 200px' } },
            h('h2', { style: { margin: 0, fontSize: '17px', fontWeight: 600, lineHeight: '24px' } }, t('title')),
            h('p', { style: { margin: 0, fontSize: '12px', lineHeight: '18px', color: C.label3 } }, t('subtitle')),
          ),
          h('span', { style: { fontSize: '11px', color: C.label3, border: `1px solid ${C.border}`, borderRadius: '999px', padding: '3px 10px', whiteSpace: 'nowrap' } }, t('phase')),
        ),

        // Stats
        h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '14px' } },
          StatCell(stats.total ?? 0, t('statTotal')),
          StatCell(stats.byStorage?.materialized ?? 0, t('statText')),
          StatCell(stats.byStorage?.reference ?? 0, t('statRef')),
          StatCell(stats.shadowsPending ?? 0, t('statShadow'), t('shadowHint')),
        ),
        h('p', { style: { margin: '-6px 0 14px', fontSize: '11px', color: C.label3, wordBreak: 'break-all' } }, `${t('statRoot')}: ${status?.root ?? '—'}`),

        // Import wizard
        Card(t('importTitle'), t('importHint'),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
            h('input', { style: { ...inputStyle, flex: '2 1 320px' }, placeholder: t('pathPh'), 'aria-label': t('pathPh'), ...focusable, value: path, onChange: (e) => setPath(e.target.value) }),
            h('input', { style: inputStyle, placeholder: t('sourcePh'), 'aria-label': t('sourcePh'), ...focusable, value: source, onChange: (e) => setSource(e.target.value) }),
            h('input', { style: inputStyle, placeholder: t('tagsPh'), 'aria-label': t('tagsPh'), ...focusable, value: tags, onChange: (e) => setTags(e.target.value) }),
            h('button', { style: { ...btnStyle, opacity: busy ? 0.6 : 1 }, disabled: busy, ...focusable, onClick: doImport }, busy ? t('importing') : t('importBtn')),
          ),
          message ? h('p', { role: 'status', 'aria-live': 'polite', style: { margin: '10px 0 0', fontSize: '12px', color: msgOk ? C.success : C.error } }, message) : null,
        ),

        // Phase 1: automatic source adapters
        Card(t('adapterTitle'), t('adapterHint'),
          // Registry badges (server is the source of truth for state).
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' } },
            (adapters?.adapters ?? []).map((a) => h('span', {
              key: a.id,
              title: a.hint,
              style: {
                fontSize: '11px',
                color: a.state === 'wired' ? C.success : C.warn,
                border: `1px solid ${C.border}`, borderRadius: '999px', padding: '3px 10px', background: C.bgBase,
              },
            }, `${a.label} · ${a.state === 'wired' ? t('adapterWired') : t('adapterNeedsAuth')}`)),
          ),
          // Live watcher status line
          adapters?.dropzone ? h('div', { style: { fontSize: '11px', color: C.label3, marginBottom: '10px', wordBreak: 'break-all' } },
            `${t('adapterBadge')}: ${adapters.dropzone.running ? t('adapterRunning') : t('adapterStopped')} · `
            + `${t('adapterScans')} ${adapters.dropzone.scans ?? 0} · ${t('adapterImported')} ${adapters.dropzone.imported ?? 0}`
            + (adapters.dropzone.lastScanAt ? ` · ${t('adapterLastScan')} ${String(adapters.dropzone.lastScanAt).slice(0, 19).replace('T', ' ')}` : ''),
          ) : null,
          // Config form
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
            h('input', { style: { ...inputStyle, flex: '2 1 300px' }, placeholder: t('adapterDirPh'), 'aria-label': t('adapterDir'), ...focusable, value: adzDir, onChange: (e) => setAdzDir(e.target.value) }),
            h('input', { style: { ...inputStyle, flex: '0 1 130px', minWidth: '110px' }, placeholder: t('adapterPoll'), 'aria-label': t('adapterPoll'), ...focusable, value: adzPoll, onChange: (e) => setAdzPoll(e.target.value) }),
            h('input', { style: inputStyle, placeholder: t('adapterSource'), 'aria-label': t('adapterSource'), ...focusable, value: adzSource, onChange: (e) => setAdzSource(e.target.value) }),
            h('input', { style: inputStyle, placeholder: t('adapterTags'), 'aria-label': t('adapterTags'), ...focusable, value: adzTags, onChange: (e) => setAdzTags(e.target.value) }),
          ),
          h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', marginTop: '8px' } },
            h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px', color: C.label2, cursor: 'pointer' } },
              h('input', { type: 'checkbox', 'aria-label': t('adapterEnabled'), ...focusable, checked: adzEnabled, onChange: (e) => setAdzEnabled(e.target.checked) }),
              t('adapterEnabled'),
            ),
            h('button', { style: { ...btnStyle, opacity: adzBusy ? 0.6 : 1 }, disabled: adzBusy, ...focusable, onClick: saveAdapters }, t('adapterSave')),
            h('button', { style: { ...btnStyle, background: C.bgLayer2, color: C.label, opacity: adzBusy ? 0.6 : 1 }, disabled: adzBusy, ...focusable, onClick: scanAdapters }, adzBusy ? t('adapterScanning') : t('adapterScan')),
          ),
          adzMsg ? h('p', { role: 'status', 'aria-live': 'polite', style: { margin: '10px 0 0', fontSize: '12px', color: adzMsgOk ? C.success : C.error } }, adzMsg) : null,
          h('p', { style: { margin: '8px 0 0', fontSize: '11px', color: C.label3 } }, t('adapterDir')),
        ),

        // Ladder (+ compliance red line, now actually rendered by Card)
        Card(t('ladderTitle'), t('ladderHint'),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' } },
            ladder.map((l) => h('span', {
              key: l.tier,
              title: l.hint,
              style: { fontSize: '11px', color: l.tier === 'BAN' ? C.error : C.label2, border: `1px solid ${C.border}`, borderRadius: C.radius, padding: '4px 9px', background: C.bgBase },
            }, `${l.tier} · ${l.label} · ${tierCount[l.tier] ?? 0}`)),
          ),
          hardBan ? h('div', {
            style: { border: `1px solid ${C.error}`, borderRadius: C.radius, padding: '10px 12px', background: C.bgBase },
          },
            h('div', { style: { fontWeight: 600, fontSize: '12px', color: C.error, marginBottom: '4px' } }, `${t('banTitle')}：${hardBan.title}`),
            h('div', { style: { fontSize: '11px', color: C.label2, lineHeight: '17px' } }, hardBan.rule),
            h('ul', { style: { margin: '6px 0 0', paddingLeft: '18px', fontSize: '11px', color: C.label3, lineHeight: '17px' } },
              (hardBan.reasons ?? []).map((r, i) => h('li', { key: i }, r)),
            ),
          ) : null,
        ),

        // Source registry — every row carries its official entry point(s).
        Card(t('groupTitle'), t('groupHint'),
          Object.keys(groups).sort().map((g) => {
            const items = sources.filter((s) => s.group === g);
            if (!items.length) return null;
            // Groups default to EXPANDED so every row's official button is visible
            // without a first click (openGroups[g] === false means collapsed).
            const open = openGroups[g] !== false;
            return h('div', { key: g, style: { borderTop: `1px solid ${C.border}`, padding: '8px 0' } },
              h('button', {
                'aria-expanded': open,
                ...focusable,
                style: { background: 'none', border: 'none', cursor: 'pointer', font: 'inherit', fontSize: '12px', fontWeight: 600, color: C.label, padding: 0, display: 'flex', gap: '8px', alignItems: 'center', ...focusRing },
                onClick: () => setOpenGroups((o) => ({ ...o, [g]: o[g] === false })),
              },
                h('span', { style: { color: C.brand } }, open ? '▾' : '▸'),
                `${g} · ${groups[g]}（${items.length}）`,
                h('span', { style: { color: C.label3, fontWeight: 400 } }, open ? t('hideGroup') : t('showGroup')),
              ),
              open ? h('div', { style: { marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '6px' } },
                items.map((s) => h(SourceRow, {
                  key: s.id, s, t,
                  onRead: (src, page) => readSource(src, page),
                  reading: readBusy === s.id,
                  cred: creds[s.id] ?? null,
                  credBusy: credBusy === s.id,
                  onSaveCred: (src, values) => saveCredential(src, values),
                  onClearCred: (src) => clearCredential(src),
                  actBusy: actBusy === s.id ? `run:${s.id}` : '',
                  onAction: (src, a, url) => runAction(src, a, url),
                })),
              ) : null,
            );
          }),
          credMsg
            ? h('p', {
              role: 'status',
              style: { margin: '8px 0 0', fontSize: '11px', lineHeight: '17px', color: credMsgOk ? C.success : C.error, wordBreak: 'break-word' },
            }, credMsg)
            : null,
          readMsg
            ? h('p', {
              role: 'status',
              style: { margin: '8px 0 0', fontSize: '11px', lineHeight: '17px', color: readMsgOk ? C.success : C.error, wordBreak: 'break-word' },
            }, readMsg)
            : null,
          actMsg
            ? h('p', {
              role: 'status',
              style: { margin: '8px 0 0', fontSize: '11px', lineHeight: '17px', color: actMsgOk ? C.success : C.error, wordBreak: 'break-word' },
            }, actMsg)
            : null,
        ),

        // Records
        Card(t('recordsTitle'), t('readHint'),
          h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' } },
            h('input', { style: { ...inputStyle, flex: '1 1 200px' }, placeholder: t('qPh'), 'aria-label': t('qPh'), ...focusable, value: q, onChange: (e) => setQ(e.target.value) }),
            h('select', { style: inputStyle, 'aria-label': t('allStorage'), ...focusable, value: storage, onChange: (e) => setStorage(e.target.value) },
              h('option', { value: '' }, t('allStorage')),
              h('option', { value: 'materialized' }, t('textTrack')),
              h('option', { value: 'reference' }, t('refTrack')),
            ),
            h('button', { style: { ...btnStyle, background: C.bgLayer2, color: C.label }, ...focusable, onClick: loadAll }, t('refresh')),
          ),
          loadError
            ? h('p', { role: 'status', style: { fontSize: '12px', color: C.error } }, `${t('loadFailed')}：${loadError}`)
            : status === null
              ? h('p', { style: { fontSize: '12px', color: C.label3 } }, t('loading'))
              : h('div', { style: { overflowX: 'auto' } },
                  h('div', { style: { display: 'grid', gridTemplateColumns: GRID, gap: '8px', minWidth: ROW_MIN, boxSizing: 'border-box', padding: '0 10px 4px', fontSize: '11px', color: C.label3 } },
                    ['colTitle', 'colSource', 'colTrack', 'colMime', 'colSize', 'colTime'].map((k) => h('span', { key: k }, t(k))),
                  ),
                  filtered.length === 0
                    ? h('p', { style: { fontSize: '12px', color: C.label3 } }, rows.length === 0 ? t('empty') : t('noMatch'))
                    : h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: ROW_MIN } },
                        filtered.map((r) => h('button', {
                          key: r.id,
                          ...focusable,
                          onClick: () => openRecord(r.id),
                          style: {
                            display: 'grid', gridTemplateColumns: GRID, gap: '8px', alignItems: 'center',
                            textAlign: 'left', font: 'inherit', fontSize: '11px', color: C.label, background: C.bgBase,
                            border: `1px solid ${C.border}`, borderRadius: C.radius, padding: '7px 10px', cursor: 'pointer',
                            minWidth: ROW_MIN, boxSizing: 'border-box', ...focusRing,
                          },
                        },
                          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 } }, r.title),
                          h('span', { style: { color: C.label2 } }, r.source),
                          h('span', { style: { color: r.storage === 'reference' ? C.warn : C.success } }, r.storage),
                          h('span', { style: { color: C.label3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.mimeType),
                          h('span', { style: { color: C.label3 } }, `${Math.round((r.sizeBytes ?? 0) / 1024)}KB`),
                          h('span', { style: { color: C.label3 } }, String(r.capturedAt).slice(0, 16).replace('T', ' ')),
                        )),
                      ),
                ),
          selected ? h('div', { style: { marginTop: '12px', borderTop: `1px solid ${C.border}`, paddingTop: '10px' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', flexWrap: 'wrap' } },
              h('span', { style: { fontWeight: 600, fontSize: '12px' } }, `${t('readTitle')}：${selected.record?.title ?? '—'}`),
              h('button', {
                type: 'button', ...focusable, onClick: () => removeRecord(selected.record?.id),
                style: { ...btnStyle, marginLeft: 'auto', background: C.bgLayer2, color: C.error, border: `1px solid ${C.border}`, fontSize: '11px' },
              }, t('removeLabel')),
            ),
            h('pre', { style: { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '11px', lineHeight: '17px', color: C.label2, background: C.bgBase, border: `1px solid ${C.border}`, borderRadius: C.radius, padding: '10px', maxHeight: '320px', overflowY: 'auto' } }, selected.text && !selected.missing ? selected.text : t('missingText')),
            selected.truncated ? h('div', { style: { marginTop: '4px', fontSize: '11px', color: C.warn } }, t('truncated')) : null,
          ) : null,
        ),
      );
    }

    // ---- module registration ----
    return {
      inject: ['slots', 'locale', 'theme'],
      apply(ctx) {
        let t = (k) => k;
        let layout;
        if (ctx.locale && typeof ctx.locale.register === 'function' && typeof ctx.locale.bind === 'function') {
          ctx.effect(() => ctx.locale.register(NS, DICT), 'dsh-source-inbox: dictionaries');
          t = ctx.locale.bind(NS);
        }
        // layout is resolved once at apply scope (mirrors dshmarket client.js:19028),
        // so the effect cleanup can deselect our panel on unmount.
        try { ctx.inject(['layout'], (scoped) => { layout = scoped.layout; }); } catch { /* optional */ }
        ctx.effect(() => {
          const offs = [];
          // rc.3 (DSH 0.2.2-rc.3) declares `sidebar.panellist` lazily, as a child
          // of the `sidebar.panel.icon` factory, and `main` is dispatched by the
          // layout owner. A bare ctx.slots.register() at apply time runs BEFORE
          // those declarations exist, so the entry is silently dropped (and our
          // old try/catch swallowed it). The supported contract — used by the
          // runner's own slot examples, the decoration template, and EVERY
          // first-party panel (plugin-manager / schedule / conversation) — is:
          //   ctx.slots.inject(name, () => ctx.slots.register(...))
          // inject() runs the callback synchronously if the declaration already
          // exists, otherwise inside the declaring register() once committed;
          // it also works on older hosts where the slots were declared eagerly.
          // The register() disposer is returned as the SlotInjectionEffect, and
          // inject() returns the outer disposer we collect for cleanup.
          try {
            offs.push(ctx.slots.inject('main', () => ctx.slots.register({
              name: 'main', key: PANEL_ID, locale: NS, inject: () => ({ t }),
            }, () => h(Panel, { t }))));
          } catch (e) { console.warn('[dsh-source-inbox] main panel registration failed:', e?.message); }
          try {
            offs.push(ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
              name: 'sidebar.panellist', id: PANEL_ID, order: 5, label: () => t('nav'), locale: NS,
            }, (owner = {}) => h(InboxIcon, { size: owner.size ?? 16 }))));
          } catch (e) { console.warn('[dsh-source-inbox] sidebar row unavailable:', e?.message); }

          return () => {
            for (const off of offs) { if (typeof off === 'function') { try { off(); } catch { /* noop */ } } }
            try { if (layout?.panelInfo?.getSnapshot?.().activePanelId === PANEL_ID) layout.selectPanel?.(null); } catch { /* noop */ }
          };
        }, 'dsh-source-inbox: workbench panel');
      },
    };
  },
});
