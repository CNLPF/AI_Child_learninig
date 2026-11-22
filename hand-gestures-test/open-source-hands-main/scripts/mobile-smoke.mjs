import { chromium } from 'playwright';

const url = process.argv[2] ?? 'http://127.0.0.1:5183/fruit.html';
const edgePath = process.env.EDGE_PATH ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const browser = await chromium.launch({ executablePath: edgePath, headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => Boolean(window.__fruit), null, { timeout: 10000 });

const state = await page.evaluate(() => ({
  mode: window.__fruit.mode,
  active: window.__fruit.active,
  welcomeHidden: getComputedStyle(document.getElementById('welcome')).display === 'none',
  mouseLabel: document.getElementById('mode-mouse').textContent,
  stageWidth: Math.round(document.getElementById('stage').getBoundingClientRect().width),
  bodyWidth: document.body.scrollWidth,
  viewportWidth: window.innerWidth,
}));

console.log(JSON.stringify({ ...state, pageErrors: errors }, null, 2));
if (state.mode !== 'mouse' || !state.active || !state.welcomeHidden) process.exitCode = 1;
if (state.mouseLabel !== '触屏控制' || state.bodyWidth > state.viewportWidth) process.exitCode = 1;
await browser.close();
