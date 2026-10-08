# Kick Quality Enforcer for Zen

A small Zen Browser (and Firefox) extension that plays Kick.com streams at the quality you pick, instead of Kick's default Auto mode, which never goes above 720p.

It is a rewrite for Firefox-based browsers, inspired by [greatsworn/Kick-Quality-Enforcer](https://github.com/greatsworn/Kick-Quality-Enforcer) (Chrome). The original opens Kick's settings menu and clicks the quality option. This version doesn't touch the menu. It uses the setting Kick's own player reads.

## How it works

Kick's player keeps the chosen quality in `sessionStorage.stream_quality` (a video height such as `1080`). When a stream becomes ready:

- if that height is one of the stream's renditions, the player switches to it;
- otherwise it uses Auto, capped at 720p.

Kick also wipes any stored value of 1080 or higher every time a new stream loads. That's why 1080p drops back to 720p when you move between channels.

The extension has two content scripts:

- `bridge.js` (isolated world) copies your saved choice into the tab's `sessionStorage` when the page starts.
- `page.js` (page world, runs before Kick's code) turns Kick's wipe of `stream_quality` into a write of your choice. A quality you pick by hand in Kick's menu is still saved normally.

## Install in Zen

Zen doesn't require add-on signatures once you turn the check off, so the unsigned build installs permanently.

1. Download `kick-quality-enforcer-<version>.xpi` from this repo's Releases, or build it (see below).
2. Open `about:config` and set `xpinstall.signatures.required` to `false`.
3. Open `about:addons`, click the gear icon, choose **Install Add-on From File…** and pick the `.xpi`.
4. Allow access to kick.com when asked.

To try it without installing: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → pick `extension/manifest.json`. It goes away when Zen restarts.

If you'd rather not change the signature setting, sign the build as an unlisted add-on with your own [AMO API keys](https://addons.mozilla.org/developers/addon/api/key/):

```sh
npx web-ext sign --source-dir extension --channel unlisted --api-key "$AMO_JWT_ISSUER" --api-secret "$AMO_JWT_SECRET"
```

## Use

Click the toolbar icon and pick a quality: 1080p (default), 720p, 480p, 360p, 160p or Auto. The choice applies to the next stream you open. On a Kick tab, the popup offers to reload the tab so it applies right away.

## Limits

- **You need to be logged in to Kick for 1080p.** Kick only lets logged-in viewers keep 1080p. Guests get a short HD trial, after which Kick's own code downgrades the player. The extension doesn't work around that.
- If a stream doesn't offer the height you picked (some streams top out at 720p, for example), Kick falls back to Auto.
- This depends on how Kick's player works today (checked October 2026). If Kick renames the storage key or changes the logic, the extension stops having an effect until it's updated. It won't break the page.

## Develop

```sh
npm install          # web-ext and puppeteer-core
npm run lint         # web-ext lint
npm run build        # dist/kick-quality-enforcer-<version>.xpi
npm start            # run Zen with the extension loaded and a temporary profile
```

### End-to-end check

`test/e2e-zen.mjs` drives a real Zen through WebDriver BiDi against live kick.com. It finds two live channels that offer 1080p and plays the first one without the extension, then with it. Then it moves to the second channel through Kick's in-app navigation.

```sh
npm run e2e                      # guest, fresh profile
npm run e2e:login                # once: log in to Kick in a separate test profile
npm run e2e -- --logged-in       # same check, logged in; also checks 1080p after navigation
```

Set `BROWSER_BIN` to use another Firefox-based browser and `HEADED=1` to watch it. The test profile lives in `~/.kick-quality-e2e-profile` (override with `PROFILE_DIR`).
