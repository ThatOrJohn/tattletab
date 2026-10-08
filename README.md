# Tattletab

A live graph of everyone your browser talks to: the pages you visit, and the
companies and hosts those pages pull in. You can record sessions and replay
them later. Everything runs on your machine, and nothing is sent anywhere
except `127.0.0.1`.

```
Chrome ── Tattletab (observe-only extension) ──POST──▶ 127.0.0.1:8787 ──▶ SQLite
                                                              │
                                     browser tab ◀── UI + live stream (SSE)
```

## Run it

Requires Python 3.9+ (standard library only, nothing to install).

1. **Start the daemon:**
   ```
   cd tattletab
   python3 tattletab.py
   ```
2. **Load the extension:**
   - Open `chrome://extensions` and turn on **Developer mode**.
   - Click **Load unpacked** and choose the `extension/` folder.
   - Pin **Tattletab**. Its popup shows whether the daemon is reachable.
3. **Open http://127.0.0.1:8787/** and click **Start recording**, then browse in
   other tabs.

## Using the UI

- **White rings** are pages. **Colored dots** are the companies (or hosts)
  those pages loaded from, colored by category.
- A **white outline** means the company appeared on more than one page. These
  are the cross-site trackers.
- A **dashed red ring** means some requests failed or were blocked (by an ad
  blocker, for example).
- **Companies / Hosts** switches between grouping by owner and showing raw
  hostnames.
- **Trackers only** hides CDN and content nodes.
- Click a legend item to hide that category.
- Hover or click a node to see its hosts and the pages it appeared on. Clicking
  a row in the right panel does the same.
- **Hollow dots** are fourth parties: companies no page loaded directly, which
  arrived inside another company's frame.
- **Edge styles:**
  - A plain line means the page loaded it.
  - An arrow means it was loaded inside a third-party frame.
  - A dashed purple arrow means a redirect, which is usually ad-tech ID sync.

## The fun stuff (all driven by your real data)

- **Entourage** (toolbar, or press `E`): you walk down a street of the sites
  you visited. Each company that has now seen you on 2+ sites steps out of the
  storefront where it caught up with you and joins the trench-coat crowd behind
  you. Coat color is the company's category, and bigger figures have followed
  you to more sites. The roster shows the most devoted followers; hover anyone
  in the crowd to see which sites they saw you on. It works live and during
  replay.
- **Geiger counter** (`○ Geiger` next to the play controls): a click for every
  tracker request that actually went out (blocked ones stay silent), plus a
  cash register for ad requests, throttled so heavy pages don't drown you out.
  Live sound keeps playing while the Tattletab page is in a background tab, so you
  can hear a page as you browse it in another window. It also plays along with
  replays.
- **Receipt** (session **Receipt** link, or press `R`): a thermal-printer
  receipt for the session. It lists each site as a line item, then requests,
  companies, fourth parties, ID-sync handoffs, tracker surcharge, ad-blocker
  coupon, and entourage acquired.
  - **Copy image** puts a PNG on your clipboard. If your browser doesn't allow
    that, it downloads the PNG instead.
  - **Copy text** copies a 40-column plain-text version that lines up in any
    monospace font (Slack code blocks, GitHub, terminals).
  - **Print / PDF** prints just the receipt.

## Insight panels (right side)

| Tab | What it answers |
|---|---|
| **Who** | Every company your pages contacted, ranked by requests. |
| **Reach** | On how many distinct sites each company saw you. Covers this session, 7 days, 30 days, or all saved sessions. |
| **Chains** | Fourth parties and who brought them in, redirect hand-offs between companies, and loads from inside third-party frames. |
| **No tab** | Requests with no tab, grouped by the site that started them. Mostly service workers and prefetches. |
| **Blocked** | How many tracker requests your content blocker stopped, per company. Sorted by what got through. |

Some limits to know about:

- **Chains are a floor, not a full count.** Chrome reports which *frame*
  started a request, not which script. A third-party script that injects
  another script into the page itself still looks direct.
- **Blocked understates your blocker.** A blocked script never runs, so the
  requests it would have made never appear.
- **"No tab" can't show everything.** Chrome hides its own traffic and other
  extensions' traffic from extensions.
- **Timeline:** the bars show request volume, with tracker requests in red.
  Click or drag to scrub, press **▶** or Space to replay, and use **4×** to
  change speed. While recording, **LIVE** follows new traffic as it arrives.
- **Structured / Organic** layout. Structured (the default) places nodes by
  how connected they are:
  - **Leaves.** Companies or hosts contacted by only one page ring that page.
    The biggest sit on the inner ring, and categories run clockwise from 12
    o'clock as colored arcs.
  - **Bridges.** Nodes shared by several pages, or loading other companies, get
    room in proportion to their connections. They settle between the clusters
    they link, with brighter edges.
  - **Pages.** Each page reserves space for its rings, so busy pages don't pile
    into each other.

  Organic is a plain force-directed layout. Pinned nodes override both, and
  dragging a page brings its rings along.
- **Auto-fit** is on by default: the camera eases to keep the whole graph in
  view as it grows. Panning or zooming hands the camera to you. Click **Fit**
  or press `F` to turn auto-fit back on.
- **Drag any node** to move it, and it stays pinned where you drop it, shown by
  a small green pushpin. Double-click a pinned node, or select it and press
  `U`, to release it. **Unpin N** releases all of them. Pins are saved per
  session in this browser, so they survive reloads and replays.
- **Zoom:** use the mouse wheel or pinch, the **+ / − / ⤢** buttons at the
  bottom right, or the `+`, `-`, and `0` keys (`0` fits and turns auto-fit back
  on). Double-click empty space to zoom in there; shift-double-click zooms out.
- **Keyboard:** `F` turns auto-fit on, `U` unpins the selected node, `Esc`
  clears the selection, and `Space` plays or pauses.

## Privacy and safety defaults

- **Hostnames only.** Full URLs (paths and query strings) are discarded unless
  you run `python3 tattletab.py --full-urls`.
- **Automatic expiry.** Sessions older than 30 days are deleted at startup.
  Change this with `--retain-days N`, or use `0` to keep everything.
- **Loopback only.** The daemon binds to `127.0.0.1` only. It rejects
  non-loopback `Host` headers, which blocks DNS rebinding.
- **Ingest is locked down.** Ingest only accepts browser-extension origins, and
  the control endpoints only accept the UI's own origin. Websites you visit
  can't read, start, or pollute your captures.
- **File permissions.** The database is `data/tattletab.db`, readable only by
  your user.
- **No capture without a session.** Recording happens only while a session is
  running. The rest of the time, the extension's posts are simply discarded.

## Better company coverage (optional, one-time download)

The built-in table covers roughly 200 of the most common domains. For a much
broader map, download Disconnect's tracker list once and save it as
`data/disconnect.json`:

    https://raw.githubusercontent.com/disconnectme/disconnect-tracking-protection/master/services.json

It's loaded at startup and never re-fetched. The footer of the UI shows how
many domains it loaded.

## Known limits

- **Chrome only for now.** Edge, Brave, and Arc load the same extension.
  Safari's web-extension `webRequest` support is limited, so Safari would need
  a different capture path.
- **First-party grouping is approximate.** Registrable domains use a short
  suffix list rather than the full Public Suffix List, so a few unusual
  domains may group oddly.
- **Some requests have no page.** Requests from service workers or other
  extensions have no tab, so they land on a `(background)` node.
- **Brief gaps are possible.** Chrome can suspend the extension's service
  worker, so the first requests after it wakes may be attributed to their
  initiator instead of the tab's page, until the next navigation.

## Files

- `tattletab.py`: daemon (HTTP server, SQLite, live stream, cross-session reach query). Older databases are upgraded in place at startup.
- `enrich.py`: host → site → company and category, all offline
- `ui/`: `index.html`, `app.js`, and a bundled copy of `d3.min.js` (no CDN)
- `extension/`: the observe-only Chrome extension

## Upgrading from NetScope

This project was briefly called NetScope. If you have an older copy, copy its
`data/netscope.db` (and any `-wal`/`-shm` files next to it) into this folder's
`data/`. On first start the daemon renames it to `tattletab.db` and keeps all
your sessions. In Chrome, remove the old unpacked extension and load this
folder's `extension/` instead.

## Third-party code

- `ui/d3.min.js` is [D3](https://d3js.org) v7.9.0 by Mike Bostock, under the ISC
  license (`ui/d3.LICENSE`).
- The optional Disconnect tracker list isn't bundled; you download it yourself.
  Check its license before redistributing it.

