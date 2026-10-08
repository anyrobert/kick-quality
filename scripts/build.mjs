// Builds the extension for each browser from src/:
//   dist/chrome/   + dist/quality-lock-for-kick-chrome-<version>.zip
//   dist/firefox/  + dist/quality-lock-for-kick-firefox-<version>.xpi  (Zen, Firefox)

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const NAME = 'Quality Lock for Kick';
const KICK = 'https://kick.com/*';

const base = {
  manifest_version: 3,
  name: NAME,
  version,
  description: "Keeps Kick.com streams at the quality you choose, like 1080p, instead of Kick's 720p auto cap. Switches instantly.",
  permissions: ['storage'],
  host_permissions: [KICK],
  icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
  action: {
    default_title: NAME,
    default_popup: 'popup/popup.html',
    default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
  },
  content_scripts: [
    // page.js must run in the page's own world, before Kick's scripts.
    { matches: [KICK], js: ['page.js'], run_at: 'document_start', world: 'MAIN' },
    { matches: [KICK], js: ['bridge.js'], run_at: 'document_start' },
  ],
};

const targets = {
  chrome: {
    manifest: { ...base, minimum_chrome_version: '111' },
    file: `quality-lock-for-kick-chrome-${version}.zip`,
  },
  firefox: {
    manifest: {
      ...base,
      browser_specific_settings: {
        gecko: {
          id: 'quality-lock-for-kick@anyrobert',
          strict_min_version: '128.0',
          data_collection_permissions: { required: ['none'] },
        },
      },
    },
    file: `quality-lock-for-kick-firefox-${version}.xpi`,
  },
};

fs.mkdirSync(DIST, { recursive: true });
for (const [name, { manifest, file }] of Object.entries(targets)) {
  const dir = path.join(DIST, name);
  const archive = path.join(DIST, file);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(archive, { force: true });
  fs.cpSync(SRC, dir, { recursive: true, filter: (p) => !path.basename(p).startsWith('.') });
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  execFileSync('zip', ['-r', '-X', '-q', archive, '.'], { cwd: dir });
  console.log(`${name.padEnd(8)} dist/${name}/  dist/${file}`);
}
