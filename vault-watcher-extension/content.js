(() => {
  const POLL_MS = 1500;
  const STABLE_MS = 4000;
  let lastHash = null;
  let candidateHash = null;
  let candidateSince = 0;
  let initialized = false;

  function clean(s) {
    return (s || '').replace(/\s+/g, ' ').replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, '').trim();
  }

  function extractItems() {
    const selectors = [
      '[class*="product"]', '[class*="item-card"]', '[class*="product-card"]',
      '[data-product-id]', '[data-item-id]', '.card', 'article'
    ];
    const seen = new Set();
    const items = [];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const txt = clean(el.innerText);
        if (txt.length < 8 || txt.length > 600) continue;
        const looksLikeInventory = /\$\s*\d|sold out|select|bourbon|whiskey|whisky|rye|bottle|year|yr\b/i.test(txt);
        if (!looksLikeInventory || seen.has(txt)) continue;
        seen.add(txt); items.push(txt);
      }
    }
    if (items.length) return items.slice(0, 40);

    // Conservative fallback: visible main-page text only. Strip common account/navigation noise.
    const main = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
    const text = clean(main?.innerText || '');
    return text ? text.split(/(?=\$\s*\d|Sold Out|Select)/i).map(clean).filter(x => x.length > 8).slice(0, 40) : [];
  }

  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function getConfig() {
    return await chrome.storage.local.get(['endpoint', 'secret', 'enabled']);
  }

  async function report(items, hash) {
    const cfg = await getConfig();
    if (cfg.enabled === false || !cfg.endpoint || !cfg.secret) return;
    const endpoint = cfg.endpoint.replace(/\/$/, '') + '/vault-reload';
    try {
      await fetch(endpoint, {
        method: 'POST',
        headers: {'Content-Type':'application/json','x-vault-watch-secret':cfg.secret},
        body: JSON.stringify({type:'inventory-change', hash, items, url:location.href, detectedAt:new Date().toISOString()})
      });
    } catch (e) {
      console.debug('ABC Vault watcher report failed', e);
    }
  }

  async function check() {
    if (!/theabcvault\.com$/i.test(location.hostname)) return;
    const items = extractItems();
    if (!items.length) return;
    const hash = await sha256(items.join('\n---\n'));

    if (!initialized) {
      lastHash = hash;
      candidateHash = hash;
      candidateSince = Date.now();
      initialized = true;
      return;
    }
    if (hash === lastHash) {
      candidateHash = hash; candidateSince = Date.now(); return;
    }
    if (hash !== candidateHash) {
      candidateHash = hash; candidateSince = Date.now(); return;
    }
    if (Date.now() - candidateSince >= STABLE_MS) {
      lastHash = hash;
      await report(items, hash);
      candidateSince = Date.now();
    }
  }

  setInterval(check, POLL_MS);
  check();
})();
