// Runs in the page's own JavaScript world, before Kick's scripts.
//
// Layer 1, storage. Kick's player reads sessionStorage.stream_quality (a
// height such as 1080) when a stream becomes ready. On every new stream it
// wipes a stored value of 1080 or more, which drops the player back to 720p.
// The Storage wrapper below turns that wipe into a write of the user's choice.
// This alone makes page loads and channel switches start at the right quality.
//
// Layer 2, player store. Kick keeps its player in a zustand store whose state
// has an ivsLivestreamPlayer field. Zustand builds every new state with
// Object.assign({}, state, patch), so a setter on Object.prototype sees each
// new state object. Holding the latest one lets us call Kick's own setQuality
// action, which switches quality instantly from the popup and picks the
// closest quality when a stream lacks the exact one. If Kick changes this,
// layer 1 still works and the popup falls back to "reload to apply".
//
// The bridge content script talks to this file through kqe:request and
// kqe:response DOM events carrying JSON strings.

(() => {
  const KICK_KEY = 'stream_quality';
  const PREF_KEY = 'kqe_quality';
  const STORE_FIELD = 'ivsLivestreamPlayer';
  const { getItem, setItem, removeItem } = Storage.prototype;

  function preferredIn(storage) {
    return storage === window.sessionStorage ? getItem.call(storage, PREF_KEY) : null;
  }

  function preferredHeight() {
    const value = Number(getItem.call(window.sessionStorage, PREF_KEY));
    return value > 0 ? value : null;
  }

  // Layer 1 ------------------------------------------------------------------

  Storage.prototype.setItem = function (key, value) {
    const pref = key === KICK_KEY && String(value) === '' ? preferredIn(this) : null;
    return setItem.call(this, key, pref ?? value);
  };

  Storage.prototype.removeItem = function (key) {
    const pref = key === KICK_KEY ? preferredIn(this) : null;
    return pref ? setItem.call(this, key, pref) : removeItem.call(this, key);
  };

  // Layer 2 ------------------------------------------------------------------

  let store = null;
  let streamSeen = null;
  let qualitiesAtStreamStart = null;
  let settled = false;

  Object.defineProperty(Object.prototype, STORE_FIELD, {
    configurable: true,
    get() {
      return undefined;
    },
    set(value) {
      Object.defineProperty(this, STORE_FIELD, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
      if (value) {
        store = this;
        // The rest of the new state is copied after this field.
        queueMicrotask(onStoreUpdate);
      }
    },
  });

  function player() {
    return store?.[STORE_FIELD] ?? null;
  }

  // Kick sets store.qualities to a new array once the stream is ready, and
  // already applies an exact match from sessionStorage. When there is no exact
  // match it falls back to Auto, so pick the closest quality once per stream.
  // Later changes (Kick's menu, Kick's own rules) are left alone.
  function onStoreUpdate() {
    const stream = store?.currentVideoInformations?.playbackUrl ?? null;
    if (stream !== streamSeen) {
      streamSeen = stream;
      qualitiesAtStreamStart = store?.qualities;
      settled = false;
    }
    if (settled || !stream || !store.qualities?.length || store.qualities === qualitiesAtStreamStart) {
      return;
    }
    settled = true;
    applyPreference();
  }

  function closest(qualities, height) {
    const sorted = [...qualities].sort((a, b) => b.height - a.height || b.framerate - a.framerate);
    return sorted.find((q) => q.height <= height) ?? sorted[sorted.length - 1] ?? null;
  }

  function applyPreference({ autoWhenOff = false } = {}) {
    const p = player();
    if (!p || typeof store.setQuality !== 'function') return;
    const height = preferredHeight();
    if (height === null) {
      if (autoWhenOff && !p.isAutoQualityMode()) store.setQuality({ name: 'Auto' });
      return;
    }
    const target = closest(p.getQualities(), height);
    if (target && (p.isAutoQualityMode() || p.getQuality()?.name !== target.name)) {
      store.setQuality(target);
    }
  }

  function describe(q) {
    return q ? { name: q.name, height: q.height, framerate: Math.round(q.framerate) } : null;
  }

  function status() {
    const p = player();
    const video = document.querySelector('video');
    const onStream = !!store?.currentVideoInformations && !!video;
    if (!p || !onStream) {
      return { connected: !!p, onStream, videoHeight: video?.videoHeight || null };
    }
    const available = p.getQualities().map(describe).sort((a, b) => b.height - a.height);
    const height = preferredHeight();
    return {
      connected: true,
      onStream: true,
      channel: location.pathname.split('/')[1] || null,
      auto: p.isAutoQualityMode(),
      current: describe(p.getQuality()),
      target: height === null ? null : describe(closest(p.getQualities(), height)),
      available,
      videoHeight: video.videoHeight || null,
    };
  }

  document.addEventListener('kqe:request', (event) => {
    let request;
    try {
      request = JSON.parse(event.detail);
    } catch {
      return;
    }
    if (request.command === 'apply') applyPreference({ autoWhenOff: true });
    const detail = JSON.stringify({ id: request.id, result: status() });
    document.dispatchEvent(new CustomEvent('kqe:response', { detail }));
  });
})();
