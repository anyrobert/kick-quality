// Runs in the extension's isolated world. Copies the saved preference into the
// tab's sessionStorage, where Kick's player (and page.js) can read it.
//
// Kick's player reads sessionStorage.stream_quality (a video height such as
// 1080) when a stream becomes ready. Without it, Kick uses Auto, capped at 720p.

const KICK_KEY = 'stream_quality';
const PREF_KEY = 'kqe_quality';

function apply(quality) {
  try {
    if (typeof quality === 'number') {
      sessionStorage.setItem(PREF_KEY, String(quality));
      sessionStorage.setItem(KICK_KEY, String(quality));
    } else {
      // Auto: stop enforcing and let Kick decide.
      sessionStorage.removeItem(PREF_KEY);
      sessionStorage.removeItem(KICK_KEY);
    }
  } catch (err) {
    console.warn('[Kick Quality] Could not write sessionStorage', err);
  }
}

browser.storage.local.get({ quality: 1080 }).then(({ quality }) => apply(quality));

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.quality) apply(changes.quality.newValue);
});
