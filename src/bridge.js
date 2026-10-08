// Runs in the extension's isolated world on kick.com.
//
// It copies the saved choice into the tab's sessionStorage, where Kick's
// player and page.js read it, and relays popup requests to page.js.

const api = globalThis.browser ?? globalThis.chrome;

const KICK_KEY = 'stream_quality';
const PREF_KEY = 'kqe_quality';
const DEFAULTS = { quality: 1080, enabled: true };

function writePreference({ quality, enabled }) {
  try {
    if (enabled) {
      sessionStorage.setItem(PREF_KEY, String(quality));
      sessionStorage.setItem(KICK_KEY, String(quality));
    } else {
      // Lock off: stop enforcing and let Kick decide.
      sessionStorage.removeItem(PREF_KEY);
      sessionStorage.removeItem(KICK_KEY);
    }
  } catch (err) {
    console.warn('[Quality Lock] Could not write sessionStorage', err);
  }
}

let nextId = 0;

// Resolves with page.js's status, or null if page.js does not answer.
function askPage(command) {
  const id = ++nextId;
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(null), 500);
    function onResponse(event) {
      let response;
      try {
        response = JSON.parse(event.detail);
      } catch {
        return;
      }
      if (response.id === id) finish(response.result);
    }
    function finish(result) {
      clearTimeout(timer);
      document.removeEventListener('kqe:response', onResponse);
      resolve(result);
    }
    document.addEventListener('kqe:response', onResponse);
    document.dispatchEvent(new CustomEvent('kqe:request', { detail: JSON.stringify({ id, command }) }));
  });
}

api.storage.local.get(DEFAULTS).then(writePreference);

api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(changes.quality || changes.enabled)) return;
  api.storage.local.get(DEFAULTS).then((settings) => {
    writePreference(settings);
    askPage('apply');
  });
});

// The popup asks for the player's status, or to apply the saved choice again.
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const command = { 'kqe:status': 'status', 'kqe:apply': 'apply' }[message?.type];
  if (!command) return false;
  askPage(command).then(sendResponse);
  return true;
});
