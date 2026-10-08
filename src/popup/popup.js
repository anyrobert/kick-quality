const api = globalThis.browser ?? globalThis.chrome;

const DEFAULTS = { quality: 1080, enabled: true };
const POLL_MS = 700;
// How long a quality change may take before the popup stops saying "Switching".
const SWITCH_GRACE_MS = 8000;

const $ = (selector) => document.querySelector(selector);
const app = $('#app');
const power = $('#power');
const options = $('#options');
const nowLabel = $('#now-label');
const nowPill = $('#now-pill');
const nowValue = $('#now-value');
const nowNote = $('#now-note');
const nowAction = $('#now-action');

let settings = { ...DEFAULTS };
let tab = null;
let lastChangeAt = 0;
let lastValueKey = '';
let polling = false;

function isKickTab(t) {
  return !!t?.url && new URL(t.url).hostname === 'kick.com';
}

function renderSettings() {
  power.setAttribute('aria-checked', String(settings.enabled));
  app.dataset.enabled = String(settings.enabled);
  const radio = options.querySelector(`input[value="${settings.quality}"]`);
  if (radio) radio.checked = true;
}

async function save(next) {
  settings = { ...settings, ...next };
  lastChangeAt = Date.now();
  renderSettings();
  await api.storage.local.set(settings);
  setTimeout(refresh, 150);
}

function setValue(parts, { text = false } = {}) {
  const key = JSON.stringify(parts);
  nowValue.classList.toggle('is-text', text);
  if (key === lastValueKey) return;
  lastValueKey = key;
  nowValue.replaceChildren(
    ...parts.map(([cls, content]) => {
      const span = document.createElement('span');
      if (cls) span.className = cls;
      span.textContent = content;
      return span;
    }),
  );
  nowValue.classList.remove('changed');
  void nowValue.offsetWidth;
  nowValue.classList.add('changed');
}

function setPill(text, tone) {
  nowPill.hidden = !text;
  nowPill.textContent = text ?? '';
  if (tone) nowPill.dataset.tone = tone;
}

function setNote(text) {
  nowNote.hidden = !text;
  nowNote.textContent = text ?? '';
}

function setAction(label, onClick, tone = 'primary') {
  nowAction.hidden = !label;
  nowAction.textContent = label ?? '';
  nowAction.dataset.tone = tone;
  nowAction.onclick = onClick ?? null;
}

function setMeta(available) {
  for (const option of options.querySelectorAll('.option')) {
    const meta = option.querySelector('.meta');
    const height = Number(option.querySelector('input').value);
    const match = available?.find((q) => q.height === height);
    meta.toggleAttribute('data-missing', !!available && !match);
    meta.textContent = !available ? '' : match ? `${match.framerate} fps` : 'not on stream';
  }
}

function lockSummary() {
  return settings.enabled ? `Locked to ${settings.quality}p` : 'Lock is off';
}

function render(view, status) {
  app.dataset.view = view;
  app.dataset.locked = 'false';
  setMeta(view === 'stream' ? status.available : null);

  if (view === 'off-kick') {
    nowLabel.textContent = 'Not on Kick';
    setPill(null);
    setValue([[null, lockSummary()]], { text: true });
    setNote(settings.enabled ? 'Every Kick stream you open starts at this quality.' : 'Kick picks the quality on its own.');
    setAction('Open Kick', () => {
      api.tabs.create({ url: 'https://kick.com/' });
      window.close();
    }, 'quiet');
    return;
  }

  if (view === 'needs-reload') {
    nowLabel.textContent = 'Kick tab';
    setPill(null);
    setValue([[null, 'Reload to start']], { text: true });
    setNote('This tab was opened before Quality Lock was installed or updated.');
    setAction('Reload tab', () => api.tabs.reload(tab.id));
    return;
  }

  if (view === 'no-stream') {
    nowLabel.textContent = 'On Kick';
    setPill(null);
    setValue([[null, 'Open a stream']], { text: true });
    setNote(settings.enabled ? `Any stream you open starts at ${settings.quality}p.` : 'Lock is off. Kick picks the quality.');
    setAction(null);
    return;
  }

  if (view === 'stream-basic') {
    nowLabel.textContent = 'Now playing';
    setPill(null);
    setValue(status.videoHeight ? [[null, `${status.videoHeight}p`]] : [[null, 'Loading stream']], {
      text: !status.videoHeight,
    });
    setNote('Changes apply when the stream reloads.');
    setAction(lastChangeAt ? 'Reload stream' : null, () => api.tabs.reload(tab.id), 'quiet');
    return;
  }

  // view === 'stream'
  const { current, target, auto, channel } = status;
  nowLabel.textContent = channel ? `Now playing · ${channel}` : 'Now playing';
  setValue(
    current
      ? [
          [null, `${current.height}p`],
          ['fps', `${current.framerate} fps${auto ? ' · Auto' : ''}`],
        ]
      : [[null, 'Loading stream']],
    { text: !current },
  );

  if (!settings.enabled) {
    setPill('Kick decides', 'neutral');
    setNote(null);
    setAction(null);
    return;
  }

  const locked = !!current && !!target && !auto && current.name === target.name;
  if (locked) {
    app.dataset.locked = 'true';
    setPill('Locked', 'locked');
    setNote(target.height < settings.quality ? `This stream tops out at ${target.name}.` : null);
    setAction(null);
    return;
  }

  if (!current || !target || Date.now() - lastChangeAt < SWITCH_GRACE_MS) {
    setPill('Switching…', 'switching');
    setNote(null);
    setAction(null);
    return;
  }

  setPill(`Held at ${current.height}p`, 'held');
  setNote(
    target.height >= 1080 && current.height < 1080
      ? 'Kick only lets logged-in viewers keep 1080p.'
      : 'Kick changed the quality after it was set.',
  );
  setAction(`Try ${target.name} again`, async () => {
    lastChangeAt = Date.now();
    await api.tabs.sendMessage(tab.id, { type: 'kqe:apply' }).catch(() => {});
    refresh();
  });
}

async function refresh() {
  if (polling) return;
  polling = true;
  try {
    if (!isKickTab(tab)) return render('off-kick');
    let status;
    try {
      status = await api.tabs.sendMessage(tab.id, { type: 'kqe:status' });
    } catch {
      return render('needs-reload');
    }
    if (!status) return render('needs-reload');
    if (!status.onStream) return render('no-stream');
    if (!status.connected) return render('stream-basic', status);
    render('stream', status);
  } finally {
    polling = false;
  }
}

options.addEventListener('change', (event) => {
  save({ quality: Number(event.target.value), enabled: true });
});

power.addEventListener('click', () => save({ enabled: !settings.enabled }));

async function init() {
  $('#version').textContent = `v${api.runtime.getManifest().version}`;
  settings = await api.storage.local.get(DEFAULTS);
  renderSettings();
  [tab] = await api.tabs.query({ active: true, currentWindow: true });
  await refresh();
  setInterval(refresh, POLL_MS);
}

init();
