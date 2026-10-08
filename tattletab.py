#!/usr/bin/env python3
"""Tattletab daemon — local-only collector + UI server.

  python3 tattletab.py                 # listen on 127.0.0.1:8787
  python3 tattletab.py --full-urls     # also keep full URLs (path + query)
  python3 tattletab.py --retain-days 14

Standard library only. Binds to loopback, rejects requests whose Host header
isn't loopback (DNS-rebinding guard), and only accepts ingest from a browser
extension origin, so ordinary web pages can't read or pollute your data.
"""
import argparse
import json
import os
import queue
import signal
import sqlite3
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

from enrich import Enricher

ROOT = os.path.dirname(os.path.abspath(__file__))
UI_DIR = os.path.join(ROOT, "ui")
DATA_DIR = os.path.join(ROOT, "data")

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY, name TEXT, started REAL, stopped REAL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, session INTEGER, ts REAL, tab INTEGER, type TEXT,
  method TEXT, host TEXT, site TEXT, company TEXT, category TEXT, party TEXT,
  page_site TEXT, url TEXT, status INTEGER, ip TEXT, cached INTEGER,
  size INTEGER, error TEXT
);
CREATE INDEX IF NOT EXISTS ev_session ON events(session, ts);
"""

# Columns added in v0.2; ALTERed into older databases at startup.
V2_COLS = {
    "init_host": "TEXT", "init_site": "TEXT", "init_company": "TEXT", "init_party": "TEXT",
    "redir_host": "TEXT", "redir_company": "TEXT", "redir_category": "TEXT", "redir_party": "TEXT",
}

EVENT_COLS = ["ts", "tab", "type", "method", "host", "site", "company", "category",
              "party", "page_site", "url", "status", "ip", "cached", "size", "error",
              *V2_COLS]


class Store:
    def __init__(self, path, full_urls, retain_days):
        self.full_urls = full_urls
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        have = {r[1] for r in self.db.execute("PRAGMA table_info(events)")}
        for col, typ in V2_COLS.items():
            if col not in have:
                self.db.execute(f"ALTER TABLE events ADD COLUMN {col} {typ}")
        self.db.execute("CREATE INDEX IF NOT EXISTS ev_ts ON events(ts)")
        # Any session left open by a crash is closed at its last event.
        self.db.execute("""UPDATE sessions SET stopped = COALESCE(
            (SELECT MAX(ts) FROM events WHERE session = sessions.id), started)
            WHERE stopped IS NULL""")
        if retain_days:
            cutoff = time.time() * 1000 - retain_days * 86400_000
            old = [r[0] for r in self.db.execute("SELECT id FROM sessions WHERE started < ?", (cutoff,))]
            for sid in old:
                self.delete_session(sid, commit=False)
            if old:
                print(f"[store] expired {len(old)} session(s) older than {retain_days} days")
        self.db.commit()
        self.active = None

    def start(self, name):
        with self.lock:
            if self.active:
                return self.active
            now = time.time() * 1000
            cur = self.db.execute("INSERT INTO sessions(name, started) VALUES (?, ?)",
                                  (name or time.strftime("Session %b %d %H:%M"), now))
            self.db.commit()
            self.active = cur.lastrowid
            return self.active

    def stop(self):
        with self.lock:
            if not self.active:
                return None
            self.db.execute("UPDATE sessions SET stopped=? WHERE id=?", (time.time() * 1000, self.active))
            self.db.commit()
            sid, self.active = self.active, None
            return sid

    def insert(self, rows):
        with self.lock:
            if not self.active:
                return 0
            self.db.executemany(
                f"INSERT INTO events(session, {', '.join(EVENT_COLS)}) VALUES (?{', ?' * len(EVENT_COLS)})",
                [(self.active, *[r[c] for c in EVENT_COLS]) for r in rows])
            self.db.commit()
            return len(rows)

    def sessions(self):
        with self.lock:
            q = """SELECT s.id, s.name, s.started, s.stopped, COUNT(e.id),
                          COUNT(DISTINCT e.host), COUNT(DISTINCT CASE WHEN e.party='third' THEN e.company END)
                   FROM sessions s LEFT JOIN events e ON e.session = s.id
                   GROUP BY s.id ORDER BY s.started DESC"""
            return [dict(id=r[0], name=r[1], started=r[2], stopped=r[3], requests=r[4],
                         hosts=r[5], third_party_companies=r[6], active=(r[0] == self.active))
                    for r in self.db.execute(q)]

    def events(self, sid):
        with self.lock:
            cur = self.db.execute(f"SELECT {', '.join(EVENT_COLS)} FROM events WHERE session=? ORDER BY ts", (sid,))
            return [dict(zip(EVENT_COLS, r)) for r in cur]

    def reach(self, days):
        """Cross-session reach: on how many distinct sites did each company appear?"""
        cutoff = (time.time() - days * 86400) * 1000 if days else 0
        with self.lock:
            total = self.db.execute(
                "SELECT COUNT(DISTINCT page_site) FROM events WHERE ts >= ? AND party != 'background'",
                (cutoff,)).fetchone()[0]
            rows = self.db.execute(
                """SELECT company, COUNT(DISTINCT page_site) AS sites, COUNT(*) AS req,
                          MAX(CASE WHEN category IN ('ads','analytics','fingerprinting') THEN 1 ELSE 0 END)
                   FROM events WHERE ts >= ? AND party = 'third'
                   GROUP BY company ORDER BY sites DESC, req DESC LIMIT 100""", (cutoff,)).fetchall()
            sessions = self.db.execute(
                "SELECT COUNT(DISTINCT session) FROM events WHERE ts >= ?", (cutoff,)).fetchone()[0]
        # Category shown is the most "tracking" one the company was seen as.
        cats = {}
        with self.lock:
            for co, cat in self.db.execute(
                    "SELECT DISTINCT company, category FROM events WHERE ts >= ? AND party='third'", (cutoff,)):
                cats.setdefault(co, set()).add(cat)
        order = ["fingerprinting", "ads", "analytics", "social", "other", "content", "cdn"]
        def top(s):
            return next((c for c in order if c in s), "other")
        return {"total_sites": total, "sessions": sessions, "days": days,
                "companies": [{"company": r[0], "sites": r[1], "requests": r[2],
                               "category": top(cats.get(r[0], set()))} for r in rows]}

    def rename(self, sid, name):
        with self.lock:
            self.db.execute("UPDATE sessions SET name=? WHERE id=?", (name, sid))
            self.db.commit()

    def clear(self):
        """Delete every session except the one recording, then scrub the file."""
        with self.lock:
            ids = [r[0] for r in self.db.execute("SELECT id FROM sessions")]
            removed = [sid for sid in ids if self.delete_session(sid, commit=False)]
            self.db.commit()
            # Deleted rows linger in free pages and the WAL until rewritten.
            self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            self.db.execute("VACUUM")
            return len(removed)

    def delete_session(self, sid, commit=True):
        if sid == self.active:
            return False
        self.db.execute("DELETE FROM events WHERE session=?", (sid,))
        self.db.execute("DELETE FROM sessions WHERE id=?", (sid,))
        if commit:
            self.db.commit()
        return True


class Hub:
    """Fan-out of live events to Server-Sent-Event subscribers."""
    def __init__(self):
        self.subs = set()
        self.lock = threading.Lock()

    def subscribe(self):
        q = queue.Queue(maxsize=2000)
        with self.lock:
            self.subs.add(q)
        return q

    def unsubscribe(self, q):
        with self.lock:
            self.subs.discard(q)

    def publish(self, kind, payload):
        msg = (kind, payload)
        with self.lock:
            for q in list(self.subs):
                try:
                    q.put_nowait(msg)
                except queue.Full:
                    pass  # slow viewer; it will resync on reconnect


def make_handler(store, hub, enricher, port):
    allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"}
    static = {"/": ("index.html", "text/html; charset=utf-8"),
              "/app.js": ("app.js", "text/javascript; charset=utf-8"),
              "/d3.min.js": ("d3.min.js", "text/javascript; charset=utf-8")}

    def normalize(raw):
        url = raw.get("url")
        redirect = raw.get("redirect")
        page = raw.get("page")
        # A top-level redirect (t.co -> nytimes.com) belongs to the page you land on.
        if redirect and raw.get("type") == "main_frame":
            page = redirect
        info = enricher.classify(url, page)
        if not info["host"]:
            return None
        i_host, i_site, i_co, _ = enricher.describe(raw.get("initiator"))
        i_party = enricher.classify(raw.get("initiator"), page)["party"] if i_host else None
        r_host = r_co = r_cat = r_party = None
        if redirect:
            r = enricher.classify(redirect, page)
            r_host, r_co, r_cat, r_party = r["host"], r["company"], r["category"], r["party"]
        if store.full_urls:
            kept = url
        else:
            kept = None
        def num(v):
            return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None
        return {
            "ts": num(raw.get("ts")) or time.time() * 1000,
            "tab": num(raw.get("tab")),
            "type": str(raw.get("type") or "other")[:32],
            "method": str(raw.get("method") or "")[:10],
            "host": info["host"][:255], "site": (info["site"] or "")[:255],
            "company": (info["company"] or "")[:120], "category": info["category"],
            "party": info["party"], "page_site": info["page_site"][:255],
            "url": kept[:4096] if kept else None,
            "status": num(raw.get("status")),
            "ip": str(raw["ip"])[:64] if raw.get("ip") else None,
            "cached": 1 if raw.get("cached") else 0,
            "size": num(raw.get("size")),
            "error": str(raw["error"])[:120] if raw.get("error") else None,
            "init_host": i_host[:255] if i_host else None,
            "init_site": i_site[:255] if i_site else None,
            "init_company": i_co[:120] if i_co else None, "init_party": i_party,
            "redir_host": r_host[:255] if r_host else None,
            "redir_company": r_co[:120] if r_co else None,
            "redir_category": r_cat, "redir_party": r_party,
        }

    class H(BaseHTTPRequestHandler):
        server_version = "Tattletab/0.4"

        def log_message(self, *a):
            pass

        def _guard(self):
            if self.headers.get("Host", "") not in allowed_hosts:
                self.send_error(403, "Host not allowed")
                return False
            return True

        def _json(self, obj, code=200):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _body(self, limit=8_000_000):
            n = int(self.headers.get("Content-Length") or 0)
            if n > limit:
                raise ValueError("too large")
            return json.loads(self.rfile.read(n) or b"null")

        def _same_origin(self):
            # UI mutations must come from the UI itself (blocks cross-site form posts).
            origin = self.headers.get("Origin")
            return origin is None or urlsplit(origin).netloc in allowed_hosts

        def do_GET(self):
            if not self._guard():
                return
            path = urlsplit(self.path).path
            if path in static:
                fname, ctype = static[path]
                with open(os.path.join(UI_DIR, fname), "rb") as f:
                    data = f.read()
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Content-Security-Policy",
                                 "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'")
                self.end_headers()
                self.wfile.write(data)
            elif path == "/api/status":
                self._json({"recording": store.active, "full_urls": store.full_urls,
                            "tracker_list_entries": enricher.extra_count})
            elif path == "/api/sessions":
                self._json(store.sessions())
            elif path == "/api/reach":
                try:
                    days = max(0, int(parse_qs(urlsplit(self.path).query).get("days", ["0"])[0]))
                except ValueError:
                    days = 0
                self._json(store.reach(days))
            elif path.startswith("/api/sessions/") and path.endswith("/events"):
                try:
                    sid = int(path.split("/")[3])
                except ValueError:
                    return self.send_error(400)
                self._json(store.events(sid))
            elif path == "/api/stream":
                self._stream()
            else:
                self.send_error(404)

        def _stream(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            q = hub.subscribe()
            try:
                self.wfile.write(b": hello\n\n")
                self.wfile.flush()
                while True:
                    try:
                        kind, payload = q.get(timeout=15)
                        self.wfile.write(f"event: {kind}\ndata: {json.dumps(payload)}\n\n".encode())
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                hub.unsubscribe(q)

        def do_OPTIONS(self):
            self.send_error(405)

        def do_POST(self):
            if not self._guard():
                return
            path = urlsplit(self.path).path
            try:
                if path == "/ingest":
                    origin = self.headers.get("Origin", "")
                    # Only the extension (or a local script with no Origin) may ingest.
                    if origin and not origin.startswith(("chrome-extension://", "safari-web-extension://")):
                        return self.send_error(403, "Origin not allowed")
                    batch = self._body()
                    if not isinstance(batch, list):
                        return self.send_error(400)
                    rows = [r for r in (normalize(x) for x in batch if isinstance(x, dict)) if r]
                    n = store.insert(rows)
                    if n:
                        hub.publish("events", rows)
                    self.send_response(204)
                    self.end_headers()
                    return
                if not self._same_origin():
                    return self.send_error(403, "Cross-origin request refused")
                if path == "/api/start":
                    body = self._body() or {}
                    sid = store.start(str(body.get("name") or "")[:120])
                    hub.publish("state", {"recording": sid})
                    self._json({"recording": sid})
                elif path == "/api/stop":
                    sid = store.stop()
                    hub.publish("state", {"recording": None, "stopped": sid})
                    self._json({"recording": None, "stopped": sid})
                elif path == "/api/clear":
                    n = store.clear()
                    hub.publish("state", {"recording": store.active, "cleared": n})
                    self._json({"cleared": n, "kept_active": store.active})
                elif path.startswith("/api/sessions/") and path.endswith("/rename"):
                    store.rename(int(path.split("/")[3]), str((self._body() or {}).get("name", ""))[:120])
                    self._json({"ok": True})
                elif path.startswith("/api/sessions/") and path.endswith("/delete"):
                    with store.lock:
                        ok = store.delete_session(int(path.split("/")[3]))
                    self._json({"ok": ok}, 200 if ok else 409)
                else:
                    self.send_error(404)
            except (ValueError, json.JSONDecodeError):
                self.send_error(400)

    return H


def main():
    ap = argparse.ArgumentParser(description="Tattletab local daemon")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--db", default=os.path.join(DATA_DIR, "tattletab.db"))
    ap.add_argument("--full-urls", action="store_true",
                    help="store full request URLs (default: hostnames only)")
    ap.add_argument("--retain-days", type=int, default=30,
                    help="delete sessions older than this at startup (0 = keep forever)")
    args = ap.parse_args()

    os.makedirs(os.path.dirname(os.path.abspath(args.db)), exist_ok=True)
    legacy = os.path.join(DATA_DIR, "netscope.db")  # name before the project was renamed
    if args.db == os.path.join(DATA_DIR, "tattletab.db") and not os.path.exists(args.db) and os.path.exists(legacy):
        for suffix in ("", "-wal", "-shm"):
            if os.path.exists(legacy + suffix):
                os.replace(legacy + suffix, args.db + suffix)
        print(f"[store] adopted existing database from {legacy}")
    store = Store(args.db, args.full_urls, args.retain_days)
    try:
        os.chmod(args.db, 0o600)
    except OSError:
        pass
    enricher = Enricher(DATA_DIR)
    hub = Hub()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(store, hub, enricher, args.port))
    srv.daemon_threads = True
    print(f"Tattletab listening on http://127.0.0.1:{args.port}/  "
          f"(urls: {'full' if args.full_urls else 'hostnames only'}, "
          f"tracker list: {enricher.extra_count or 'built-in only'})")
    def _term(*_):
        raise KeyboardInterrupt  # treat `kill` like Ctrl-C: stop cleanly
    signal.signal(signal.SIGTERM, _term)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        store.stop()
        # Fold the write-ahead log back into the main file so the .db alone is a
        # complete copy (safe to back up or move without its -wal/-shm files).
        with store.lock:
            store.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            store.db.close()
        print("\nstopped")


if __name__ == "__main__":
    main()
