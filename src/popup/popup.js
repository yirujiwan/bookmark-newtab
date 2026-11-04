/**
 * 书签面板（popup）
 *
 * 定位：拦截模式之外的「可控入口」。原生书签栏的点击行为扩展改不了，
 * 但这个面板里的每一次点击都由我们决定开在哪 —— 所以它是 100% 可靠的那条路。
 *
 * 渲染一律用 createElement + textContent，不拼 innerHTML：
 * 书签标题来自网页 <title>，属于不可信内容，拼字符串会有注入风险。
 */

import { DEFAULTS, setSetting } from '../lib/settings.js';

const treeEl = document.getElementById('tree');
const qEl = document.getElementById('q');

/** 扁平化后的全部书签，供搜索使用 */
let flatBookmarks = [];

init();

async function init() {
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
    el.checked = Boolean(settings[key]);
    el.addEventListener('change', () => {
      setSetting(key, el.checked).catch((err) => console.error('保存设置失败', err));
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
      renderEmpty('还没有书签');
      return;
    }

    treeEl.textContent = '';
    for (const node of visible) treeEl.appendChild(renderNode(node, 0));
    flatBookmarks = flatten(visible);
  } catch (err) {
    console.error('读取书签失败', err);
    renderEmpty('读取书签失败：' + (err?.message ?? err));
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
  name.textContent = node.title || '未命名文件夹';

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
      const t = (n.title || '').toLowerCase();
      return t.includes(keyword) || n.url.toLowerCase().includes(keyword);
    })
    .slice(0, 120);

  treeEl.textContent = '';
  if (!hits.length) {
    renderEmpty('没有匹配的书签');
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
 */
async function renderDiag() {
  const listEl = document.getElementById('diagList');
  if (!listEl) return;

  let events = [];
  try {
    const stored = await chrome.storage.session.get('diagEvents');
    events = Array.isArray(stored.diagEvents) ? stored.diagEvents : [];
  } catch (err) {
    console.warn('读取诊断记录失败', err);
  }

  listEl.textContent = '';

  if (!events.length) {
    const p = document.createElement('p');
    p.className = 'diag-empty';
    p.textContent =
      '还没有记录到书签点击。点一下收藏夹栏或顶部「收藏夹」菜单里的书签，再打开这里查看。' +
      '如果这里一直为空，说明你这版浏览器没有把书签点击标成 auto_bookmark。';
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
  time.textContent = new Date(ev.t).toLocaleTimeString('zh-CN', { hour12: false });

  const tag = document.createElement('span');
  const opened = ev.result === 'opened';
  tag.className = 'diag-tag ' + (opened ? 'ok' : 'skip');
  tag.textContent =
    ev.result === 'opened' ? '已新开'
      : ev.result === 'failed' ? '失败'
      : ev.result === 'other' ? '非书签'
      : '未处理';

  // 把浏览器给的原始 transitionType 显示出来：排错时这一列最关键
  const tt = document.createElement('span');
  tt.className = 'diag-tt';
  tt.textContent = ev.tt || '无类型';
  tt.title = '浏览器上报的导航类型（transitionType）。书签点击应为 auto_bookmark';

  head.append(time, tag, tt);

  const reason = document.createElement('div');
  reason.className = 'diag-reason';
  reason.textContent = ev.reason || '';

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
    console.error('打开书签失败', err);
  }
}
