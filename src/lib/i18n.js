/**
 * 界面文案的读取与占位符替换
 *
 * 所有用户可见文案都放在 _locales/<locale>/messages.json，
 * 浏览器按 UI 语言自动挑一份，代码里只留 key。
 *
 * 占位符统一写成 {0} {1}，不用官方的 $1$：
 * `$` 在 messages.json 里是保留语法（缺配对会让清单校验报警告），
 * 自己替换反而干净可控。
 */

/**
 * 取一条文案。
 * @param {string} key messages.json 里的键
 * @param {...unknown} args 按顺序替换 {0} {1} …
 * @returns {string}
 */
export function t(key, ...args) {
  let text = '';
  try {
    text = chrome.i18n.getMessage(key) || '';
  } catch {
    /* 不在扩展上下文（比如直接用浏览器打开 popup.html）时走下面的兜底 */
  }

  // 漏翻时把 key 露出来，比显示空白更容易被发现
  if (!text) return key;
  if (!args.length) return text;

  return text.replace(/\{(\d+)\}/g, (whole, i) => {
    const value = args[Number(i)];
    return value === undefined ? whole : String(value);
  });
}

/** 当前界面语言，如 zh_CN / en */
export function uiLocale() {
  try {
    return chrome.i18n.getMessage('@@ui_locale') || 'en';
  } catch {
    return 'en';
  }
}

/** BCP 47 形式（zh_CN → zh-CN），给 toLocaleTimeString 之类用 */
export function htmlLang() {
  return uiLocale().replace('_', '-');
}

/**
 * 把 HTML 里标了 data-i18n* 的节点填上对应文案。
 * 静态骨架留在 HTML 里、文案全部来自 messages.json，
 * 这样加一门语言不需要动 HTML。
 */
export function applyStaticI18n(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n);
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
  }
  for (const el of root.querySelectorAll('[data-i18n-aria-label]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  }

  document.documentElement.lang = htmlLang();
  document.title = t('popupTitle');
}
