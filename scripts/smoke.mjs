/**
 * Render smoke test. Loads docs/index.html in jsdom against the real
 * docs/data.json, clicks through every tab, and fails on any console error or
 * empty view. Dev-only: run it after changing the dashboard.
 *
 *   npm i --no-save jsdom && node scripts/smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(ROOT, 'docs/index.html'), 'utf8');
const data = readFileSync(resolve(ROOT, 'docs/data.json'), 'utf8');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.stack || e.message)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'http://localhost/',
  virtualConsole: vc,
  pretendToBeVisual: true,
  beforeParse(win) {
    win.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(JSON.parse(data)) });
    // jsdom has no CSS.supports-level color-mix, but nothing in the page reads it back.
  },
});

await new Promise((r) => setTimeout(r, 400));

const { document } = dom.window;
const app = document.querySelector('#app');
const tabs = [...document.querySelectorAll('.tab')];

if (!tabs.length) errors.push('no tabs rendered');
if (/Loading data.json/.test(app.textContent)) errors.push('data never loaded');

const subtitle = document.querySelector('#subtitle').textContent;
console.log('subtitle:', subtitle);

for (const tab of tabs) {
  tab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  const name = tab.dataset.tab;
  const text = app.textContent.trim();
  const rows = app.querySelectorAll('tbody tr').length;
  const cards = app.querySelectorAll('.card').length;
  const stats = app.querySelectorAll('.stat').length;
  if (text.length < 80) errors.push(`tab ${name} rendered almost nothing (${text.length} chars)`);
  console.log(`tab ${name.padEnd(10)} chars=${String(text.length).padEnd(6)} stats=${String(stats).padEnd(3)} rows=${String(rows).padEnd(4)} cards=${cards}`);
}

// Exercise the sort handlers on the All tab, since they re-render the table.
document.querySelector('[data-tab="all"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
const ths = [...app.querySelectorAll('th')];
for (const th of ths) th.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
console.log(`clicked ${ths.length} sort headers, ${app.querySelectorAll('tbody tr').length} rows still present`);

// And the filters.
const search = app.querySelector('input[type="search"]');
search.value = 'zao';
search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
console.log('filter "zao" ->', app.querySelector('.count').textContent);

if (errors.length) {
  console.error('\nFAILED:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\nsmoke test passed');
