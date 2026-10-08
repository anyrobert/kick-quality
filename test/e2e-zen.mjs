// End-to-end check against live kick.com in a real Zen (or Firefox) browser.
//
// It plays one stream without the extension, then with it, then moves to a
// second stream through Kick's in-page (SPA) navigation. It prints the video
// height the player ends up at each time.
//
//   npm run e2e                      # guest, fresh profile, /Applications/Zen.app
//   npm run e2e:login                # log in to Kick once in a test profile
//   npm run e2e -- --logged-in       # rerun the check with that profile
//   BROWSER_BIN=/path/to/firefox npm run e2e
//   HEADED=1 npm run e2e             # show the browser window
//
// Kick only lets logged-in viewers keep 1080p. Guests get a short HD trial,
// after which Kick's own code downgrades the player. So as a guest the test
// checks that the extension rewrote Kick's quality reset, not the final height
// after navigation.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const BIN = process.env.BROWSER_BIN || '/Applications/Zen.app/Contents/MacOS/zen';
const EXTENSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extension');
const PROFILE = process.env.PROFILE_DIR || path.join(os.homedir(), '.kick-quality-e2e-profile');
const SETTLE_MS = Number(process.env.SETTLE_MS || 20000);
const LOGIN = process.argv.includes('--login');
const LOGGED_IN = process.argv.includes('--logged-in');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch({ headed = !!process.env.HEADED, profile = LOGGED_IN || LOGIN } = {}) {
  return puppeteer.launch({
    browser: 'firefox',
    executablePath: BIN,
    headless: !headed,
    // Keep this run apart from any Zen window that is already open.
    args: ['--no-remote', '--new-instance'],
    env: { ...process.env, MOZ_NO_REMOTE: '1' },
    defaultViewport: headed ? null : { width: 1400, height: 900 },
    ...(profile ? { userDataDir: PROFILE } : {}),
  });
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
        if (heights.includes(1080)) found.push(slug);
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
    loggedIn: ![...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Log In'),
    height: document.querySelector('video')?.videoHeight ?? null,
    stream_quality: sessionStorage.getItem('stream_quality'),
  }));
}

async function openChannel(page, slug) {
  await page.goto(`https://kick.com/${slug}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
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
      if (key === 'stream_quality') {
        window.__kqeWrites.push({ kickWrote: value, stored: this.getItem(key) });
      }
      return result;
    };
    window.next.router.push(`/${slug}`);
  }, slug);
  await sleep(SETTLE_MS);
  return {
    ...(await playerState(page)),
    writes: await page.evaluate(() => window.__kqeWrites),
  };
}

if (LOGIN) {
  const browser = await launch({ headed: true, profile: true });
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.goto('https://kick.com/');
  console.log(`Log in to Kick in the opened window, then close it. Profile: ${PROFILE}`);
  await new Promise((resolve) => browser.on('disconnected', resolve));
  process.exit(0);
}

const results = {};

const plain = await launch();
try {
  const page = await plain.newPage();
  await page.goto('https://kick.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(3000);
  results.channels = await channelsWith1080(page, 2);
  if (results.channels.length < 2) {
    throw new Error(`Need 2 live channels with 1080p, found ${results.channels.length}`);
  }
  results.withoutExtension = await openChannel(page, results.channels[0]);
} finally {
  await plain.close();
}

const withExt = await launch();
try {
  results.browser = await withExt.version();
  results.extensionId = await withExt.installExtension(EXTENSION);
  const page = await withExt.newPage();
  results.withExtension = await openChannel(page, results.channels[0]);
  results.afterSpaNavigation = await navigateInApp(page, results.channels[1]);
} finally {
  await withExt.close();
}

console.log(JSON.stringify(results, null, 2));

const nav = results.afterSpaNavigation;
const checks = {
  'page load plays 1080p': results.withExtension.height === 1080,
  "Kick's reset on navigation is rewritten to 1080": nav.writes.some(
    (w) => w.kickWrote === '' && w.stored === '1080',
  ),
};
if (nav.loggedIn) checks['SPA navigation plays 1080p'] = nav.height === 1080;

for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
if (!nav.loggedIn) {
  console.log('NOTE  guest session: Kick downgrades guests after its HD trial, so the');
  console.log('      final height after navigation is not checked. Use --logged-in for that.');
}
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
