// extractor.js
// IMPORTANT: this is a *classic* script (no import/export). It runs unmodified
// in three places: injected into a live finsmes tab, loaded in the offscreen
// document to parse fetched HTML, and for both listing pages and article pages.
// One copy means extraction never drifts between engines.

(function (root) {
  'use strict';

  var MONTHS = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
    august: 8, september: 9, october: 10, november: 11, december: 12,
    jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
    oct: 10, nov: 11, dec: 12
  };

  var JUNK_HOST = [
    'finsmes.com', 'facebook.com', 'fb.com', 'twitter.com', 'x.com', 't.co',
    'whatsapp.com', 'linkedin.com', 'lnkd.in', 'gravatar.com', 'instagram.com',
    'youtube.com', 'youtu.be', 'pinterest.com', 'reddit.com', 't.me',
    'telegram.me', 'wp.com', 'wordpress.org', 'wordpress.com', 'google.com',
    'gstatic.com', 'googletagmanager.com', 'doubleclick.net',
    'googlesyndication.com', 'feedburner.com', 'sharethis.com', 'addthis.com',
    'tumblr.com', 'flipboard.com', 'mailchimp.com', 'list-manage.com',
    'technologywire.com', 'vcwire.tech'
  ];

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function cleanText(t) { return (t || '').replace(/\s+/g, ' ').trim(); }

  // Flatten an element's text with a break after every element boundary, so
  // adjacent inline elements never merge into one token. Dependency-free (no
  // TreeWalker / NodeFilter) so it behaves identically in a tab, the offscreen
  // document, and tests.
  function collectText(node) {
    if (!node) return '';
    var parts = [];
    (function walk(n) {
      for (var c = n.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3) parts.push(c.nodeValue || '');
        else if (c.nodeType === 1) { walk(c); parts.push('\n'); }
      }
    })(node);
    return parts.join('');
  }

  function hostOf(url) {
    try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
    catch (e) { return ''; }
  }
  function isJunkHost(host) {
    if (!host) return true;
    for (var i = 0; i < JUNK_HOST.length; i++) {
      var j = JUNK_HOST[i];
      if (host === j || host.slice(-(j.length + 1)) === '.' + j) return true;
    }
    return false;
  }

  function normalizeDate(s) {
    if (!s) return '';
    s = String(s);
    var m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
    if (m) {
      var mo = MONTHS[m[1].toLowerCase()];
      if (mo) return m[3] + '-' + pad2(mo) + '-' + pad2(parseInt(m[2], 10));
    }
    m = s.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/);
    if (m) {
      var d = parseInt(m[1], 10), mm = parseInt(m[2], 10);
      if (d <= 31 && mm <= 12) return m[3] + '-' + pad2(mm) + '-' + pad2(d);
    }
    return '';
  }

  function dateFromTime(t) {
    if (!t) return '';
    var attr = t.getAttribute && (t.getAttribute('datetime') || t.getAttribute('content'));
    return normalizeDate(attr) || normalizeDate(t.textContent);
  }

  // Cloudflare email obfuscation: [data-cfemail="HEX"] and links to
  // /cdn-cgi/l/email-protection#HEX. First hex byte is the XOR key.
  function cfDecode(hex) {
    if (!hex) return '';
    try {
      var out = '';
      var key = parseInt(hex.substr(0, 2), 16);
      for (var i = 2; i < hex.length; i += 2) {
        out += String.fromCharCode(parseInt(hex.substr(i, 2), 16) ^ key);
      }
      return /@/.test(out) ? out.toLowerCase() : '';
    } catch (e) { return ''; }
  }

  function detectChallenge(doc) {
    var title = (doc.title || '').toLowerCase();
    var body = '';
    try { body = ((doc.body && doc.body.textContent) || '').toLowerCase().slice(0, 4000); }
    catch (e) { /* ignore */ }
    return (
      title.indexOf('just a moment') !== -1 ||
      title.indexOf('attention required') !== -1 ||
      body.indexOf('verify you are human') !== -1 ||
      body.indexOf('checking your browser') !== -1 ||
      body.indexOf('needs to review the security of your connection') !== -1 ||
      body.indexOf('enable javascript and cookies to continue') !== -1
    );
  }

  function urlMonthOf(url) {
    var m = url.match(/\/(\d{4})\/(\d{2})\//);
    return m ? (m[1] + '-' + m[2]) : '';
  }

  // Human-readable title from the permalink slug, as a last resort so an article
  // with a valid URL is never dropped just because its listing text was empty
  // (for example a big "featured" module whose only link is the image).
  function titleFromSlug(url) {
    try {
      var m = url.match(/\/([^\/]+)\.html(?:$|\?)/);
      if (!m) return '';
      var s = m[1].replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
      return s.replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    } catch (e) { return ''; }
  }

  function listingDateForAnchor(a, linkSelector) {
    var el = a;
    for (var depth = 0; depth < 8 && el; depth++) {
      var t = el.querySelector ? el.querySelector('time') : null;
      if (t) {
        // Only trust this <time> if the container holds a single article (the
        // anchor's own, possibly linked several times). More than one distinct
        // article URL means this is a shared container and the date would bleed
        // from a neighbour, so keep climbing / give up.
        var links = el.querySelectorAll ? el.querySelectorAll(linkSelector) : [];
        var set = Object.create(null), n = 0;
        for (var i = 0; i < links.length; i++) {
          var h = links[i].getAttribute('href') || '';
          if (h && !set[h]) { set[h] = 1; n++; }
          if (n > 1) break;
        }
        if (n <= 1) {
          var d = dateFromTime(t);
          if (d) return d;
        }
      }
      el = el.parentElement;
    }
    return '';
  }

  // Choose the best title for an anchor, with a quality score so that when the
  // same article is linked several times (image, headline, "read more"), the
  // real headline wins over an image/slug fallback.
  function titleCandidate(a, full, minLen) {
    var t = cleanText(a.textContent);
    if (t.length >= minLen) return { title: t, score: 5 };
    var h = a.closest ? a.closest('h1,h2,h3,h4') : null;
    if (h) { var ht = cleanText((h.textContent || '').split('\n')[0]); if (ht.length >= minLen) return { title: ht, score: 4 }; }
    var ta = cleanText(a.getAttribute('title'));
    if (ta.length >= minLen) return { title: ta, score: 4 };
    var img = a.querySelector ? a.querySelector('img[alt]') : null;
    if (img) { var al = cleanText(img.getAttribute('alt')); if (al.length >= minLen) return { title: al, score: 3 }; }
    var ar = cleanText(a.getAttribute('aria-label'));
    if (ar.length >= minLen) return { title: ar, score: 3 };
    var hh = a.closest ? a.closest('article,.post,.entry,li') : null;
    if (hh) { var h2 = cleanText((hh.textContent || '').split('\n')[0]); if (h2.length >= minLen) return { title: h2, score: 2 }; }
    var slug = titleFromSlug(full);
    if (slug.length >= 3) return { title: slug, score: 1 };
    return { title: '', score: 0 };
  }

  // LISTING extraction. Returns [{ title, url, urlMonth, listDate }].
  function extractArticles(doc, config) {
    var base = config.base;
    var excludes = config.excludePatterns || [];
    var minLen = config.minTitleLen || 8;
    var linkSelector = config.linkSelector;

    var map = Object.create(null);
    var order = [];

    var anchors;
    try { anchors = doc.querySelectorAll(linkSelector); }
    catch (e) { return []; }

    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      var href = a.getAttribute('href') || '';
      if (!href) continue;

      var full;
      try { full = new URL(href, base).href; } catch (e) { continue; }
      var hashIdx = full.indexOf('#');
      if (hashIdx !== -1) full = full.slice(0, hashIdx);

      var skip = false;
      for (var j = 0; j < excludes.length; j++) {
        if (full.indexOf(excludes[j]) !== -1) { skip = true; break; }
      }
      if (skip) continue;

      var cand = titleCandidate(a, full, minLen);
      if (cand.score === 0) continue;

      var existing = map[full];
      if (existing) {
        if (cand.score > existing.score) { existing.title = cand.title; existing.score = cand.score; }
        if (!existing.listDate) {
          var ld2 = listingDateForAnchor(a, linkSelector);
          if (ld2) existing.listDate = ld2;
        }
      } else {
        map[full] = {
          title: cand.title,
          score: cand.score,
          url: full,
          urlMonth: urlMonthOf(full),
          listDate: listingDateForAnchor(a, linkSelector)
        };
        order.push(full);
      }
    }

    var out = [];
    for (var k = 0; k < order.length; k++) {
      var r = map[order[k]];
      out.push({ title: r.title, url: r.url, urlMonth: r.urlMonth, listDate: r.listDate });
    }
    return out;
  }

  // ARTICLE extraction (enrichment).
  // Returns { publishedDate, website, websites, emails, tags, title }.
  function extractArticleDetails(doc, config) {
    var out = { publishedDate: '', website: '', websites: [], emails: [], tags: [], title: '' };

    out.title = cleanText(doc.title).replace(/\s*[-|]\s*FinSMEs.*$/i, '');

    var meta = doc.querySelector('meta[property="article:published_time"], meta[name="article:published_time"]');
    if (meta) out.publishedDate = normalizeDate(meta.getAttribute('content'));
    if (!out.publishedDate) {
      var tt = doc.querySelector('time[datetime]');
      if (tt) out.publishedDate = dateFromTime(tt);
    }
    if (!out.publishedDate) out.publishedDate = normalizeDate((doc.body && doc.body.textContent) || '');

    var content = doc.querySelector(
      '.td-post-content, .tdb_single_content, .td-ss-main-content, article .tdb-block-inner, article'
    ) || doc.body;

    // Company website(s): external content links, minus known junk.
    var sites = [], sseen = Object.create(null);
    if (content) {
      var links = content.querySelectorAll('a[href]');
      for (var i = 0; i < links.length; i++) {
        var lh = links[i].getAttribute('href') || '';
        if (!lh || lh.charAt(0) === '#') continue;
        if (/^(mailto:|tel:|javascript:)/i.test(lh)) continue;
        if (lh.indexOf('/cdn-cgi/l/email-protection') !== -1) continue;
        var abs;
        try { abs = new URL(lh, config.base).href; } catch (e) { continue; }
        if (!/^https?:/i.test(abs)) continue;
        var host = hostOf(abs);
        if (isJunkHost(host)) continue;
        var clean = abs.split('#')[0];
        if (!sseen[clean]) { sseen[clean] = true; sites.push(clean); }
      }
    }
    out.websites = sites;
    out.website = sites.length ? sites[0] : '';

    // Emails: mailto links, Cloudflare-obfuscated addresses, then plain text.
    var eseen = Object.create(null), emails = [];
    var addEmail = function (e) {
      e = (e || '').trim().toLowerCase();
      if (e && /@/.test(e) && !eseen[e]) { eseen[e] = true; emails.push(e); }
    };
    var mailtos = doc.querySelectorAll('a[href^="mailto:"]');
    for (var k = 0; k < mailtos.length; k++) {
      addEmail((mailtos[k].getAttribute('href') || '').replace(/^mailto:/i, '').split('?')[0]);
    }
    // Cloudflare: data-cfemail attributes
    var cfEls = doc.querySelectorAll('[data-cfemail]');
    for (var c = 0; c < cfEls.length; c++) addEmail(cfDecode(cfEls[c].getAttribute('data-cfemail')));
    // Cloudflare: protection links carrying the hex in the fragment
    var cfLinks = doc.querySelectorAll('a[href*="/cdn-cgi/l/email-protection#"]');
    for (var p = 0; p < cfLinks.length; p++) {
      var frag = (cfLinks[p].getAttribute('href') || '').split('#')[1];
      addEmail(cfDecode(frag));
    }
    // Plain text addresses in the body. Collect text node by node with a break
    // after each element so adjacent inline elements (for example
    // <strong>Name</strong><strong>email</strong>) do not merge and pull the
    // name into the email local part.
    var text = collectText(content);
    var re = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, mm2;
    while ((mm2 = re.exec(text)) !== null) addEmail(mm2[0]);
    out.emails = emails;

    var tagEls = doc.querySelectorAll('a[href*="/tag/"]'), tseen = Object.create(null);
    for (var q = 0; q < tagEls.length; q++) {
      var tg = cleanText(tagEls[q].textContent);
      if (tg && !tseen[tg.toLowerCase()]) { tseen[tg.toLowerCase()] = true; out.tags.push(tg); }
    }

    return out;
  }

  root.detectChallenge = detectChallenge;
  root.extractArticles = extractArticles;
  root.extractArticleDetails = extractArticleDetails;
  root.normalizeDate = normalizeDate;
  root.cfDecode = cfDecode;
})(typeof self !== 'undefined' ? self : this);
