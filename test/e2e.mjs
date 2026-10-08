// End-to-end check against live kick.com in a real browser.
//
//   npm run e2e                          # Zen (Firefox build)
//   npm run e2e -- --browser=chrome      # Google Chrome (Chrome build), also drives the popup
//   npm run e2e:login                    # once: log in to Kick in a separate test profile
//   npm run e2e -- --logged-in           # rerun with that profile
//   HEADED=1 npm run e2e                 # show the browser window
//
// It plays one stream without the extension, then with it, switches quality
// live, and moves to a second stream through Kick's in-app (SPA) navigation.
// In Chrome the switching goes through the real popup, and screenshots of
// each popup state land in dist/screenshots/.
//
// Kick only lets logged-in viewers keep 1080p. Guests get a short HD trial,
// after which Kick's own code downgrades the player. So as a guest the test
// checks that the extension rewrote Kick's quality reset, not the final height
// after navigation.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const BROWSER = arg('browser') || 'zen';
const CHROME = BROWSER === 'chrome';
const BIN =
  process.env.BROWSER_BIN ||
  (CHROME ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/Applications/Zen.app/Contents/MacOS/zen');
const EXTENSION = path.join(ROOT, 'dist', CHROME ? 'chrome' : 'firefox');
const SHOTS = path.join(ROOT, 'dist', 'screenshots');
const PROFILE = process.env.PROFILE_DIR || path.join(os.homedir(), `.quality-lock-e2e-${BROWSER}`);
const SETTLE_MS = Number(process.env.SETTLE_MS || 20000);
const LOGIN = process.argv.includes('--login');
const LOGGED_IN = process.argv.includes('--logged-in');
// Headless Chrome reports itself as HeadlessChrome in its user agent and
// client hints. Kick's Cloudflare check blocks that for logged-in sessions,
// so present the same identity as desktop Chrome.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
const UA_META = {
  brands: [{ brand: 'Google Chrome', version: '154' }, { brand: 'Chromium', version: '154' }, { brand: 'Not.A/Brand', version: '99' }],
  fullVersion: '154.0.0.0',
  platform: 'macOS',
  platformVersion: '15.0.0',
  architecture: 'arm',
  model: '',
  mobile: false,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch({ extensions = false, headed = !!process.env.HEADED, profile = LOGGED_IN || LOGIN } = {}) {
  const common = {
    executablePath: BIN,
    headless: !headed,
    defaultViewport: headed ? null : { width: 1400, height: 900 },
    ...(profile ? { userDataDir: PROFILE } : {}),
  };
  if (CHROME) {
    return puppeteer.launch({
      ...common,
      browser: 'chrome',
      enableExtensions: extensions,
      args: ['--mute-audio', '--disable-blink-features=AutomationControlled', `--user-agent=${UA}`],
    });
  }
  return puppeteer.launch({
    ...common,
    browser: 'firefox',
    // Keep this run apart from any Zen window that is already open.
    args: ['--no-remote', '--new-instance'],
    env: { ...process.env, MOZ_NO_REMOTE: '1' },
  });
}

// Cloudflare sometimes shows a short "Just a moment..." check first.
async function gotoKick(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => !document.title.includes('Just a moment'), { timeout: 60000 });
}

async function newPage(browser) {
  const page = await browser.newPage();
  if (CHROME) await page.setUserAgent(UA, UA_META);
  return page;
}

// Live channels whose stream offers a 1080p rendition.
async function channelsWith1080(page, wanted) {
  return page.evaluate(async (wanted) => {
    const res = await fetch('https://kick.com/stream/livestreams/en?page=1&limit=30&sort=desc');
    const { data } = await res.json();
    const found = [];
    for (const stream of data) {
      const slug = stream.channel?.slug;
      try {
        const channel = await (await fetch(`https://kick.com/api/v2/channels/${slug}`)).json();
        const playlist = await (await fetch(channel.playback_url)).text();
        const heights = [...playlist.matchAll(/RESOLUTION=\d+x(\d+)/g)].map((m) => Number(m[1]));
        if (heights.includes(1080) && heights.includes(480)) found.push(slug);
      } catch {
        // Skip channels whose playlist cannot be read.
      }
      if (found.length >= wanted) break;
    }
    return found;
  }, wanted);
}

async function playerState(page) {
  return page.evaluate(() => ({
    url: location.pathname,
    loggedIn: document.cookie.split('; ').some((c) => c.startsWith('session_token=')),
    height: (document.getElementById('video-player') ?? document.querySelector('video'))?.videoHeight ?? null,
    stream_quality: sessionStorage.getItem('stream_quality'),
  }));
}

async function waitForHeight(page, height, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if ((await playerState(page)).height === height) return true;
    await sleep(500);
  }
  return false;
}

async function openChannel(page, slug) {
  await gotoKick(page, `https://kick.com/${slug}`);
  await sleep(SETTLE_MS);
  return playerState(page);
}

// Navigates inside Kick's app and records every write to stream_quality.
async function navigateInApp(page, slug) {
  await page.evaluate((slug) => {
    window.__kqeWrites = [];
    const { setItem } = Storage.prototype;
    Storage.prototype.setItem = function (key, value) {
      const result = setItem.call(this, key, value);
      if (key === 'stream_quality') window.__kqeWrites.push({ kickWrote: value, stored: this.getItem(key) });
      return result;
    };
    window.next.router.push(`/${slug}`);
  }, slug);
  await sleep(SETTLE_MS);
  return { ...(await playerState(page)), writes: await page.evaluate(() => window.__kqeWrites) };
}

// Zen cannot open extension pages under automation, so switch the way the
// bridge does after a popup change: update the stored choice, then ask page.js.
async function switchViaPage(page, height) {
  await page.evaluate((height) => {
    sessionStorage.setItem('kqe_quality', String(height));
    sessionStorage.setItem('stream_quality', String(height));
    document.dispatchEvent(new CustomEvent('kqe:request', { detail: JSON.stringify({ id: -1, command: 'apply' }) }));
  }, height);
  return waitForHeight(page, height);
}

async function openPopup(browser, page) {
  const [extension] = (await browser.extensions()).values();
  await page.bringToFront();
  await extension.triggerAction(page);
  const target = await browser.waitForTarget((t) => t.url().endsWith('popup/popup.html'), { timeout: 10000 });
  const popup = await target.asPage();
  await popup.waitForSelector('#now-pill:not([hidden]), .now-value.is-text', { timeout: 10000 });
  return popup;
}

async function popupState(popup) {
  return popup.evaluate(() => ({
    view: document.getElementById('app').dataset.view,
    label: document.getElementById('now-label').textContent,
    value: document.getElementById('now-value').textContent,
    pill: document.getElementById('now-pill').hidden ? null : document.getElementById('now-pill').textContent,
    note: document.getElementById('now-note').hidden ? null : document.getElementById('now-note').textContent,
  }));
}

async function shoot(popup, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const app = await popup.$('#app');
  await app.screenshot({ path: path.join(SHOTS, `popup-${name}.png`) });
}

async function waitForPill(popup, text, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const state = await popupState(popup);
    if (state.pill === text) return state;
    await sleep(400);
  }
  return popupState(popup);
}

// Switches through the real popup: click a quality, wait for the player.
async function switchViaPopup(browser, page, height, shotName) {
  const popup = await openPopup(browser, page);
  await popup.click(`input[value="${height}"]`);
  const ok = await waitForHeight(page, height);
  const state = await waitForPill(popup, 'Locked');
  if (shotName) await shoot(popup, shotName);
  await popup.close();
  return { ok, popup: state };
}

if (LOGIN) {
  const browser = await launch({ headed: true, profile: true });
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.goto('https://kick.com/');
  console.log(`Log in to Kick in the opened window, then close it. Profile: ${PROFILE}`);
  await new Promise((resolve) => browser.on('disconnected', resolve));
  process.exit(0);
}

const results = { browser: BROWSER };

const plain = await launch();
try {
  const page = await newPage(plain);
  await gotoKick(page, 'https://kick.com/');
  await sleep(3000);
  results.channels = await channelsWith1080(page, 2);
  if (results.channels.length < 2) {
    throw new Error(`Need 2 live channels with 1080p and 480p, found ${results.channels.length}`);
  }
  results.withoutExtension = await openChannel(page, results.channels[0]);
} finally {
  await plain.close();
}

const withExt = await launch({ extensions: true });
try {
  results.version = await withExt.version();
  results.extensionId = await withExt.installExtension(EXTENSION);
  const page = await newPage(withExt);
  results.withExtension = await openChannel(page, results.channels[0]);

  if (CHROME) {
    const popup = await openPopup(withExt, page);
    results.popupOnLoad = await waitForPill(popup, 'Locked', 5000);
    await shoot(popup, '1-on-load');
    await popup.close();
    results.switchTo480 = await switchViaPopup(withExt, page, 480, '2-locked-480');
    results.switchTo1080 = await switchViaPopup(withExt, page, 1080, '3-locked-1080');

    const off = await openPopup(withExt, page);
    await off.click('#power');
    await sleep(6000);
    results.lockOff = { popup: await popupState(off), player: await playerState(page) };
    await shoot(off, '4-lock-off');
    await off.click('#power');
    await waitForHeight(page, 1080);
    await off.close();
  } else {
    results.switchTo480 = { ok: await switchViaPage(page, 480) };
    results.switchTo1080 = { ok: await switchViaPage(page, 1080) };
  }

  results.afterSpaNavigation = await navigateInApp(page, results.channels[1]);

  if (CHROME) {
    const blank = await newPage(withExt);
    await blank.goto('https://example.com/');
    const popup = await openPopup(withExt, blank);
    results.popupOffKick = await popupState(popup);
    await shoot(popup, '5-not-on-kick');
    await popup.close();
  }
} finally {
  await withExt.close();
}

console.log(JSON.stringify(results, null, 2));

const nav = results.afterSpaNavigation;
const load = results.withExtension;
// Kick's guest rule writes 0 (Auto) when it downgrades a logged-out viewer.
const guestLimited = (state) => !state.loggedIn && state.stream_quality === '0';
const checks = {
  'page load plays 1080p': load.height === 1080 || (guestLimited(load) ? 'skip' : false),
  'live switch to 480p': results.switchTo480.ok,
  'live switch back to 1080p': results.switchTo1080.ok,
  "Kick's reset on navigation is rewritten to 1080": nav.writes.some((w) => w.kickWrote === '' && w.stored === '1080'),
};
if (CHROME) {
  checks['popup shows Locked at 1080p'] = results.switchTo1080.popup.pill === 'Locked' && results.switchTo1080.popup.value.startsWith('1080p');
  checks['popup shows Locked at 480p'] = results.switchTo480.popup.pill === 'Locked' && results.switchTo480.popup.value.startsWith('480p');
  checks['lock off hands control back to Kick'] = results.lockOff.popup.pill === 'Kick decides';
  checks['popup off Kick says so'] = results.popupOffKick.view === 'off-kick';
}
if (nav.loggedIn) checks['SPA navigation plays 1080p'] = nav.height === 1080;

for (const [name, ok] of Object.entries(checks)) {
  console.log(`${ok === 'skip' ? 'SKIP' : ok ? 'PASS' : 'FAIL'}  ${name}${ok === 'skip' ? " (Kick's guest limit, see note)" : ''}`);
}
if (!nav.loggedIn) {
  console.log('NOTE  guest session: Kick downgrades logged-out viewers below 1080p outside its HD');
  console.log('      trial, so 1080p after load or navigation is only checked with --logged-in.');
}
if (CHROME) console.log(`Popup screenshots: ${path.relative(ROOT, SHOTS)}/`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
