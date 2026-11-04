# Bookmark New Tab

**English** | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Manifest: V3](https://img.shields.io/badge/Manifest-V3-success.svg)](manifest.json)

A Chrome / Edge extension that opens bookmarks in a **new tab** instead of
replacing the page you are currently reading.

It intercepts clicks on the browser's *own* bookmarks bar and **Bookmarks** menu.
You keep using your bookmarks exactly as before — there is no replacement panel
to learn, and no change to how you browse.

---

## The problem

Left-clicking a bookmark navigates the current tab away from whatever you were
reading. It is one of those things that costs you a page every time: a half-filled
form, a long article at paragraph 40, a dashboard you were watching.

Middle-click opens a new tab, but that is a different mouse gesture, and
`Ctrl`/`Cmd`+click needs a keyboard. Browsers do not expose a setting for this.

## What it does

| Action | Result |
| --- | --- |
| Click a bookmark on the bookmarks bar | Opens in a new tab, page stays |
| Click a bookmark in the **Bookmarks** menu | Opens in a new tab, page stays |
| Click a bookmark while on a blank new tab | Opens right there — no pointless second tab |
| Click a bookmark on a pinned tab | Native behaviour (configurable) |

The original page comes back from bfcache, so **scroll position and page state
survive**. It is not a reload.

## How it works

Extensions cannot listen for bookmark clicks: the bookmarks bar is `chrome://` UI
and content scripts cannot be injected into it. But Chromium tags every navigation
started from a bookmark with `transitionType === 'auto_bookmark'`. That is the hook.

### The gotcha that made v1.0 dead on arrival

`webNavigation.onBeforeNavigate` does **not** carry `transitionType`.

Measured on Edge 156, the event object has exactly these keys:

```
documentLifecycle, frameId, frameType, parentFrameId,
processId, tabId, timeStamp, url
```

The navigation type only appears in `onCommitted` (and later events). So a guard
like `if (details.transitionType !== 'auto_bookmark') return;` written inside
`onBeforeNavigate` is **always true** — the handler returns on every navigation, and
the extension sits there enabled, doing nothing, with an empty diagnostics panel,
because it never even reaches the logging code.

### The actual flow

1. **`onBeforeNavigate`** — record where this tab is going. The tab still shows the
   previous page at this point, so the old URL is the one to restore.
2. **`onCommitted`** — read `transitionType`. If it is `auto_bookmark`:
   - create the target in a new tab next to the current one, foreground by default
     so your attention moves first;
   - `tabs.goBack()` the original tab, restoring it from bfcache.
3. Every other transition type is left completely alone.

`committed` is the earliest moment the type is available, which means the target
page has already started loading. Focusing the new tab first keeps the rollback
invisible. Turn *activate new tab* off and you will see the original tab flicker.

## Install (unpacked)

1. Open `edge://extensions` (or `chrome://extensions`)
2. Turn on **Developer mode**
3. Click **Load unpacked** and select this folder
4. Pin the extension to the toolbar

| Permission | Why |
| --- | --- |
| Read and change your data on all websites | Required for `webNavigation` to report full URLs; without it the details are redacted |
| Read and change your bookmarks | Renders the bookmark tree in the popup. Bookmarks are never modified — read-only |

No network requests, no analytics, no remote storage. All of `src/` is small enough
to read in a few minutes.

## Usage

- Clicking any bookmark in the browser opens it in a new tab.
- The toolbar popup is a second, independent path: bookmark tree plus search,
  single click opens in a new tab, middle click or `Ctrl`/`Cmd`+click opens in the
  background. It does not depend on the browser's navigation tagging, so it keeps
  working even if a future version changes it.

## Settings

Stored in `chrome.storage.sync` and follow your profile across devices.

| Setting | Default | Description |
| --- | --- | --- |
| Open bookmarks in a new tab | On | Master switch; off restores native behaviour |
| Activate the new tab | On | Off = open in background, stay on the current page |
| Skip pinned tabs | Off | On = pinned tabs keep native behaviour |

## Diagnostics

Open the popup and expand **Diagnostics** at the bottom. It lists the last 10
main-frame navigations with the raw `transitionType` reported by the browser and
the reason each one was or was not handled.

| What you see | Meaning | What to do |
| --- | --- | --- |
| `auto_bookmark`, handled | Working | Nothing |
| `auto_bookmark`, skipped + reason | Caught, then rejected by a rule | Follow the reason (e.g. turn off *skip pinned tabs*) |
| Your click shows as `link` / `typed` | This build does not tag bookmark clicks | Interception cannot work — use the popup, and please report the value |
| Nothing at all | The event never reached the extension | Reload the extension; check the service worker console |

A `✓` flash on the toolbar icon means that click was caught. Records live in
`chrome.storage.session` — cleared when the browser closes, never uploaded. They do
contain the URLs you recently visited, locally.

## Limitations

- **Not zero-flicker.** The target page commits before it is rolled back. With
  *activate new tab* on, this is imperceptible; with it off you will see a flicker.
- **Cannot intercept the bookmark context menu** ("Open in new tab" and friends).
  That is native UI with no extension hook.
- **Does not modify your bookmarks.** Read-only, always.
- **Sub-frame navigations are ignored** on purpose — only top-level navigations of
  the tab are relevant here.

## Compatibility

Built and verified against **Microsoft Edge 156 (Chromium 156)** on macOS.
Requires Chromium 110+ (`minimum_chrome_version`). Interception relies on a Chromium
behaviour rather than a public contract, so it is verified rather than guaranteed —
if a build stops reporting `auto_bookmark`, the Diagnostics panel says so explicitly
instead of failing silently.

## Privacy

No network requests, no telemetry, no third-party services. The `bookmarks`
permission is used only to render the popup list; nothing is written back.
Navigation URLs stay in `chrome.storage.session` and disappear with the session.

## Localization

The panel follows the **browser UI language** automatically — no setting to flip.

- Chinese browsers get Chinese
- everything else falls back to English (`default_locale` is `en`)

No user-facing string is hardcoded in JS or HTML. All of them live in
`_locales/<locale>/messages.json`, and the HTML only carries `data-i18n` markers.

The service worker does not store translated sentences either: the diagnostics log
keeps a message key (`reason_opened`) plus arguments, and the popup resolves them at
render time. Switch languages and the history reads correctly in the new language.

**Adding a third language** (Japanese, say): copy `_locales/en` to `_locales/ja`,
translate the `message` values, keep every key untouched, then reload the extension
in the browser. No code changes.

**Consistency check** (dev only):

```bash
node tools/check-i18n.mjs   # or: npm run check
```

It verifies that locales define the same keys, that every key referenced in code
exists, and that `{0}` placeholders match across languages — a missing placeholder
is the classic way translated strings silently swallow dynamic content.

## Project structure

```
bookmark-newtab/
├── manifest.json            # MV3 manifest (localized name/description)
├── _locales/
│   ├── en/messages.json     # name, description, every UI string
│   └── zh_CN/messages.json
├── icons/                   # 16 / 48 / 128 px
├── src/
│   ├── background.js        # onCommitted → auto_bookmark → new tab + goBack
│   ├── lib/
│   │   ├── settings.js      # storage.sync wrapper with in-memory cache
│   │   └── i18n.js          # message lookup + {0} placeholder substitution
│   └── popup/               # skeleton + data-i18n markers, no hardcoded copy
├── tools/check-i18n.mjs     # dev-only key consistency check
├── package.json             # only for `npm run check`; the extension has no build step
├── CHANGELOG.md
├── LICENSE
├── README.md
└── README.zh-CN.md
```

Three places matter if you want to change behaviour:

- `src/background.js` — constants at the top, plus `handleCommitted()` and `decide()`
- `src/lib/settings.js` — `DEFAULTS`; add a checkbox in `src/popup/popup.html` to expose it
  (add the label to both `messages.json` files)
- `_locales/*/messages.json` — all copy, no code touched

## Contributing

Issues and pull requests are welcome. The most useful bug report includes your
browser version and the `transitionType` your build reports for a bookmark click —
that is the one field everything here hinges on.

If you want to add a language, only `_locales/` needs to change; run
`node tools/check-i18n.mjs` before opening the PR.

## License

[MIT](LICENSE)
