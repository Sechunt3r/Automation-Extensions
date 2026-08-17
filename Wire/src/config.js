// config.js
// Single source of truth for the target site and for turning a date-range
// request into a concrete list of pages to visit.
//
// The selectors and exclude patterns are copied verbatim from the original
// Python collector so the extension reproduces behavior you already validated.
// To adapt this for another WordPress-style archive, edit SITE_CONFIG only.

export const SITE_CONFIG = {
  key: 'finsmes',
  label: 'FinSMEs',
  base: 'https://www.finsmes.com',

  // Article links: date path + .html permalink (WordPress style on this site).
  linkSelector: "a[href*='/20'][href$='.html']",

  // Drop archive/taxonomy/paywall links that are not individual articles.
  // These are matched as substrings, so they must be specific: a bare word like
  // 'intelligence' would wrongly exclude a company called "Ocean Intelligence".
  excludePatterns: [
    '/tag/', '/category/', '/author/', '/page/',
    '/membership', 'finsmes-intelligence', 'pro_report'
  ],

  // Shortest acceptable title (chars). Below this we look at the parent heading.
  minTitleLen: 8,

  // Safety cap so month pagination can never loop forever.
  maxMonthPages: 120
};

// ---- date helpers (UTC-based to avoid timezone drift in arithmetic) ----

const pad = (n) => String(n).padStart(2, '0');

export function todayUTC() {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

export function parseISO(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function isoDay(d) {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function dayUrl(base, y, m, d) {
  return `${base}/${y}/${pad(m)}/${pad(d)}/`;
}

export function monthUrl(base, y, m, page = 1) {
  const root = `${base}/${y}/${pad(m)}/`;
  return page <= 1 ? root : `${root}page/${page}/`;
}

// Enumerate the (year, month) pairs spanning two dates, newest month first.
function monthsBetween(start, end) {
  const list = [];
  let y = end.getUTCFullYear();
  let m = end.getUTCMonth() + 1; // 1-12
  const startKey = start.getUTCFullYear() * 12 + start.getUTCMonth();
  while (y * 12 + (m - 1) >= startKey) {
    list.push({ year: y, month: m });
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
    if (list.length > 600) break; // hard safety
  }
  return list;
}

// Build the list of tasks for a collection run.
//
// FinSMEs permalinks are /YYYY/MM/slug.html with no day, so there are no daily
// archive pages. Every date-bounded mode therefore pages the *month* archives
// that cover the range and filters articles by their real published date (read
// from the listing's <time> element). Whole-month and year modes need no filter.
//
// params: { mode, since, days, from, to, month, year, includeHomepage }
// mode ∈ 'since' | 'days' | 'range' | 'month' | 'year' | 'current'
// Returns { tasks, label, filter } where:
//   task { type:'month', year, month } -> paginated month archive
//   task { type:'homepage' }           -> homepage safety net (recent modes)
//   filter { start, end } | null       -> inclusive ISO day bounds for keeping
export function buildTasks(params, cfg = SITE_CONFIG) {
  const tasks = [];
  let label = '';
  let filter = null;
  let addHomepage = false;

  const pushMonths = (start, end) => {
    for (const mm of monthsBetween(start, end)) {
      tasks.push({ type: 'month', year: mm.year, month: mm.month });
    }
  };

  const today = todayUTC();

  switch (params.mode) {
    case 'since': {
      const start = parseISO(params.since);
      pushMonths(start, today);
      filter = { start: isoDay(start), end: isoDay(today) };
      label = `since ${params.since} (inclusive)`;
      addHomepage = true;
      break;
    }
    case 'days': {
      const n = Math.max(1, parseInt(params.days, 10) || 1);
      const start = new Date(today.getTime() - (n - 1) * 86400000);
      pushMonths(start, today);
      filter = { start: isoDay(start), end: isoDay(today) };
      label = `last ${n} day(s)`;
      addHomepage = true;
      break;
    }
    case 'range': {
      const start = params.from ? parseISO(params.from)
        : new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
      const end = params.to ? parseISO(params.to) : today;
      pushMonths(start, end);
      filter = { start: isoDay(start), end: isoDay(end) };
      label = `${isoDay(start)} to ${isoDay(end)}`;
      addHomepage = true;
      break;
    }
    case 'month': {
      const [y, m] = params.month.split('-').map(Number);
      tasks.push({ type: 'month', year: y, month: m });
      label = `month ${params.month}`;
      break;
    }
    case 'year': {
      const y = parseInt(params.year, 10);
      for (let m = 12; m >= 1; m--) tasks.push({ type: 'month', year: y, month: m });
      label = `year ${y}`;
      break;
    }
    case 'current':
    default: {
      tasks.push({ type: 'month', year: today.getUTCFullYear(), month: today.getUTCMonth() + 1 });
      label = 'current month';
      break;
    }
  }

  if (addHomepage && params.includeHomepage !== false) {
    tasks.push({ type: 'homepage', url: cfg.base });
  }

  return { tasks, label, filter };
}
