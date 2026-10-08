// Renders src/icons/icon.svg to the PNG sizes the manifests use.
// Toolbar sizes are full-bleed. The 128px icon keeps the store's 16px of
// transparent padding around 96px of artwork.
//
//   npm run icons            # uses Google Chrome at its default macOS path
//   CHROME_BIN=/path/to/chrome npm run icons

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const svg = fs.readFileSync(path.join(ROOT, 'src/icons/icon.svg'), 'utf8');
const SIZES = [
  { size: 16, art: 16 },
  { size: 32, art: 32 },
  { size: 48, art: 48 },
  { size: 128, art: 96 },
];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage();
  for (const { size, art } of SIZES) {
    await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
    const pad = (size - art) / 2;
    const img = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
    await page.setContent(
      `<html><body style="margin:0;background:transparent"><img src="${img}" width="${art}" height="${art}" style="display:block;margin:${pad}px"></body></html>`,
    );
    const out = path.join(ROOT, `src/icons/icon-${size}.png`);
    await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    console.log('wrote', path.relative(ROOT, out));
  }
} finally {
  await browser.close();
}
