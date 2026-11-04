#!/usr/bin/env node
/**
 * 文案一致性检查（只在开发时用，扩展运行时不依赖 Node）
 *
 * 检查三件事：
 *   1. 各语言 messages.json 的 key 集合是否一致（漏翻 = 界面回落到 default_locale）
 *   2. 代码里引用的 key 是否都有定义（少写/写错 = 界面直接显示 key）
 *   3. 同一 key 在两种语言里的 {0} {1} 占位符数量是否一致
 *      （多语言最常见的事故：译文漏了占位符，动态内容静默消失）
 *
 * 用法：node tools/check-i18n.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES_DIR = join(ROOT, '_locales');

const errors = [];
const warnings = [];

/* ---------------------------- 读取 ---------------------------- */

const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
const defaultLocale = manifest.default_locale;

if (!defaultLocale) {
  errors.push('manifest.json 缺少 default_locale');
}

const locales = readdirSync(LOCALES_DIR).filter((name) =>
  statSync(join(LOCALES_DIR, name)).isDirectory()
);

if (!locales.includes(defaultLocale)) {
  errors.push(`default_locale "${defaultLocale}" 在 _locales 下没有对应目录`);
}

/** locale -> { key -> message } */
const messages = new Map();
for (const locale of locales) {
  const file = join(LOCALES_DIR, locale, 'messages.json');
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const flat = new Map();
    for (const [key, value] of Object.entries(raw)) flat.set(key, value?.message ?? '');
    messages.set(locale, flat);
  } catch (err) {
    errors.push(`${locale}/messages.json 读取失败：${err.message}`);
  }
}

const base = messages.get(defaultLocale);
if (!base) {
  console.error('无法继续：default_locale 的 messages.json 不可用');
  process.exit(1);
}

/* ---------------------- 1. 语言间 key 对齐 ---------------------- */

for (const [locale, table] of messages) {
  if (locale === defaultLocale) continue;

  const missing = [...base.keys()].filter((k) => !table.has(k));
  const extra = [...table.keys()].filter((k) => !base.has(k));

  for (const k of missing) errors.push(`${locale} 缺少 key：${k}`);
  for (const k of extra) errors.push(`${locale} 多出 key（${defaultLocale} 里没有）：${k}`);
}

/* ------------------- 2. 代码引用的 key 是否定义 ------------------- */

/** 递归收集待扫描文件 */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (['.js', '.html', '.json'].includes(extname(p))) out.push(p);
  }
  return out;
}

const targets = [join(ROOT, 'manifest.json'), ...walk(join(ROOT, 'src'))];

const used = new Map(); // key -> 首次出现的文件（用于报错定位）

function record(key, file) {
  if (!key || key.startsWith('@@')) return; // @@ui_locale 之类是浏览器内置的
  if (!used.has(key)) used.set(key, file);
}

for (const file of targets) {
  const text = readFileSync(file, 'utf8');
  const rel = file.slice(ROOT.length + 1);

  // manifest：__MSG_xxx__
  for (const m of text.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) record(m[1], rel);

  // 静态标记：data-i18n / data-i18n-placeholder / -title / -aria-label
  for (const m of text.matchAll(/data-i18n(?:-[a-z-]+)?="([A-Za-z0-9_]+)"/g)) record(m[1], rel);

  // 代码：t('key')
  for (const m of text.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/g)) record(m[1], rel);

  // 代码：reasonKey: 'reason_xxx'
  for (const m of text.matchAll(/reasonKey:\s*'([A-Za-z0-9_]+)'/g)) record(m[1], rel);

  // 三元表达式里的裸字面量：restored ? 'reason_opened' : 'reason_openedRestoreFailed'
  for (const m of text.matchAll(/'((?:reason|tag|tt|opt|empty|diag|popup|search|tree|loading|hint|untitled|ext|action)_[A-Za-z0-9_]+)'/g)) {
    record(m[1], rel);
  }
}

for (const [key, file] of used) {
  if (!base.has(key)) errors.push(`${file} 引用了未定义的 key：${key}`);
}

// 定义但没被引用：多为改名后的残留，提醒但不拦截
for (const key of base.keys()) {
  if (!used.has(key)) warnings.push(`key 已定义但代码里没有引用：${key}`);
}

/* ----------------------- 3. 占位符对齐 ----------------------- */

const placeholders = (text) => new Set([...text.matchAll(/\{(\d+)\}/g)].map((m) => m[1]));

for (const [locale, table] of messages) {
  if (locale === defaultLocale) continue;
  for (const [key, text] of table) {
    if (!base.has(key)) continue;
    const want = placeholders(base.get(key));
    const got = placeholders(text);
    for (const idx of want) {
      if (!got.has(idx)) {
        errors.push(`${locale}/${key} 缺少占位符 {${idx}}（译文会吞掉动态内容）`);
      }
    }
    for (const idx of got) {
      if (!want.has(idx)) {
        errors.push(`${locale}/${key} 多出占位符 {${idx}}（${defaultLocale} 里没有）`);
      }
    }
  }
}

/* --------------------------- 输出 --------------------------- */

console.log(`语言：${locales.join(' / ')}（default: ${defaultLocale}）`);
console.log(`key 总数：${base.size}，代码引用：${used.size}`);

for (const w of warnings) console.log(`  ⚠ ${w}`);

if (errors.length) {
  console.log('');
  for (const e of errors) console.log(`  ✗ ${e}`);
  console.log(`\n检查未通过：${errors.length} 个问题`);
  process.exit(1);
}

console.log('\n✓ 文案检查通过');
