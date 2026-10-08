// Runs in the page's own JavaScript world, before Kick's scripts.
//
// Every time a new stream loads, Kick wipes a stored stream_quality of 1080 or
// higher, which drops the player back to 720p. This wrapper turns that wipe
// into a write of the user's preferred quality instead. A quality the user
// picks by hand in Kick's own menu is still written normally.

(() => {
  const KICK_KEY = 'stream_quality';
  const PREF_KEY = 'kqe_quality';
  const { getItem, setItem, removeItem } = Storage.prototype;

  function preferred(storage) {
    return storage === window.sessionStorage ? getItem.call(storage, PREF_KEY) : null;
  }

  Storage.prototype.setItem = function (key, value) {
    const pref = key === KICK_KEY && String(value) === '' ? preferred(this) : null;
    return setItem.call(this, key, pref ?? value);
  };

  Storage.prototype.removeItem = function (key) {
    const pref = key === KICK_KEY ? preferred(this) : null;
    return pref ? setItem.call(this, key, pref) : removeItem.call(this, key);
  };
})();
