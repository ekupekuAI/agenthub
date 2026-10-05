// Captures the main pages in dark and light themes at desktop and phone sizes, using the
// system Microsoft Edge (no browser download). Start a seeded server first, then:
//   CAPTURE_BASE_URL=http://localhost:3000 node scripts/capture.mjs
// Screenshots are written to .data/shots/.
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const BASE_URL = process.env.CAPTURE_BASE_URL ?? 'http://localhost:3000';
const OUT_DIR = fileURLToPath(new URL('../.data/shots/', import.meta.url));

const PAGES = [
  { name: 'home', path: '/' },
  { name: 'skill', path: '/skills/web-testing' },
  { name: 'guidelines', path: '/guidelines' },
  { name: 'publish', path: '/publish' },
  { name: 'admin', path: '/admin' },
];
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];
const THEMES = ['dark', 'light'];

mkdirSync(OUT_DIR, { recursive: true });
const { hostname } = new URL(BASE_URL);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const written = [];

try {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      await context.addCookies([
        { name: 'agenthub-theme', value: theme, domain: hostname, path: '/' },
      ]);
      const page = await context.newPage();
      for (const target of PAGES) {
        await page.goto(new URL(target.path, BASE_URL).href, { waitUntil: 'networkidle' });
        const file = `${OUT_DIR}${target.name}-${viewport.name}-${theme}.png`;
        await page.screenshot({ path: file });
        written.push(file);
        if (target.path === '/' && viewport.name === 'desktop') {
          const full = `${OUT_DIR}${target.name}-${viewport.name}-${theme}-full.png`;
          await page.screenshot({ path: full, fullPage: true });
          written.push(full);
        }
      }
      await context.close();
    }
  }
} finally {
  await browser.close();
}

for (const file of written) console.log(file);
