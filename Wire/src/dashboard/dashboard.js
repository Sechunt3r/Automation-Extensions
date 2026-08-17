// dashboard.js - full control center.
import { toCSV, toJSON, parseCSV } from '../lib/csv.js';

const $ = (id) => document.getElementById(id);
const STATUS_LABEL = {
  idle: 'idle', running: 'collecting', awaiting_challenge: 'verify needed',
  done: 'done', stopped: 'stopped', error: 'error'
};

let currentMode = 'since';
let currentEngine = 'tab';
let currentFilter = 'all';
let lastStatus = null;
let allRecords = [];

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
(function initDefaults() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  $('inSince').value = iso(weekAgo);
  $('inFrom').value = iso(weekAgo);
  $('inTo').value = iso(now);
  $('inMonth').value = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  $('inYear').value = now.getFullYear();
})();

// ---------------------------------------------------------------------------
// Segmented controls
// ---------------------------------------------------------------------------
$('modeSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  currentMode = btn.dataset.mode;
  [...$('modeSeg').children].forEach((b) => b.classList.toggle('is-active', b === btn));
  document.querySelectorAll('.mode-panel').forEach((p) => {
    p.hidden = p.dataset.for !== currentMode;
  });
});

$('engineSeg').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  currentEngine = btn.dataset.engine;
  [...$('engineSeg').children].forEach((b) => b.classList.toggle('is-active', b === btn));
  $('engineBadge').textContent = currentEngine === 'fetch' ? 'fast engine' : 'tab engine';
  $('engineHint').textContent = currentEngine === 'fetch'
    ? 'Fast tries a quiet background request first and falls back to a tab if Cloudflare blocks it. Good when your session is already cleared.'
    : 'Reliable drives a real tab, so it clears Cloudflare like a human would. Slower but dependable.';
});

// ---------------------------------------------------------------------------
// Build params from the form
// ---------------------------------------------------------------------------
function collectParams() {
  const p = { mode: currentMode, includeHomepage: $('inHomepage').checked };
  if (currentMode === 'since') p.since = $('inSince').value;
  else if (currentMode === 'days') p.days = $('inDays').value;
  else if (currentMode === 'range') { p.from = $('inFrom').value; p.to = $('inTo').value; }
  else if (currentMode === 'month') p.month = $('inMonth').value;
  else if (currentMode === 'year') p.year = $('inYear').value;
  return p;
}

function validate(p) {
  if (p.mode === 'since' && !p.since) return 'Pick a start date.';
  if (p.mode === 'range' && !p.from && !p.to) return 'Pick at least one range date.';
  if (p.mode === 'month' && !p.month) return 'Pick a month.';
  if (p.mode === 'year' && !p.year) return 'Enter a year.';
  return null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
$('btnStart').addEventListener('click', () => {
  const params = collectParams();
  const err = validate(params);
  if (err) { pushLog({ ts: Date.now(), line: '[!] ' + err }); return; }
  $('console').innerHTML = '';
  chrome.runtime.sendMessage({
    cmd: 'start',
    params,
    engine: currentEngine,
    delayMs: $('inDelay').value,
    settleMs: $('inSettle').value,
    enrich: $('inEnrich').checked,
    stopAtSeen: $('inStopSeen').checked
  });
});
$('btnStop').addEventListener('click', () => chrome.runtime.sendMessage({ cmd: 'stop' }));
$('btnResume').addEventListener('click', () => chrome.runtime.sendMessage({ cmd: 'continueChallenge' }));
$('btnClearLog').addEventListener('click', () => { $('console').innerHTML = ''; });

// ---------------------------------------------------------------------------
// Live updates
// ---------------------------------------------------------------------------
const port = chrome.runtime.connect({ name: 'ui' });
port.onMessage.addListener((m) => {
  if (m.type === 'state') renderState(m.state);
  else if (m.type === 'log') pushLog(m.entry);
  else if (m.type === 'logs') { $('console').innerHTML = ''; (m.logs || []).forEach(pushLog); }
});

function renderState(s) {
  $('pill').dataset.status = s.status;
  $('pillText').textContent = STATUS_LABEL[s.status] || s.status;
  $('engineBadge').textContent = (s.engine === 'fetch' ? 'fast engine' : 'tab engine');

  $('statNew').textContent = s.newThisRun ?? 0;
  $('statTotal').textContent = s.totalRecords ?? 0;
  $('statPages').textContent = s.pagesScanned ?? 0;
  $('statTasks').textContent = `${s.doneTasks ?? 0} / ${s.totalTasks ?? 0}`;
  $('recCount').textContent = s.totalRecords ?? 0;

  const pct = s.totalTasks ? Math.round((s.doneTasks / s.totalTasks) * 100) : 0;
  $('progressFill').style.width = pct + '%';

  const active = s.status === 'running' || s.status === 'awaiting_challenge';
  const enriching = active && s.enrichTotal > 0 && s.enrichDone < s.enrichTotal;
  $('wire').classList.toggle('live', active);
  $('wireUrl').textContent =
    s.status === 'awaiting_challenge' ? (s.message || 'Complete the check in the opened tab.')
    : enriching ? `Enriching ${s.enrichDone}/${s.enrichTotal}: ${s.currentUrl || ''}`
    : active ? (s.currentUrl || 'Working…')
    : (s.message || (s.status === 'done' ? `Done - ${s.newThisRun} new URL(s) collected.` : 'Ready. Choose a range and start collecting.'));

  $('btnStart').hidden = active;
  $('btnStop').hidden = !active;
  $('btnResume').hidden = s.status !== 'awaiting_challenge';

  // Refresh the table when a run finishes or state resets, and periodically
  // during enrichment so website/email cells fill in as they arrive.
  const terminal = ['done', 'stopped', 'error', 'idle'];
  if (s.status !== lastStatus && terminal.includes(s.status)) refreshRecords();
  else if (enriching && s.enrichDone % 10 === 0) refreshRecords();
  lastStatus = s.status;
}

function pushLog(entry) {
  const div = document.createElement('div');
  div.className = 'ln ' + classify(entry.line);
  const t = new Date(entry.ts);
  const ts = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
  div.innerHTML = `<span class="ts">${ts}</span>${escapeHtml(entry.line)}`;
  const c = $('console');
  c.appendChild(div);
  c.scrollTop = c.scrollHeight;
}
function classify(line) {
  if (/\[x\]|error|blocked|Fatal/i.test(line)) return 'err';
  if (/\[!\]|challenge|falling back/i.test(line)) return 'warn';
  if (/\[\+\]|\+[1-9]\d* new/i.test(line)) return 'hit';
  return '';
}

// ---------------------------------------------------------------------------
// Records table
// ---------------------------------------------------------------------------
async function refreshRecords() {
  const res = await sendMessage({ cmd: 'getRecords' });
  allRecords = (res && res.records) || [];
  renderTable();
}

// The set of records matching the active search + chip filter, newest first.
function filtered() {
  const q = $('search').value.trim().toLowerCase();
  let rows = allRecords;
  if (currentFilter === 'site') rows = rows.filter((r) => r.website);
  else if (currentFilter === 'email') rows = rows.filter((r) => r.emails);
  if (q) rows = rows.filter((r) =>
    (r.title || '').toLowerCase().includes(q) ||
    (r.url || '').toLowerCase().includes(q) ||
    (r.website || '').toLowerCase().includes(q) ||
    (r.emails || '').toLowerCase().includes(q));
  return rows.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
}

function renderTable() {
  const rows = filtered();
  const LIMIT = 500;
  const shown = rows.slice(0, LIMIT);

  const tbody = $('tbody');
  tbody.innerHTML = '';
  for (const r of shown) {
    const site = r.website
      ? `<a href="${escapeAttr(r.website)}" target="_blank" rel="noopener">${escapeHtml(hostOf(r.website))}</a>`
      : '<span class="muted-cell">-</span>';
    const mail = r.emails ? escapeHtml(r.emails) : '<span class="muted-cell">-</span>';
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="date">${escapeHtml(r.date || '-')}</td>` +
      `<td class="title">${escapeHtml(r.title || '')}</td>` +
      `<td class="url"><a href="${escapeAttr(r.url)}" target="_blank" rel="noopener">${escapeHtml(shortUrl(r.url))}</a></td>` +
      `<td class="site">${site}</td>` +
      `<td class="mail">${mail}</td>`;
    tbody.appendChild(tr);
  }

  $('empty').hidden = allRecords.length > 0;
  $('recCount').textContent = allRecords.length;
  const note = (currentFilter !== 'all' || $('search').value.trim()) ? ' (filtered)' : '';
  $('tableFoot').textContent = allRecords.length
    ? `Showing ${shown.length} of ${rows.length}${note} - ${allRecords.length} total.`
    : '';
}

$('search').addEventListener('input', renderTable);

$('chips').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;
  currentFilter = btn.dataset.filter;
  [...$('chips').children].forEach((c) => c.classList.toggle('is-active', c === btn));
  renderTable();
});

// ---------------------------------------------------------------------------
// Copy helpers - operate on the currently filtered set
// ---------------------------------------------------------------------------
async function copyLines(getter, label) {
  const rows = filtered();
  const vals = [];
  const seen = new Set();
  for (const r of rows) {
    const v = getter(r);
    if (!v) continue;
    for (const one of String(v).split(/[;,]\s*/)) {
      const t = one.trim();
      if (t && !seen.has(t)) { seen.add(t); vals.push(t); }
    }
  }
  if (!vals.length) { pushLog({ ts: Date.now(), line: `[!] No ${label} to copy in the current view.` }); return; }
  try {
    await navigator.clipboard.writeText(vals.join('\n'));
    pushLog({ ts: Date.now(), line: `[+] Copied ${vals.length} ${label} to the clipboard.` });
  } catch (err) {
    pushLog({ ts: Date.now(), line: `[x] Clipboard blocked: ${String(err)}` });
  }
}
$('btnCopyUrls').addEventListener('click', () => copyLines((r) => r.url, 'URLs'));
$('btnCopySites').addEventListener('click', () => copyLines((r) => r.website, 'websites'));
$('btnCopyEmails').addEventListener('click', () => copyLines((r) => r.emails, 'emails'));

// ---------------------------------------------------------------------------
// Export / import / clear
// ---------------------------------------------------------------------------
$('btnExportCsv').addEventListener('click', async () => {
  const recs = await getAll();
  if (!recs.length) return;
  download(toCSV(recs), `finsmes_master_urls_${stamp()}.csv`, 'text/csv');
});
$('btnExportJson').addEventListener('click', async () => {
  const recs = await getAll();
  if (!recs.length) return;
  download(toJSON(recs), `finsmes_urls_${stamp()}.json`, 'application/json');
});
$('btnImport').addEventListener('click', () => $('fileImport').click());
$('fileImport').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  const parsed = parseCSV(text);
  const recs = parsed
    .map((r) => ({
      date: r.date || '', title: r.title || '', url: r.url || '',
      website: r.website || '', emails: r.emails || '',
      scraped_at: r.scraped_at || ''
    }))
    .filter((r) => r.url);
  if (!recs.length) { pushLog({ ts: Date.now(), line: '[!] No rows with a "url" column found in that CSV.' }); e.target.value = ''; return; }
  const res = await sendMessage({ cmd: 'importRecords', records: recs });
  pushLog({ ts: Date.now(), line: `[+] Imported ${res.added} new (of ${recs.length}); ${res.total} tracked total.` });
  e.target.value = '';
  await refreshRecords();
});
$('btnClear').addEventListener('click', async () => {
  if (!confirm('Delete all collected URLs? This cannot be undone.')) return;
  await sendMessage({ cmd: 'clearData' });
  allRecords = [];
  renderTable();
  pushLog({ ts: Date.now(), line: '[*] Cleared all stored URLs.' });
});

async function getAll() {
  if (allRecords.length) return allRecords;
  const res = await sendMessage({ cmd: 'getRecords' });
  return (res && res.records) || [];
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function sendMessage(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}
function download(text, filename, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
function shortUrl(u) {
  try { const x = new URL(u); return x.pathname; } catch (e) { return u || ''; }
}
function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u || ''; }
}
function escapeHtml(s) {
  return (s == null ? '' : String(s)).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// initial paint
sendMessage({ cmd: 'getState' }).then((res) => { if (res && res.state) renderState(res.state); });
refreshRecords();
