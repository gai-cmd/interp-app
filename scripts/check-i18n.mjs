// New implementation; static conventions supplement UI review, not a JS parser.
import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SUPPORTED_LANGUAGES } from '../app/i18n/index.js';
import { ERROR_CODES } from '../app/providers/contract.js';
import { SECURITY_CODES } from '../app/security/redact.js';

const rootDirectory = fileURLToPath(new URL('../', import.meta.url));
const keyPattern = /^[a-z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;
const placeholders = (value) => [...new Set([...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((m) => m[1]))].sort().join(',');

export function validateDictionaries(dictionaries) {
  const issues = [];
  const english = dictionaries.en;
  const validObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
  if (!validObject(english)) return ['I18N_INVALID_DICTIONARY'];
  const keys = Object.keys(english).sort();
  if (!keys.length) issues.push('I18N_EMPTY_DICTIONARY');
  for (const language of SUPPORTED_LANGUAGES) {
    const dictionary = dictionaries[language];
    if (!validObject(dictionary)) { issues.push('I18N_INVALID_DICTIONARY'); continue; }
    if (JSON.stringify(Object.keys(dictionary).sort()) !== JSON.stringify(keys)) issues.push('I18N_KEY_MISMATCH');
    for (const [key, value] of Object.entries(dictionary)) {
      if (!keyPattern.test(key) || typeof value !== 'string' || !value.trim()) {
        issues.push('I18N_INVALID_ENTRY');
        continue;
      }
      if (typeof english[key] === 'string' && placeholders(value) !== placeholders(english[key])) {
        issues.push('I18N_PLACEHOLDER_MISMATCH');
      }
    }
  }
  for (const key of ['error.unknown', ...ERROR_CODES.map((code) => `error.${code}`),
    ...SECURITY_CODES.map((code) => `error.${code}`)]) {
    if (!Object.hasOwn(english, key)) issues.push('I18N_MISSING_ERROR');
  }
  return [...new Set(issues)];
}

/**
 * Checked conventions: t('key'), data-i18n[-attribute]="key", and literal
 * label/notice/i18nKey properties. Dynamic keys require explicit has() tests.
 * Literal DOM text/HTML assignments and HTML text need dictionary keys.
 * This deliberately does not claim to parse all JavaScript or detect every
 * possible hardcoded UI string (computed assignments, aliases, templates).
 */
export function checkSource(source, dictionary, { html = false } = {}) {
  const issues = [];
  const patterns = [
    /\bt\(\s*(['"])([^'"\r\n]+)\1/g,
    /\b(?:label|notice|i18nKey)\s*:\s*(['"])([a-z][\w]*(?:\.[\w]+)+)\1/g,
    /\bdata-i18n(?:-[\w-]+)?\s*=\s*(['"])([^'"\r\n]+)\1/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (!Object.hasOwn(dictionary, match[2])) issues.push('I18N_UNKNOWN_UI_KEY');
    }
  }
  if (/\b(?:textContent|innerText|innerHTML|outerHTML)\s*=\s*(['"`])[^'"`]*[^\s'"`][^'"`]*\1/.test(source)
      || /\b(?:placeholder|title|ariaLabel)\s*=\s*(['"`])[^'"`]*[^\s'"`][^'"`]*\1/.test(source)
      || /\b(?:createTextNode|alert|confirm|prompt)\(\s*(['"`])[^'"`]+\1/.test(source)) {
    issues.push('I18N_LITERAL_UI_TEXT');
  }
  if (html) {
    const markup = source.replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    if (/>[^<]*[^\s<][^<]*</.test(markup)
        || /\b(?:title|placeholder|aria-label|alt)\s*=\s*(['"])[^'"]+\1/.test(markup)) {
      issues.push('I18N_LITERAL_UI_TEXT');
    }
  }
  return [...new Set(issues)];
}

async function sourceFiles(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const files = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink() || entry.name === 'i18n') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (/\.(?:js|mjs|html)$/.test(entry.name)) files.push(path);
  }
  return files;
}

export async function checkI18n({ root = rootDirectory } = {}) {
  try {
    const dictionaries = Object.fromEntries(await Promise.all(SUPPORTED_LANGUAGES.map(async (language) =>
      [language, JSON.parse(await readFile(resolve(root, `app/i18n/${language}.json`), 'utf8'))],
    )));
    const issues = validateDictionaries(dictionaries);
    if (issues.length) return { ok: false, issues };
    const files = await sourceFiles(resolve(root, 'app'));
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.html')) files.push(resolve(root, entry.name));
    }
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      for (const code of checkSource(source, dictionaries.en, { html: file.endsWith('.html') })) {
        issues.push({ code, file: relative(root, file) });
      }
    }
    return { ok: issues.length === 0, issues, keys: Object.keys(dictionaries.en).length, files: files.length };
  } catch {
    return { ok: false, issues: ['I18N_CHECK_FAILED'] };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await checkI18n();
  // Emit fixed diagnostic codes/counts only, never untrusted file contents.
  if (result.ok) console.log(`I18N_OK languages=3 keys=${result.keys} files=${result.files}`);
  else {
    for (const issue of result.issues) console.error(typeof issue === 'string' ? issue : issue.code);
    process.exitCode = 1;
  }
}
