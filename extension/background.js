// Tattletab — observe-only. Listens to webRequest completion/error events,
// batches small metadata records, and POSTs them to the local daemon.
// Nothing here blocks or modifies a request, so page loads are unaffected.

const DAEMON = "http://127.0.0.1:8787";
const FLUSH_MS = 500;
const MAX_BUFFER = 5000; // if the daemon is down, drop oldest rather than grow forever

let buffer = [];
let timer = null;
let lastStatus = { ok: null, at: 0, sent: 0, dropped: 0 };

// tabId -> top-level page URL (rebuilt from main_frame requests; the
// service worker may be restarted by Chrome, in which case we fall back
// to the request initiator until the next navigation).
const tabPages = new Map();

function isSelf(url) {
  return typeof url === "string" && url.startsWith(DAEMON);
}

function record(details, extra) {
  if (isSelf(details.url)) return;
  if (details.type === "main_frame") tabPages.set(details.tabId, details.url);
  const page = details.tabId >= 0 ? (tabPages.get(details.tabId) || details.initiator || null) : null;
  if (isSelf(page)) return;

  let size = null;
  if (details.responseHeaders) {
    const h = details.responseHeaders.find(x => x.name.toLowerCase() === "content-length");
    if (h && /^\d+$/.test(h.value)) size = Number(h.value);
  }

  buffer.push({
    ts: details.timeStamp,
    tab: details.tabId,
    type: details.type,
    method: details.method,
    url: details.url,
    page,
    initiator: details.initiator || null,
    status: details.statusCode ?? null,
    ip: details.ip || null,
    cached: !!details.fromCache,
    size,
    error: extra && extra.error ? extra.error : null,
    redirect: extra && extra.redirect ? extra.redirect : null
  });
  if (buffer.length > MAX_BUFFER) {
    lastStatus.dropped += buffer.length - MAX_BUFFER;
    buffer = buffer.slice(-MAX_BUFFER);
  }
  if (!timer) timer = setTimeout(flush, FLUSH_MS);
}

async function flush() {
  timer = null;
  if (!buffer.length) return;
  const batch = buffer;
  buffer = [];
  try {
    const r = await fetch(DAEMON + "/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch)
    });
    lastStatus = { ...lastStatus, ok: r.ok, at: Date.now(), sent: lastStatus.sent + (r.ok ? batch.length : 0) };
  } catch (e) {
    // Daemon not running: discard. Capture is best-effort by design.
    lastStatus = { ...lastStatus, ok: false, at: Date.now(), dropped: lastStatus.dropped + batch.length };
  }
}

const filter = { urls: ["<all_urls>"] };

chrome.webRequest.onCompleted.addListener(d => record(d), filter, ["responseHeaders"]);
chrome.webRequest.onErrorOccurred.addListener(d => record(d, { error: d.error }), filter);
// Each redirect hop is its own contact with a server (and onCompleted only
// reports the final URL), so record hops too. Ad-tech "cookie sync" shows up here.
chrome.webRequest.onBeforeRedirect.addListener(d => record(d, { redirect: d.redirectUrl }), filter);

chrome.tabs?.onRemoved?.addListener(id => tabPages.delete(id));

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg === "status") reply({ ...lastStatus, daemon: DAEMON });
});
