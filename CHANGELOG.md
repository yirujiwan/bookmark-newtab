# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versioning follows [Semantic Versioning](https://semver.org/).

## [1.3.1] - 2026-11-04

### Fixed
- The diagnostics panel was polluting itself: opening the popup navigated a tab to
  the extension's own page, which `onCommitted` logged as a "not a bookmark" entry,
  pushing the entries you actually wanted to read off the list. The extension's own
  pages are now skipped before any logging happens.

### Added
- Panel screenshots in `docs/` (`popup-en.png`, `popup-zh.png`), embedded in both READMEs.

## [1.3.0] - 2026-11-04

### Added
- **Full UI localization.** Everything the user can read in the popup now comes from
  `_locales`, so the panel follows the browser UI language instead of being
  Chinese-only. English is the fallback (`default_locale`).
- The service worker no longer stores translated sentences in the diagnostics log.
  It stores a message key plus arguments, and the popup resolves them at render
  time, so diagnostics always match the current UI language.
- A key-consistency check (`npm run check` / `node tools/check-i18n.mjs`) that fails
  when the locales drift apart or when code references a key that no locale defines.

### Changed
- UI strings in `popup.html` are placeholders for the `en` locale; the real values
  live in `messages.json`.
- Popup CSS tolerates longer English labels (wrapping in the settings rows, ellipsis
  in the diagnostics header) so nothing overflows the 360 px panel.
- Diagnostics timestamps render in the UI locale rather than being pinned to `zh-CN`.

## [1.2.0] - 2026-11-04

### Fixed
- **The extension never actually worked.** v1.0.0 / v1.1.0 read `transitionType`
  from `webNavigation.onBeforeNavigate`, which does not expose that field at all.
  The guard `transitionType !== 'auto_bookmark'` was therefore always true and the
  handler returned on every navigation. Navigation typing is now read from
  `onCommitted`, which is the earliest event that carries it.
- Restoring the original page now uses `tabs.goBack()` instead of re-navigating to
  the URL, so the page comes back from bfcache with its scroll position and DOM
  state intact.

### Added
- Diagnostics panel in the popup: last 10 main-frame navigations with the raw
  `transitionType` reported by the browser and the reason each one was or was not
  handled. Makes "it does nothing" diagnosable instead of guesswork.
- Toolbar badge flashes `✓` when a bookmark click is caught.
- `_locales` (en / zh_CN) so the extension name and description are localized.

## [1.1.0] - 2026-11-04

### Added
- Diagnostics records and badge feedback (diagnostics were empty at this point,
  because the handler never ran — see 1.2.0).
- Documentation covering the bookmarks bar and the bookmarks menu as entry points.

## [1.0.0] - 2026-11-04

### Added
- Initial release: intercept bookmark navigations (attempted via `onBeforeNavigate`),
  open the target in a new tab, restore the original page.
- Toolbar popup listing the bookmark tree with search, so bookmarks can always be
  opened in a new tab through a path that does not depend on browser internals.
- Settings: master switch, open in foreground, skip pinned tabs.
