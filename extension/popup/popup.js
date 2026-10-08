const form = document.getElementById('qualities');
const reloadButton = document.getElementById('reload');

browser.storage.local.get({ quality: 1080 }).then(({ quality }) => {
  const radio = form.querySelector(`input[value="${quality}"]`);
  if (radio) radio.checked = true;
});

form.addEventListener('change', async (event) => {
  const value = event.target.value;
  await browser.storage.local.set({ quality: value === 'auto' ? 'auto' : Number(value) });

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true, url: 'https://kick.com/*' });
  reloadButton.hidden = !tab;
  reloadButton.onclick = () => {
    browser.tabs.reload(tab.id);
    window.close();
  };
});
