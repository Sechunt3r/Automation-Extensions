// popup.js - slim launcher. The dashboard holds the full controls.

const $ = (id) => document.getElementById(id);
const STATUS_LABEL = {
  idle: 'idle', running: 'collecting', awaiting_challenge: 'verify',
  done: 'done', stopped: 'stopped', error: 'error'
};

const port = chrome.runtime.connect({ name: 'ui' });
port.onMessage.addListener((m) => {
  if (m.type === 'state') render(m.state);
});

function render(s) {
  $('pill').dataset.status = s.status;
  $('pillText').textContent = STATUS_LABEL[s.status] || s.status;
  $('statNew').textContent = s.newThisRun ?? 0;
  $('statTotal').textContent = s.totalRecords ?? 0;

  const active = s.status === 'running' || s.status === 'awaiting_challenge';
  const wire = $('wire');
  wire.classList.toggle('live', active);
  $('wireUrl').textContent =
    s.status === 'awaiting_challenge' ? (s.message || 'Complete the check in the opened tab.')
    : active ? (s.currentUrl || 'Working…')
    : (s.message || (s.status === 'done' ? `Done - ${s.newThisRun} new collected.` : 'Ready to collect.'));

  $('btnQuick').hidden = active;
  $('btnStop').hidden = !active;
  $('btnResume').hidden = s.status !== 'awaiting_challenge';
}

$('btnQuick').addEventListener('click', () => {
  chrome.runtime.sendMessage({
    cmd: 'start',
    params: { mode: 'current' },
    engine: 'tab'
  });
});
$('btnStop').addEventListener('click', () => chrome.runtime.sendMessage({ cmd: 'stop' }));
$('btnResume').addEventListener('click', () => chrome.runtime.sendMessage({ cmd: 'continueChallenge' }));
$('btnDash').addEventListener('click', async () => {
  await chrome.runtime.openOptionsPage();
  window.close();
});

// initial paint
chrome.runtime.sendMessage({ cmd: 'getState' }, (res) => {
  if (res && res.state) render(res.state);
});
