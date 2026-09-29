// New implementation of docs/extension.md §3.1 and §7.3; no legacy code is ported.
// The two documentation URLs the options page links to. They duplicate app/config.js DOCUMENTATION_LINKS
// (apiKeyCreate, apiKeyUsage) because extension/lib may not import app/config.js (R4); the parity test in
// tests/extension-options.test.mjs keeps the two copies equal. They are navigation targets, never fetched.
export const KEY_GUIDE_URL = 'https://aistudio.google.com/apikey';
export const KEY_USAGE_URL = 'https://ai.google.dev/gemini-api/docs/api-key';
