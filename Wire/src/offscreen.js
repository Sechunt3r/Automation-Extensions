// offscreen.js
// Runs in the offscreen document, which (unlike the service worker) has access
// to DOMParser. It receives raw HTML from the background worker, parses it, and
// returns extracted data using the shared extractor. Handles both listing pages
// ('parse') and single article pages ('parseArticle').

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return; // not for us
  if (msg.cmd === 'parse') {
    try {
      const doc = new DOMParser().parseFromString(msg.html, 'text/html');
      const challenge = self.detectChallenge(doc);
      const articles = challenge ? [] : self.extractArticles(doc, msg.config);
      sendResponse({ challenge, articles });
    } catch (e) {
      sendResponse({ error: String(e && e.message ? e.message : e) });
    }
    return true;
  }
  if (msg.cmd === 'parseArticle') {
    try {
      const doc = new DOMParser().parseFromString(msg.html, 'text/html');
      const challenge = self.detectChallenge(doc);
      const details = challenge ? null : self.extractArticleDetails(doc, msg.config);
      sendResponse({ challenge, details });
    } catch (e) {
      sendResponse({ error: String(e && e.message ? e.message : e) });
    }
    return true;
  }
});
