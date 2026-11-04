/**
 * 书签新标签打开 —— 后台服务（MV3 Service Worker）
 * ==============================================
 *
 * 【关键实测结论（别改成想当然的写法）】
 * webNavigation.onBeforeNavigate 的事件对象里【没有 transitionType 字段】。
 * 实测 keys 只有：documentLifecycle / frameId / frameType / parentFrameId /
 * processId / tabId / timeStamp / url。
 * 类型判定字段 transitionType / transitionQualifiers 只在 onCommitted 才有。
 * 所以「在 onBeforeNavigate 里判断是不是书签点击」这条路走不通（写过一版，线上完全不生效）。
 *
 * 【现在的做法】
 * 1. onBeforeNavigate：只记录这次导航的目标（此刻标签页的 URL 还是「原来的页面」）。
 * 2. onCommitted：拿到 transitionType。如果是 auto_bookmark（书签栏、收藏夹菜单、
 *    书签管理器发起的导航都是这个值），说明用户点了书签：
 *      a. 立刻把目标页新开到相邻标签（默认切过去，焦点离开原标签）；
 *      b. 原标签 goBack 回上一页 —— 走 bfcache，滚动位置和页面状态都还在。
 *    先开新标签再回退，是为了让用户视线已经移走，看不到回退动作。
 *
 * 【为什么不是零感知】
 * 浏览器的 committed 事件是「导航已提交」的时刻，B 页面已经开始加载。
 * 我们把焦点切到新标签后再回退，观感上是「点了书签 → 新标签打开了」，
 * 原页面完好。若关闭「新标签切到前台」，才会看到原标签闪一下。
 *
 * 【MV3 约束备忘】
 * - service worker 随时会被回收，内存 Map 只是加速与去抖，丢了有 tabs.get 兜底。
 * - 所有 chrome.* 事件监听器必须在模块顶层同步注册，否则 SW 重启后会漏事件。
 */

import { getCachedSettings, getSettings } from './lib/settings.js';

/** 同一标签页在这个时间窗内只处理一次，防止 goBack 造成的连锁事件重复处理 */
const DEBOUNCE_MS = 1500;

/** 只处理真正的网页目标（书签也可能是 edge:// 或 javascript:，那些不碰） */
const WEB_URL_RE = /^(https?|file):/i;

/** 空白页特征前缀：当前标签是这类页面时不需要保护，直接在里面打开更自然 */
const BLANK_PREFIXES = [
  'about:blank',
  'chrome://newtab',
  'edge://newtab',
  'edge://start',
  'edge://ntp',
  'chrome-search://local-ntp'
];

/** 诊断记录（chrome.storage.session：浏览器关掉就没了，绝不落盘、绝不上传） */
const DIAG_KEY = 'diagEvents';
const DIAG_LIMIT = 10;
const URL_MAX = 180;

/** tabId -> 最后一次「已提交」的主框架 URL，也就是用户眼前这一页 */
const committedUrl = new Map();
/** tabId -> 正在进行中的导航 { target, origin, at } */
const pendingNav = new Map();
/** tabId -> 上次处理的时间戳 */
const handledAt = new Map();

function isWebUrl(url) {
  return typeof url === 'string' && WEB_URL_RE.test(url);
}

function isBlankUrl(url) {
  if (!url) return true;
  const u = url.toLowerCase();
  return BLANK_PREFIXES.some((p) => u.startsWith(p));
}

function trimUrl(url) {
  if (typeof url !== 'string') return '';
  return url.length > URL_MAX ? `${url.slice(0, URL_MAX)}…` : url;
}

function markHandled(tabId) {
  handledAt.set(tabId, Date.now());
  if (handledAt.size > 40) {
    const cutoff = Date.now() - 5000;
    for (const [id, ts] of handledAt) if (ts < cutoff) handledAt.delete(id);
  }
}

/** 拦截成功时让工具栏图标闪一下 ✓，用户一眼能确认「这次被接住了」 */
let badgeTimer = null;
function flashBadge() {
  try {
    void chrome.action.setBadgeBackgroundColor({ color: '#1e8e3e' });
    void chrome.action.setBadgeText({ text: '✓' });
    if (badgeTimer) clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => {
      void chrome.action.setBadgeText({ text: '' });
      badgeTimer = null;
    }, 2500);
  } catch {
    /* 图标不在工具栏上也无关紧要 */
  }
}

/** 记一条诊断。fire-and-forget，绝不在热路径上 await 存储 */
function logDiag(entry) {
  void (async () => {
    try {
      const stored = await chrome.storage.session.get(DIAG_KEY);
      const list = Array.isArray(stored[DIAG_KEY]) ? stored[DIAG_KEY] : [];
      list.unshift(entry);
      await chrome.storage.session.set({ [DIAG_KEY]: list.slice(0, DIAG_LIMIT) });
    } catch {
      /* session storage 不可用时静默：诊断不能影响主功能 */
    }
  })();
}

/* ------------------------------------------------------------------ */
/* 监听器（必须顶层同步注册）                                            */
/* ------------------------------------------------------------------ */

// 兜底维护「当前已提交 URL」：只认 status === 'complete'，不用 changeInfo.url。
// changeInfo.url 可能在导航尚未提交时就变，会把「原页面」污染成「目标页」。
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) committedUrl.set(tabId, tab.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  committedUrl.delete(tabId);
  pendingNav.delete(tabId);
  handledAt.delete(tabId);
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  if (!isWebUrl(details.url)) return;

  const entry = { target: details.url, origin: committedUrl.get(details.tabId) || '', at: Date.now() };
  pendingNav.set(details.tabId, entry);

  // 缓存缺失（扩展刚重载、标签是别处开的）时补一次；此刻 tab.url 还是旧页面
  if (!entry.origin) {
    chrome.tabs
      .get(details.tabId)
      .then((tab) => {
        if (tab?.url && pendingNav.get(details.tabId) === entry) entry.origin = tab.url;
      })
      .catch(() => {});
  }
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  void handleCommitted(details);
});

/* ------------------------------------------------------------------ */
/* 判断：该不该拦（集中在一处，同时在诊断里给出现成的原因）                 */
/* ------------------------------------------------------------------ */

/**
 * 返回的是 _locales 里的文案 key（reasonKey），不是翻好的句子。
 * service worker 不知道自己该说哪种语言 —— 界面语言是 popup 那边的事，
 * 所以这里只给 key，由 popup 用 chrome.i18n 翻成当前界面语言。
 * 需要插入动态内容的（如错误信息）放 reasonArgs，对应文案里的 {0} {1}。
 */
function decide({ targetUrl, originUrl, tab, settings }) {
  if (!isWebUrl(targetUrl)) return { ok: false, reasonKey: 'reason_notWeb' };
  if (!settings.enabled) return { ok: false, reasonKey: 'reason_disabled' };
  if (!originUrl) return { ok: false, reasonKey: 'reason_noOrigin' };
  if (originUrl === targetUrl) return { ok: false, reasonKey: 'reason_sameUrl' };
  if (settings.skipPinned && tab.pinned) return { ok: false, reasonKey: 'reason_pinned' };
  if (isBlankUrl(originUrl)) return { ok: false, reasonKey: 'reason_blank' };
  if (!isWebUrl(originUrl)) return { ok: false, reasonKey: 'reason_internal' };
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 主逻辑                                                              */
/* ------------------------------------------------------------------ */

async function handleCommitted(details) {
  const tabId = details.tabId;
  const targetUrl = details.url;
  const transitionType = details.transitionType;
  const at = Date.now();

  const pending = pendingNav.get(tabId);
  pendingNav.delete(tabId);

  // 先把「原来的页面」取出来，再把缓存更新成新地址
  const originUrl = committedUrl.get(tabId) || pending?.origin || '';
  committedUrl.set(tabId, targetUrl);

  // 扩展自己的页面（popup / options）不记录：
  // 否则每次打开诊断面板，面板自身的加载都会往诊断区塞一条「非书签」记录，
  // 把真正要看的那几条挤下去。这一条是实测截图时发现的。
  if (targetUrl.startsWith(`chrome-extension://${chrome.runtime.id}/`)) return;

  // 只关心书签发起的导航；其余类型不插手，但要留一条旁证：
  // 万一某个版本把书签点击报成了别的类型，用户打开面板就能直接看到实际值，不用猜。
  if (transitionType !== 'auto_bookmark') {
    logDiag({
      t: at,
      tt: transitionType || '',
      target: trimUrl(targetUrl),
      origin: trimUrl(originUrl),
      result: 'other',
      reasonKey: 'reason_notBookmark'
    });
    return;
  }

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    logDiag({ t: at, tt: transitionType, target: trimUrl(targetUrl), origin: '', result: 'skipped', reasonKey: 'reason_tabClosed' });
    return;
  }
  if (!tab || tab.id === undefined || tab.id < 0) return;

  const last = handledAt.get(tabId) ?? 0;
  if (Date.now() - last < DEBOUNCE_MS) return;

  const settings = getCachedSettings() ?? (await getSettings());
  const verdict = decide({ targetUrl, originUrl, tab, settings });

  if (!verdict.ok) {
    logDiag({
      t: at,
      tt: transitionType,
      target: trimUrl(targetUrl),
      origin: trimUrl(originUrl),
      result: 'skipped',
      reasonKey: verdict.reasonKey
    });
    return;
  }

  markHandled(tabId);
  flashBadge();

  // 第 1 步：把目标页新开到相邻标签。默认切到前台，用户视线跟着走，
  // 后面原标签的回退动作就发生在后台，几乎看不到。
  let created = null;
  try {
    created = await chrome.tabs.create({
      url: targetUrl,
      active: settings.activateNewTab,
      index: tab.index + 1,
      windowId: tab.windowId
    });
  } catch (err) {
    const msg = err?.message ?? String(err);
    console.warn('[书签新标签] 新开标签失败，保持原地打开：', msg);
    logDiag({ t: at, tt: transitionType, target: trimUrl(targetUrl), origin: trimUrl(originUrl), result: 'failed', reasonKey: 'reason_createFailed', reasonArgs: [msg] });
    return;
  }

  // 第 2 步：原标签退回上一页。优先 goBack —— 走 bfcache，页面状态和滚动位置都保留；
  // 失败（比如历史里没有上一页）再退回用 URL 重新导航。
  let restored = false;
  try {
    await chrome.tabs.goBack(tabId);
    restored = true;
  } catch {
    try {
      await chrome.tabs.update(tabId, { url: originUrl });
      restored = true;
    } catch (err) {
      console.warn('[书签新标签] 还原原页面失败：', err?.message ?? err);
    }
  }

  // goBack 失败也要把缓存改回原页面，否则下次判断会用错「原页面」
  if (restored) committedUrl.set(tabId, originUrl);

  logDiag({
    t: at,
    tt: transitionType,
    target: trimUrl(targetUrl),
    origin: trimUrl(originUrl),
    result: 'opened',
    reasonKey: restored ? 'reason_opened' : 'reason_openedRestoreFailed'
  });

  void created;
}
