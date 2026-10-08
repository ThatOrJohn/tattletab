"""Offline enrichment: host -> registrable site -> owning company + category.

Everything here is local. A small built-in table covers the companies that
show up on almost every page. For much broader coverage, download Disconnect's
tracker list once and drop it in data/disconnect.json (see README); it is
loaded at startup and never re-fetched.
"""
import json
import os
from urllib.parse import urlsplit

# Multi-label public suffixes common enough to matter. Not a full PSL, but it
# keeps "bbc.co.uk" from collapsing to "co.uk".
MULTI_SUFFIXES = {
    "co.uk", "org.uk", "ac.uk", "gov.uk", "ltd.uk", "plc.uk", "me.uk",
    "com.au", "net.au", "org.au", "edu.au", "gov.au",
    "co.jp", "ne.jp", "or.jp", "ac.jp", "co.kr", "or.kr",
    "com.br", "com.mx", "com.ar", "com.tr", "com.cn", "com.hk", "com.sg", "com.tw",
    "co.nz", "co.in", "co.za", "co.il", "com.sa",
    "github.io", "herokuapp.com", "vercel.app", "netlify.app", "pages.dev",
    "workers.dev", "web.app", "firebaseapp.com", "blogspot.com",
    "cloudfront.net", "azurewebsites.net", "appspot.com",
    "s3.amazonaws.com", "elb.amazonaws.com",
}

# site -> (company, category). Categories: ads, analytics, social, cdn,
# content, fingerprinting, other.
BUILTIN = {
    # Google
    "google.com": ("Google", "content"), "googleapis.com": ("Google", "cdn"),
    "gstatic.com": ("Google", "cdn"), "googleusercontent.com": ("Google", "cdn"),
    "doubleclick.net": ("Google", "ads"), "googlesyndication.com": ("Google", "ads"),
    "googleadservices.com": ("Google", "ads"), "googletagservices.com": ("Google", "ads"),
    "googletagmanager.com": ("Google", "analytics"), "google-analytics.com": ("Google", "analytics"),
    "youtube.com": ("Google", "content"), "ytimg.com": ("Google", "cdn"),
    "ggpht.com": ("Google", "cdn"), "googlevideo.com": ("Google", "cdn"),
    "youtube-nocookie.com": ("Google", "content"), "recaptcha.net": ("Google", "content"),
    "gvt1.com": ("Google", "cdn"), "gvt2.com": ("Google", "cdn"), "2mdn.net": ("Google", "ads"),
    # Meta
    "facebook.com": ("Meta", "social"), "facebook.net": ("Meta", "social"),
    "fbcdn.net": ("Meta", "cdn"), "instagram.com": ("Meta", "social"),
    "cdninstagram.com": ("Meta", "cdn"), "whatsapp.net": ("Meta", "social"),
    # Amazon
    "amazon.com": ("Amazon", "content"), "amazon-adsystem.com": ("Amazon", "ads"),
    "amazonaws.com": ("Amazon", "cdn"), "cloudfront.net": ("Amazon", "cdn"),
    "media-amazon.com": ("Amazon", "cdn"), "ssl-images-amazon.com": ("Amazon", "cdn"),
    # Microsoft
    "microsoft.com": ("Microsoft", "content"), "bing.com": ("Microsoft", "ads"),
    "clarity.ms": ("Microsoft", "analytics"), "msn.com": ("Microsoft", "content"),
    "azureedge.net": ("Microsoft", "cdn"), "live.com": ("Microsoft", "content"),
    "linkedin.com": ("Microsoft", "social"), "licdn.com": ("Microsoft", "cdn"),
    "office.com": ("Microsoft", "content"), "msecnd.net": ("Microsoft", "cdn"),
    # Apple
    "apple.com": ("Apple", "content"), "icloud.com": ("Apple", "content"),
    "mzstatic.com": ("Apple", "cdn"), "cdn-apple.com": ("Apple", "cdn"),
    # CDNs / infra
    "cloudflare.com": ("Cloudflare", "cdn"), "cloudflareinsights.com": ("Cloudflare", "analytics"),
    "cdnjs.cloudflare.com": ("Cloudflare", "cdn"), "cloudflare-dns.com": ("Cloudflare", "cdn"),
    "akamaihd.net": ("Akamai", "cdn"), "akamaized.net": ("Akamai", "cdn"),
    "akamai.net": ("Akamai", "cdn"), "akamaiedge.net": ("Akamai", "cdn"),
    "fastly.net": ("Fastly", "cdn"), "fastly-insights.com": ("Fastly", "analytics"),
    "jsdelivr.net": ("jsDelivr", "cdn"), "unpkg.com": ("unpkg", "cdn"),
    "jquery.com": ("jQuery", "cdn"), "fonts.net": ("Monotype", "cdn"),
    "typekit.net": ("Adobe", "cdn"),
    # Analytics / tag / session replay
    "adobedtm.com": ("Adobe", "analytics"), "omtrdc.net": ("Adobe", "analytics"),
    "demdex.net": ("Adobe", "ads"), "everesttech.net": ("Adobe", "ads"),
    "hotjar.com": ("Hotjar", "analytics"), "hotjar.io": ("Hotjar", "analytics"),
    "segment.com": ("Twilio Segment", "analytics"), "segment.io": ("Twilio Segment", "analytics"),
    "mixpanel.com": ("Mixpanel", "analytics"), "amplitude.com": ("Amplitude", "analytics"),
    "fullstory.com": ("FullStory", "analytics"), "newrelic.com": ("New Relic", "analytics"),
    "nr-data.net": ("New Relic", "analytics"), "sentry.io": ("Sentry", "analytics"),
    "datadoghq.com": ("Datadog", "analytics"), "browser-intake-datadoghq.com": ("Datadog", "analytics"),
    "quantserve.com": ("Quantcast", "ads"), "scorecardresearch.com": ("Comscore", "analytics"),
    "chartbeat.com": ("Chartbeat", "analytics"), "chartbeat.net": ("Chartbeat", "analytics"),
    "optimizely.com": ("Optimizely", "analytics"), "heap.io": ("Heap", "analytics"),
    "heapanalytics.com": ("Heap", "analytics"), "posthog.com": ("PostHog", "analytics"),
    "onetrust.com": ("OneTrust", "other"), "cookielaw.org": ("OneTrust", "other"),
    "intercom.io": ("Intercom", "other"), "intercomcdn.com": ("Intercom", "cdn"),
    "hubspot.com": ("HubSpot", "analytics"), "hs-scripts.com": ("HubSpot", "analytics"),
    "hs-analytics.net": ("HubSpot", "analytics"), "hsforms.com": ("HubSpot", "other"),
    # Ad tech
    "criteo.com": ("Criteo", "ads"), "criteo.net": ("Criteo", "ads"),
    "taboola.com": ("Taboola", "ads"), "outbrain.com": ("Outbrain", "ads"),
    "adnxs.com": ("Xandr", "ads"), "rubiconproject.com": ("Magnite", "ads"),
    "pubmatic.com": ("PubMatic", "ads"), "openx.net": ("OpenX", "ads"),
    "casalemedia.com": ("Index Exchange", "ads"), "adsrvr.org": ("The Trade Desk", "ads"),
    "rlcdn.com": ("LiveRamp", "ads"), "bluekai.com": ("Oracle", "ads"),
    "moatads.com": ("Oracle", "ads"), "krxd.net": ("Salesforce", "ads"),
    "3lift.com": ("TripleLift", "ads"), "sharethrough.com": ("Sharethrough", "ads"),
    "media.net": ("Media.net", "ads"), "yieldmo.com": ("Yieldmo", "ads"),
    "lijit.com": ("Sovrn", "ads"), "smartadserver.com": ("Equativ", "ads"),
    "teads.tv": ("Teads", "ads"), "doubleverify.com": ("DoubleVerify", "ads"),
    "adsafeprotected.com": ("IAS", "ads"), "bidswitch.net": ("IPONWEB", "ads"),
    "33across.com": ("33Across", "ads"), "id5-sync.com": ("ID5", "ads"),
    "tapad.com": ("Tapad", "ads"), "agkn.com": ("Neustar", "ads"),
    # Social
    "twitter.com": ("X", "social"), "x.com": ("X", "social"), "twimg.com": ("X", "cdn"),
    "ads-twitter.com": ("X", "ads"), "t.co": ("X", "social"),
    "tiktok.com": ("ByteDance", "social"), "tiktokcdn.com": ("ByteDance", "cdn"),
    "pinterest.com": ("Pinterest", "social"), "pinimg.com": ("Pinterest", "cdn"),
    "reddit.com": ("Reddit", "social"), "redditstatic.com": ("Reddit", "cdn"),
    "redditmedia.com": ("Reddit", "cdn"), "snapchat.com": ("Snap", "social"),
    "sc-static.net": ("Snap", "ads"),
    # Common first-party asset domains (keeps them from showing as "third party")
    "github.com": ("GitHub", "content"), "githubassets.com": ("GitHub", "cdn"),
    "githubusercontent.com": ("GitHub", "cdn"), "github.io": ("GitHub", "content"),
    "wikipedia.org": ("Wikimedia", "content"), "wikimedia.org": ("Wikimedia", "cdn"),
    "wikidata.org": ("Wikimedia", "content"),
    "nytimes.com": ("New York Times", "content"), "nyt.com": ("New York Times", "cdn"),
    "espn.com": ("Disney", "content"), "espncdn.com": ("Disney", "cdn"),
    "disney.com": ("Disney", "content"), "disneyplus.com": ("Disney", "content"),
    "netflix.com": ("Netflix", "content"), "nflxext.com": ("Netflix", "cdn"),
    "nflxso.net": ("Netflix", "cdn"), "nflxvideo.net": ("Netflix", "cdn"),
    "spotify.com": ("Spotify", "content"), "scdn.co": ("Spotify", "cdn"),
    "anthropic.com": ("Anthropic", "content"), "claude.ai": ("Anthropic", "content"),
    "openai.com": ("OpenAI", "content"), "oaistatic.com": ("OpenAI", "cdn"),
    "slack.com": ("Salesforce", "content"), "slack-edge.com": ("Salesforce", "cdn"),
    "zoom.us": ("Zoom", "content"), "dropbox.com": ("Dropbox", "content"),
    # Fingerprinting / bot detection
    "fingerprint.com": ("Fingerprint", "fingerprinting"), "fpjs.io": ("Fingerprint", "fingerprinting"),
    "perimeterx.net": ("HUMAN", "fingerprinting"), "px-cdn.net": ("HUMAN", "fingerprinting"),
    "hcaptcha.com": ("hCaptcha", "other"),
}

DISCONNECT_CATEGORY = {
    "Advertising": "ads", "Analytics": "analytics", "Social": "social",
    "Fingerprinting": "fingerprinting", "Cryptomining": "fingerprinting",
    "FingerprintingInvasive": "fingerprinting", "FingerprintingGeneral": "fingerprinting",
    "Content": "content", "Disconnect": "social", "Email": "other",
    "EmailAggressive": "other", "ConsentManagers": "other", "Anti-fraud": "other",
}


def load_disconnect(path):
    """Merge Disconnect's services.json into a site->(company, category) map."""
    out = {}
    if not os.path.exists(path):
        return out
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        for cat, entries in data.get("categories", {}).items():
            mapped = DISCONNECT_CATEGORY.get(cat, "other")
            for entry in entries:
                for company, sites in entry.items():
                    if not isinstance(sites, dict):
                        continue
                    for _homepage, domains in sites.items():
                        if not isinstance(domains, list):
                            continue
                        for d in domains:
                            if isinstance(d, str):
                                # Advertising/analytics outrank "content" if listed twice.
                                prev = out.get(d.lower())
                                if prev and prev[1] in ("ads", "analytics", "fingerprinting") and mapped == "content":
                                    continue
                                out[d.lower()] = (company, mapped)
    except Exception as e:  # malformed file shouldn't stop the daemon
        print(f"[enrich] could not load {path}: {e}")
    return out


class Enricher:
    def __init__(self, data_dir):
        self.table = dict(BUILTIN)
        extra = load_disconnect(os.path.join(data_dir, "disconnect.json"))
        # Built-in entries keep their finer category split (e.g. Google cdn vs ads).
        for k, v in extra.items():
            self.table.setdefault(k, v)
        self.extra_count = len(extra)

    @staticmethod
    def host_of(url):
        if not url:
            return None
        try:
            h = urlsplit(url).hostname
            return h.lower() if h else None
        except ValueError:
            return None

    @staticmethod
    def site_of(host):
        if not host:
            return None
        if host.replace(".", "").isdigit() or ":" in host:  # IPv4 / IPv6 literal
            return host
        parts = host.split(".")
        if len(parts) <= 2:
            return host
        last2 = ".".join(parts[-2:])
        if last2 in MULTI_SUFFIXES or ".".join(parts[-3:]) in MULTI_SUFFIXES:
            if ".".join(parts[-3:]) in MULTI_SUFFIXES and len(parts) >= 4:
                return ".".join(parts[-4:])
            return ".".join(parts[-3:])
        return last2

    def lookup(self, host):
        """Walk from the full host up to the site looking for a table entry."""
        if not host:
            return None
        parts = host.split(".")
        for i in range(len(parts) - 1):
            hit = self.table.get(".".join(parts[i:]))
            if hit:
                return hit
        return None

    def describe(self, url):
        """(host, site, company, category) for any URL or origin; Nones if unparseable."""
        host = self.host_of(url)
        if not host:
            return None, None, None, None
        site = self.site_of(host)
        hit = self.lookup(host)
        return (host, site) + (hit if hit else (site, "other"))

    def classify(self, url, page_url):
        host = self.host_of(url)
        site = self.site_of(host)
        hit = self.lookup(host)
        company, category = hit if hit else (site, "other")

        page_host = self.host_of(page_url)
        page_site = self.site_of(page_host)
        page_hit = self.lookup(page_host)
        page_company = page_hit[0] if page_hit else page_site

        if page_site is None:
            party = "background"
        elif site == page_site:
            party = "first"
        elif company == page_company:
            party = "same-owner"  # e.g. ytimg.com on youtube.com
        else:
            party = "third"
        if party in ("first", "same-owner") and category == "other":
            category = "content"
        return {
            "host": host, "site": site, "company": company, "category": category,
            "page_site": page_site or "(background)", "party": party,
        }
