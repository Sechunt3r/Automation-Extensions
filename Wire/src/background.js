// background.js - service worker (module)
// Orchestrates a collection run: builds the page queue from a date range,
// scrapes each page (either by background fetch or by driving a real tab),
// deduplicates against stored records, and streams progress to the UI.

import { SITE_CONFIG, buildTasks, monthUrl } from './config.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const DEFAULT_STATE = {
  status: 'idle',            // idle | running | awaiting_challenge | done | stopped | error
  mode: null,
  label: '',
  engine: 'tab',            // tab | fetch
  totalTasks: 0,
  doneTasks: 0,
  currentUrl: '',
  pagesScanned: 0,
  newThisRun: 0,
  totalRecords: 0,
  enrichTotal: 0,
  enrichDone: 0,
  startedAt: null,
  finishedAt: null,
  message: ''
};

let state = { ...DEFAULT_STATE };
let logBuffer = [];           // in-memory, last ~300 lines
let job = null;               // live run context; null when idle
const ports = new Set();      // connected UI ports
let scrapeTabId = null;       // reused tab for reliable mode
let creatingOffscreen = null; // lock for offscreen creation

const pad = (n) => String(n).padStart(2, '0');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clampInt = (v, lo, hi, dflt) => {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

// ---------------------------------------------------------------------------
// Startup reconciliation
// ---------------------------------------------------------------------------

init();
async function init() {
  const stored = await chrome.storage.local.get(['state', 'records']);
  if (stored.state) state = { ...DEFAULT_STATE, ...stored.state };
  const total = (stored.records || []).length;
  state.totalRecords = total;

  // A run cannot survive a worker restart. If we were mid-run, close it out
  // honestly - partial results are already saved and re-running is cheap
  // because dedup skips everything already collected.
  if (state.status === 'running' || state.status === 'awaiting_challenge') {
    state.status = 'stopped';
    state.message = 'Interrupted before finishing. Saved results are intact - press Start to continue.';
  }
  await saveState();
}

chrome.runtime.onStartup.addListener(init);

// ---------------------------------------------------------------------------
// Messaging: ports for live updates, one-shot messages for commands
// ---------------------------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'ui') return;
  ports.add(port);
  port.postMessage({ type: 'state', state });
  port.postMessage({ type: 'logs', logs: logBuffer });
  port.onDisconnect.addListener(() => ports.delete(port));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return; // offscreen handles its own
  (async () => {
    try {
      switch (msg.cmd) {
        case 'getState':
          sendResponse({ state, logs: logBuffer });
          break;
        case 'getRecords':
          sendResponse({ records: await getRecords() });
          break;
        case 'start':
          startJob(msg);           // fire and forget; progress via port
          sendResponse({ ok: true });
          break;
        case 'stop':
          if (job) job.abort = true;
          log('[*] Stop requested - finishing current page.');
          sendResponse({ ok: true });
          break;
        case 'continueChallenge':
          if (job) job.continueChallenge = true;
          sendResponse({ ok: true });
          break;
        case 'clearData':
          await setRecords([]);
          state.totalRecords = 0;
          await saveState();
          sendResponse({ ok: true });
          break;
        case 'importRecords': {
          const res = await importRecords(msg.records || []);
          sendResponse(res);
          break;
        }
        default:
          sendResponse({ error: 'unknown command' });
      }
    } catch (e) {
      sendResponse({ error: String(e && e.message ? e.message : e) });
    }
  })();
  return true; // async sendResponse
});

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

async function getRecords() {
  const { records } = await chrome.storage.local.get('records');
  return records || [];
}
async function setRecords(arr) {
  await chrome.storage.local.set({ records: arr });
}
async function saveState() {
  await chrome.storage.local.set({ state });
  broadcastState();
}
function normalizeRecord(r) {
  return {
    date: (r.date || '').toString().slice(0, 10),
    title: (r.title || '').toString(),
    url: (r.url || '').toString(),
    website: (r.website || '').toString(),
    emails: (r.emails || '').toString(),
    scraped_at: (r.scraped_at || new Date().toISOString()).toString()
  };
}
async function importRecords(incoming) {
  const cur = await getRecords();
  const seen = new Set(cur.map((r) => r.url));
  let added = 0;
  for (const r of incoming) {
    if (r && r.url && !seen.has(r.url)) {
      cur.push(normalizeRecord(r));
      seen.add(r.url);
      added++;
    }
  }
  await setRecords(cur);
  state.totalRecords = cur.length;
  await saveState();
  return { added, total: cur.length };
}

// ---------------------------------------------------------------------------
// UI notifications
// ---------------------------------------------------------------------------

function broadcastState() {
  for (const p of ports) {
    try { p.postMessage({ type: 'state', state }); } catch (e) { /* gone */ }
  }
}
function setState(patch) {
  Object.assign(state, patch);
  broadcastState();
}
function log(line) {
  const entry = { ts: Date.now(), line };
  logBuffer.push(entry);
  if (logBuffer.length > 300) logBuffer = logBuffer.slice(-300);
  for (const p of ports) {
    try { p.postMessage({ type: 'log', entry }); } catch (e) { /* gone */ }
  }
}

// ---------------------------------------------------------------------------
// Offscreen parser (fast mode)
// ---------------------------------------------------------------------------

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  if (creatingOffscreen) { await creatingOffscreen; return; }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'src/offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: 'Parse fetched archive HTML to extract article links.'
  });
  try { await creatingOffscreen; } finally { creatingOffscreen = null; }
}

async function fetchScrape(url) {
  let resp;
  try {
    resp = await fetch(url, {
      credentials: 'include',
      headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
    });
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
  if (resp.status === 404) return { status: 404, articles: [] };
  if (!resp.ok) return { blocked: true, http: resp.status };
  const html = await resp.text();
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    target: 'offscreen', cmd: 'parse', html, config: SITE_CONFIG
  });
  if (!res) return { blocked: true };
  if (res.error) return { error: res.error };
  if (res.challenge) return { blocked: true };
  return { status: 200, articles: res.articles };
}

async function fetchArticle(url) {
  let resp;
  try {
    resp = await fetch(url, {
      credentials: 'include',
      headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }
    });
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
  if (!resp.ok) return { blocked: true, http: resp.status };
  const html = await resp.text();
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    target: 'offscreen', cmd: 'parseArticle', html, config: SITE_CONFIG
  });
  if (!res) return { blocked: true };
  if (res.error) return { error: res.error };
  if (res.challenge) return { blocked: true };
  return { details: res.details };
}

// ---------------------------------------------------------------------------
// Tab engine (reliable mode)
// ---------------------------------------------------------------------------

async function ensureTab() {
  if (scrapeTabId != null) {
    try { await chrome.tabs.get(scrapeTabId); return scrapeTabId; }
    catch (e) { scrapeTabId = null; }
  }
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  scrapeTabId = tab.id;
  return scrapeTabId;
}

async function closeTab() {
  if (scrapeTabId == null) return;
  try { await chrome.tabs.remove(scrapeTabId); } catch (e) { /* already gone */ }
  scrapeTabId = null;
}

function waitForComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(reason);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish('complete');
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function navigate(tabId, url, timeoutMs = 60000) {
  const done = waitForComplete(tabId, timeoutMs);
  await chrome.tabs.update(tabId, { url });
  return done;
}

async function scrapeTabDom(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/extractor.js'] });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (config) => ({
      challenge: self.detectChallenge(document),
      articles: self.extractArticles(document, config),
      title: document.title
    }),
    args: [SITE_CONFIG]
  });
  return result || { challenge: false, articles: [] };
}

async function handleChallenge(tabId) {
  setState({
    status: 'awaiting_challenge',
    message: 'Cloudflare check detected. Complete it in the opened tab - collection resumes automatically.'
  });
  log('[!] Cloudflare challenge. Focus the opened tab and complete the check.');
  try {
    await chrome.tabs.update(tabId, { active: true });
    const t = await chrome.tabs.get(tabId);
    if (t && t.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
  } catch (e) { /* ignore */ }

  job.continueChallenge = false;
  const deadline = Date.now() + job.challengeTimeoutMs;
  while (Date.now() < deadline) {
    if (job.abort) return;
    if (job.continueChallenge) break;
    await sleep(3000);
    let r = null;
    try { r = await scrapeTabDom(tabId); } catch (e) { /* retry */ }
    if (r && !r.challenge) break; // cleared
  }
  setState({ status: 'running', message: '' });
  try { await chrome.tabs.update(tabId, { active: false }); } catch (e) { /* ignore */ }
}

async function tabScrape(url) {
  const tabId = await ensureTab();
  await navigate(tabId, url);
  await sleep(job.settleMs);
  let res = await scrapeTabDom(tabId);
  if (res && res.challenge) {
    await handleChallenge(tabId);
    if (job.abort) return { aborted: true };
    res = await scrapeTabDom(tabId);
    if (res && res.challenge) return { blocked: true, articles: [] };
  }
  return { articles: (res && res.articles) || [] };
}

async function scrapeTabArticle(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/extractor.js'] });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (config) => ({
      challenge: self.detectChallenge(document),
      details: self.extractArticleDetails(document, config)
    }),
    args: [SITE_CONFIG]
  });
  return result || { challenge: false, details: null };
}

async function tabArticle(url) {
  const tabId = await ensureTab();
  await navigate(tabId, url);
  await sleep(Math.min(job.settleMs, 1500));
  let res = await scrapeTabArticle(tabId);
  if (res && res.challenge) {
    await handleChallenge(tabId);
    if (job.abort) return { aborted: true };
    res = await scrapeTabArticle(tabId);
    if (res && res.challenge) return { blocked: true };
  }
  return { details: (res && res.details) || null };
}

// Article-detail dispatcher (fast -> tab fallback), mirroring getPage.
async function getPageDetails(url) {
  if (job.engine === 'fetch') {
    const r = await fetchArticle(url);
    if (r.details) return r;
    if (r.blocked) return await tabArticle(url);
    if (r.error) return await tabArticle(url);
    return r;
  }
  return await tabArticle(url);
}

// ---------------------------------------------------------------------------
// Page fetch dispatcher (fast → tab fallback)
// ---------------------------------------------------------------------------

async function getPage(url) {
  if (job.engine === 'fetch') {
    const r = await fetchScrape(url);
    if (r.status === 404) return r;
    if (r.articles) return r;
    if (r.blocked) {
      log('    fast mode blocked; falling back to tab for this page');
      return await tabScrape(url);
    }
    if (r.error) {
      log('    fast mode error (' + r.error + '); falling back to tab');
      return await tabScrape(url);
    }
    return r;
  }
  return await tabScrape(url);
}

// ---------------------------------------------------------------------------
// Ingest / dedup
// ---------------------------------------------------------------------------

// Inclusive ISO-day filter. Articles without a known day are kept (never dropped)
// so data is not silently lost; enrichment can refine the date later.
function inFilter(date, filter) {
  if (!filter) return true;
  if (!date) return true;
  if (filter.start && date < filter.start) return false;
  if (filter.end && date > filter.end) return false;
  return true;
}

function bestDate(a) {
  // Only a real per-article date. Do NOT fabricate month-01: that would push
  // undated listing entries (for example the featured hero) out of a date range
  // and silently drop the newest articles. Unknown stays '' and is kept.
  return a.listDate || '';
}

function ingest(articles, filter) {
  const added = [];
  for (const a of articles) {
    if (!a || !a.url || job.seen.has(a.url)) continue;
    const date = bestDate(a);
    if (!inFilter(date, filter)) continue;
    const rec = {
      date, title: a.title, url: a.url,
      website: '', emails: '', scraped_at: job.scrapedAt
    };
    job.records.push(rec);
    job.seen.add(a.url);
    added.push(rec);
    state.newThisRun++;
  }
  state.totalRecords = job.records.length;
  return added;
}

// Remove a record collected this run (used when enrichment reveals its real
// date falls outside the requested range).
function removeRecord(rec) {
  const i = job.records.indexOf(rec);
  if (i !== -1) job.records.splice(i, 1);
  job.seen.delete(rec.url);
  if (state.newThisRun > 0) state.newThisRun--;
  state.totalRecords = job.records.length;
}

async function flush() {
  await setRecords(job.records);
  await saveState();
}

// ---------------------------------------------------------------------------
// Task processors
// ---------------------------------------------------------------------------

// True when every article on a page is older than the range start, meaning
// deeper (older) pages cannot contain anything in range. Only meaningful when a
// start bound exists and at least one article carried a real date.
function allOlderThanStart(arts, filter) {
  if (!filter || !filter.start) return false;
  let sawDated = false;
  for (const a of arts) {
    const d = a.listDate;
    if (!d) continue;
    sawDated = true;
    if (d >= filter.start) return false;
  }
  return sawDated;
}

async function processMonth(task, filter) {
  const monthKey = `${task.year}-${pad(task.month)}`;
  log(`[*] Month ${monthKey} (pagination)`);
  let prevFirst = null;
  for (let page = 1; page <= SITE_CONFIG.maxMonthPages; page++) {
    if (job.abort) return;
    const url = monthUrl(SITE_CONFIG.base, task.year, task.month, page);
    setState({ currentUrl: url });
    log(`    page ${page}: ${url}`);
    const res = await getPage(url);
    if (res.aborted) return;
    if (res.status === 404) { log('      end of month (404)'); break; }
    if (res.blocked) { log('      blocked; stopping this month'); break; }
    if (res.error) { log('      error: ' + res.error); break; }
    const raw = res.articles || [];
    if (raw.length === 0) { log('      no articles, stopping'); break; }

    // Keep only links that belong to this month. Archive pages also carry
    // recent-posts and related widgets that link to other months.
    const arts = raw.filter((a) => !a.urlMonth || a.urlMonth === monthKey);
    if (arts.length === 0) { log('      no in-month articles, stopping'); break; }

    if (prevFirst && arts[0] && arts[0].url === prevFirst) {
      log('      page repeated, stopping month'); break;
    }
    prevFirst = arts[0] ? arts[0].url : null;

    // Articles not seen on a previous page. The repeating recent-posts widget is
    // already in job.seen after page 1, so basing the stop on these avoids the
    // widget's recent dates keeping us from stopping.
    const fresh = arts.filter((a) => !job.seen.has(a.url));

    const added = ingest(arts, filter);
    state.pagesScanned++;
    log(`      found ${arts.length}, +${added.length} new`);

    if (job.enrich && added.length) await enrichRecords(added);
    if (job.abort) return;

    if (allOlderThanStart(fresh, filter)) { log('      reached articles older than the start date, stopping month'); break; }
    if (job.stopAtSeen && fresh.length === 0) { log('      whole page already collected, stopping month'); break; }
    await sleep(job.delayMs);
  }
}

async function processHomepage(task, filter) {
  setState({ currentUrl: task.url });
  log('[*] Homepage safety net -> ' + task.url);
  const res = await getPage(task.url);
  if (res.aborted) return;
  if (res.blocked) { log('    blocked on homepage.'); return; }
  if (res.error) { log('    error: ' + res.error); return; }
  const arts = res.articles || [];
  const added = ingest(arts, filter);
  state.pagesScanned++;
  log(`    found ${arts.length}, +${added.length} new`);
  if (job.enrich && added.length) await enrichRecords(added);
}

// ---------------------------------------------------------------------------
// Enrichment: visit each newly collected article to capture its real published
// date, clean title, company website, and any emails (including Cloudflare-
// obfuscated ones). Runs inline right after each page so the table fills in as
// the crawl proceeds. When a date range is active, an article whose real date
// turns out to be outside the range is dropped here.
// ---------------------------------------------------------------------------

async function enrichRecords(list) {
  state.enrichTotal += list.length;
  for (let i = 0; i < list.length; i++) {
    if (job.abort) { await flush(); return; }
    const rec = list[i];
    setState({ currentUrl: rec.url });
    const res = await getPageDetails(rec.url);
    if (res && res.aborted) { await flush(); return; }
    const d = res && res.details;
    if (d) {
      if (d.publishedDate) rec.date = d.publishedDate;
      if (d.title && d.title.length >= 6) rec.title = d.title;
      rec.website = d.website || '';
      rec.emails = (d.emails || []).join('; ');
      const bits = [];
      if (rec.website) bits.push(rec.website);
      if (rec.emails) bits.push(rec.emails);
      log(`      [+] ${rec.title.slice(0, 46)} -> ${bits.join(' | ') || 'no site/email'}`);
    } else if (res && res.blocked) {
      log(`      [!] blocked on ${rec.url}`);
    } else if (res && res.error) {
      log(`      [x] ${res.error}`);
    }
    // Drop if the real date is now known to be outside the requested range.
    if (job.filter && rec.date && !inFilter(rec.date, job.filter)) {
      removeRecord(rec);
    }
    state.enrichDone++;
    if ((i + 1) % 5 === 0) await flush(); else broadcastState();
    await sleep(job.delayMs);
  }
  await flush();
}

// ---------------------------------------------------------------------------
// Run driver
// ---------------------------------------------------------------------------

async function startJob(msg) {
  if (state.status === 'running' || state.status === 'awaiting_challenge') {
    log('[!] A run is already active.');
    return;
  }

  let plan;
  try {
    plan = buildTasks(msg.params);
  } catch (e) {
    setState({ status: 'error', message: 'Invalid range: ' + String(e) });
    await saveState();
    return;
  }
  const { tasks, label, filter } = plan;
  if (!tasks.length) {
    setState({ status: 'error', message: 'Nothing to collect for that range.' });
    await saveState();
    return;
  }

  const existing = await getRecords();
  job = {
    abort: false,
    continueChallenge: false,
    engine: msg.engine === 'fetch' ? 'fetch' : 'tab',
    delayMs: clampInt(msg.delayMs, 200, 10000, 1200),
    settleMs: clampInt(msg.settleMs, 800, 15000, 2500),
    challengeTimeoutMs: 4 * 60 * 1000,
    filter: filter || null,
    enrich: !!msg.enrich,
    stopAtSeen: msg.stopAtSeen !== false,
    records: existing.slice(),
    seen: new Set(existing.map((r) => r.url)),
    scrapedAt: new Date().toISOString()
  };

  logBuffer = [];
  state = {
    ...DEFAULT_STATE,
    status: 'running',
    mode: msg.params.mode,
    label,
    engine: job.engine,
    totalTasks: tasks.length,
    doneTasks: 0,
    totalRecords: job.records.length,
    newThisRun: 0,
    pagesScanned: 0,
    startedAt: Date.now(),
    message: ''
  };
  await saveState();
  log(`[*] Start: ${label} - engine=${job.engine}, existing=${existing.length}` +
      (job.enrich ? ', enrichment on' : ''));

  try {
    for (let i = 0; i < tasks.length; i++) {
      if (job.abort) break;
      const t = tasks[i];
      if (t.type === 'month') await processMonth(t, job.filter);
      else if (t.type === 'homepage') await processHomepage(t, job.filter);
      state.doneTasks = i + 1;
      await flush();
      if (i < tasks.length - 1) await sleep(job.delayMs);
    }
  } catch (e) {
    log('[x] Fatal: ' + String(e && e.message ? e.message : e));
    state.status = 'error';
    state.message = String(e && e.message ? e.message : e);
  }

  if (state.status !== 'error') {
    state.status = job.abort ? 'stopped' : 'done';
  }
  state.finishedAt = Date.now();
  await flush();
  log(`[+] ${state.status.toUpperCase()} - ${state.newThisRun} new, ${state.totalRecords} total`);
  await closeTab();
  job = null;
}
