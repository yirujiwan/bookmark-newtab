/**
 * 书签面板（popup）
 *
 * 定位：拦截模式之外的「可控入口」。原生书签栏的点击行为扩展改不了，
 * 但这个面板里的每一次点击都由我们决定开在哪 —— 所以它是 100% 可靠的那条路。
 *
 * 渲染一律用 createElement + textContent，不拼 innerHTML：
 * 书签标题来自网页 <title>，属于不可信内容，拼字符串会有注入风险。
 *
 * 界面文案全部走 i18n.t()，跟随浏览器 UI 语言，不在代码里硬编码中英文。
 */

import { DEFAULTS, setSetting } from '../lib/settings.js';
import { applyStaticI18n, t, htmlLang } from '../lib/i18n.js';

const treeEl = document.getElementById('tree');
const qEl = document.getElementById('q');

/** 扁平化后的全部书签，供搜索使用 */
let flatBookmarks = [];

init();

async function init() {
  applyStaticI18n();

  await bindSettings();
  await renderTree();
  await renderDiag();

  qEl.addEventListener('input', () => {
    const kw = qEl.value.trim().toLowerCase();
    if (!kw) {
      void renderTree();
    } else {
      renderSearch(kw);
    }
  });

  // 单击 / Ctrl+单击 走 click；中键走 auxclick
  treeEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button.bm');
    if (!btn) return;
    const foreground = !(e.ctrlKey || e.metaKey || e.shiftKey);
    void openBookmark(btn.dataset.url, foreground);
  });

  treeEl.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const btn = e.target.closest('button.bm');
    if (!btn) return;
    e.preventDefault();
    void openBookmark(btn.dataset.url, false);
  });
}

/* ------------------------------ 设置 ------------------------------ */

async function bindSettings() {
  const settings = await chrome.storage.sync.get(DEFAULTS);

  for (const key of ['enabled', 'activateNewTab', 'skipPinned']) {
    const el = document.getElementById(key);
    if (!el) continue;
    el.checked = Boolean(settings[key]);
    el.addEventListener('change', () => {
      setSetting(key, el.checked).catch((err) => console.error('save setting failed', err));
    });
  }
}

/* ------------------------------ 渲染 ------------------------------ */

async function renderTree() {
  try {
    const [root] = await chrome.bookmarks.getTree();
    const top = root?.children ?? [];
    const visible = top.filter((n) => (n.children?.length ?? 0) > 0 || n.url);

    if (!visible.length) {
      renderEmpty(t('emptyNoBookmarks'));
      return;
    }

    treeEl.textContent = '';
    for (const node of visible) treeEl.appendChild(renderNode(node, 0));
    flatBookmarks = flatten(visible);
  } catch (err) {
    console.error('read bookmarks failed', err);
    renderEmpty(t('emptyReadFailed', err?.message ?? err));
  }
}

function renderNode(node, depth) {
  if (node.url) return renderBookmark(node);

  const details = document.createElement('details');
  details.className = 'folder';
  details.open = depth === 0; // 只默认展开第一层，深层保持折叠

  const summary = document.createElement('summary');
  const name = document.createElement('span');
  name.className = 'folder-name';
  name.textContent = node.title || t('untitledFolder');

  const count = document.createElement('span');
  count.className = 'folder-count';
  const total = countBookmarks(node);
  count.textContent = total ? String(total) : '';

  summary.append(name, count);
  details.appendChild(summary);

  const children = document.createElement('div');
  children.className = 'children';
  for (const child of node.children ?? []) children.appendChild(renderNode(child, depth + 1));
  details.appendChild(children);

  return details;
}

function renderBookmark(node) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'bm';
  btn.dataset.url = node.url;
  btn.title = `${node.title || node.url}\n${node.url}`;

  const title = document.createElement('span');
  title.className = 'bm-title';
  title.textContent = node.title || node.url;
  btn.appendChild(title);

  return btn;
}

function renderSearch(keyword) {
  const hits = flatBookmarks
    .filter((n) => {
      const t0 = (n.title || '').toLowerCase();
      return t0.includes(keyword) || n.url.toLowerCase().includes(keyword);
    })
    .slice(0, 120);

  treeEl.textContent = '';
  if (!hits.length) {
    renderEmpty(t('emptyNoMatch'));
    return;
  }
  for (const node of hits) treeEl.appendChild(renderBookmark(node));
}

function renderEmpty(text) {
  treeEl.textContent = '';
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = text;
  treeEl.appendChild(p);
}

/* ------------------------------ 诊断 ------------------------------ */

/**
 * 诊断区的作用：把「浏览器到底有没有把这次点击标成 auto_bookmark」
 * 变成肉眼可见的事实，而不是让用户对着「没反应」猜。
 * 记录只写在 chrome.storage.session（本机会话内存），关浏览器即清空，不上传。
 *
 * 后台存的是 reasonKey + reasonArgs（不是已翻译的句子），
 * 这样诊断区语言永远和当前界面一致，后台也不用碰文案。
 */
async function renderDiag() {
  const listEl = document.getElementById('diagList');
  if (!listEl) return;

  let events = [];
  try {
    const stored = await chrome.storage.session.get('diagEvents');
    events = Array.isArray(stored.diagEvents) ? stored.diagEvents : [];
  } catch (err) {
    console.warn('read diagnostics failed', err);
  }

  listEl.textContent = '';

  if (!events.length) {
    const p = document.createElement('p');
    p.className = 'diag-empty';
    p.textContent = t('diagEmptyText');
    listEl.appendChild(p);
    return;
  }

  for (const ev of events) listEl.appendChild(renderDiagItem(ev));
}

function renderDiagItem(ev) {
  const row = document.createElement('div');
  row.className = 'diag-item';

  const head = document.createElement('div');
  head.className = 'diag-head';

  const time = document.createElement('span');
  time.className = 'diag-time';
  time.textContent = new Date(ev.t).toLocaleTimeString(htmlLang(), { hour12: false });

  const tag = document.createElement('span');
  const opened = ev.result === 'opened';
  tag.className = 'diag-tag ' + (opened ? 'ok' : 'skip');
  tag.textContent =
    ev.result === 'opened' ? t('tagOpened')
      : ev.result === 'failed' ? t('tagFailed')
      : ev.result === 'other' ? t('tagOther')
      : t('tagSkipped');

  // 把浏览器给的原始 transitionType 显示出来：排错时这一列最关键
  const tt = document.createElement('span');
  tt.className = 'diag-tt';
  tt.textContent = ev.tt || t('ttNone');
  tt.title = t('ttTip');

  head.append(time, tag, tt);

  const reason = document.createElement('div');
  reason.className = 'diag-reason';
  // reasonKey 是新格式；reason 是 1.2.0 及更早留下的旧记录，兼容显示
  reason.textContent = ev.reasonKey
    ? t(ev.reasonKey, ...(ev.reasonArgs ?? []))
    : ev.reason || '';

  row.append(head, reason);

  if (ev.target) {
    const target = document.createElement('div');
    target.className = 'diag-url';
    target.textContent = ev.target;
    row.appendChild(target);
  }

  return row;
}

/* ------------------------------ 工具 ------------------------------ */

function countBookmarks(node) {
  let n = 0;
  for (const child of node.children ?? []) {
    if (child.url) n += 1;
    else n += countBookmarks(child);
  }
  return n;
}

function flatten(nodes, out = []) {
  for (const node of nodes) {
    if (node.url) out.push(node);
    else if (node.children) flatten(node.children, out);
  }
  return out;
}

async function openBookmark(url, foreground) {
  try {
    await chrome.tabs.create({ url, active: foreground });
    window.close();
  } catch (err) {
    console.error('open bookmark failed', err);
  }
}
