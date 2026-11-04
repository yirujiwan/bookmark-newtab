/**
 * 设置读写模块（background 与 popup 共用）
 *
 * 决策说明：设置存在 chrome.storage.sync 而不是 localStorage。
 * - localStorage 在 MV3 的 service worker 里根本不存在，会在启动时直接报错；
 * - sync 还能跟随 Edge 账号在多台设备间同步开关状态。
 * 本模块内做了一层内存缓存，避免每条导航事件都去读一次磁盘。
 */

export const DEFAULTS = Object.freeze({
  /** 总开关：点书签时是否保护当前标签页 */
  enabled: true,
  /** 新开的标签是否立刻切到前台（false = 后台打开，不打断当前阅读） */
  activateNewTab: true,
  /** 固定的标签页是否跳过保护（固定标签通常是有意长期停留的页面，用户可能就想在原地打开） */
  skipPinned: false
});

let cache = null;

// service worker 启动时执行一次；设置一变就失效缓存，下次事件重新读取
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (Object.keys(changes).some((k) => k in DEFAULTS)) cache = null;
});

/**
 * 同步取缓存（可能为 null）。
 * 拦截逻辑在 onBeforeNavigate 里执行，每省一次 await 就少一点「目标页抢先渲染」的机会，
 * 所以热路径优先用这个。
 */
export function getCachedSettings() {
  return cache;
}

// service worker 一起来就预热，让第一个书签事件也尽量走缓存
void getSettings();

/** 读取全部设置（带默认值兜底） */
export async function getSettings() {
  if (cache) return cache;
  const stored = await chrome.storage.sync.get(DEFAULTS);
  cache = { ...DEFAULTS, ...stored };
  return cache;
}

/** 写入单个设置项 */
export async function setSetting(key, value) {
  if (!(key in DEFAULTS)) throw new Error(`未知设置项：${key}`);
  await chrome.storage.sync.set({ [key]: value });
  cache = null;
}
