"""Font service (#58-#69, T11-T16 + T21): the server is the canonical, MULTI-SOURCE font store.

It searches several free, key-less, programmatically-resolvable font catalogues — Fontsource
(~2000 open-source families), Fontshare (quality display faces), Google Fonts, and Bunny Fonts
(a privacy mirror) — caches the chosen .woff2 under outputs/.fonts/ (served to the client's
@font-face via /outputs/), and — because it HAS the real file — converts <text> to exact glyph
outlines with fontTools. Search → download → install → use, all without leaving the app, from a
ton of sources rather than one walled garden.

No third-party HTTP client (urllib only); no freetype (fontTools + brotli read woff2 + emit
positioned path data via SVGPathPen/TransformPen).
"""
from __future__ import annotations

import json
import re
import threading
import urllib.parse
import urllib.request
from pathlib import Path

from hvserver.paths import FONTS_DIR

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

# Display order = resolve priority. A family present in several catalogues is listed once under
# the first source here (Fontsource first: biggest, license-tagged, direct-CDN); the others are
# recorded as alternates. Bunny is a resolver fallback, not a catalogue (it mirrors Google).
SOURCE_ORDER = ["fontsource", "fontshare", "google"]
SOURCE_LABELS = {"fontsource": "Fontsource", "fontshare": "Fontshare",
                 "google": "Google Fonts", "bunny": "Bunny Fonts"}

# Google curated fallback list — guarantees the popular families are searchable even if a
# remote catalogue fetch fails (offline / rate-limited). Family names match Google exactly.
CATALOG = [
    ("Inter", "sans-serif"), ("Roboto", "sans-serif"), ("Open Sans", "sans-serif"),
    ("Lato", "sans-serif"), ("Montserrat", "sans-serif"), ("Poppins", "sans-serif"),
    ("Raleway", "sans-serif"), ("Nunito", "sans-serif"), ("Work Sans", "sans-serif"),
    ("Rubik", "sans-serif"), ("DM Sans", "sans-serif"), ("Manrope", "sans-serif"),
    ("Source Sans 3", "sans-serif"), ("Noto Sans", "sans-serif"), ("Oswald", "sans-serif"),
    ("Merriweather", "serif"), ("Playfair Display", "serif"), ("Lora", "serif"),
    ("PT Serif", "serif"), ("Roboto Slab", "serif"), ("EB Garamond", "serif"),
    ("Roboto Mono", "monospace"), ("JetBrains Mono", "monospace"), ("Fira Code", "monospace"),
    ("Source Code Pro", "monospace"), ("IBM Plex Mono", "monospace"), ("Space Mono", "monospace"),
    ("Pacifico", "cursive"), ("Dancing Script", "cursive"), ("Caveat", "cursive"),
    ("Lobster", "cursive"), ("Bebas Neue", "display"), ("Anton", "display"),
    ("Righteous", "display"), ("Abril Fatface", "display"), ("Comfortaa", "display"),
]


# ---- HTTP + disk cache helpers --------------------------------------------
def _http_bytes(url: str, timeout: int = 20) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 (fixed hosts)
        return resp.read()


def _http_json(url: str, timeout: int = 20):
    return json.loads(_http_bytes(url, timeout).decode("utf-8", "replace"))


def _http_text(url: str, timeout: int = 20) -> str:
    return _http_bytes(url, timeout).decode("utf-8", "replace")


def _cache_json(name: str, fetch):
    """Disk-cache a fetched catalogue (catalog-<name>.json) so search is fast after the first
    hit and survives a brief network outage."""
    FONTS_DIR.mkdir(parents=True, exist_ok=True)
    path = FONTS_DIR / f"catalog-{name}.json"
    if path.is_file():
        try:
            return json.loads(path.read_text("utf-8"))
        except Exception:  # noqa: BLE001 — a corrupt cache just refetches
            pass
    data = fetch()
    try:
        path.write_text(json.dumps(data), "utf-8")
    except Exception:  # noqa: BLE001
        pass
    return data


# ---- per-source catalogues -------------------------------------------------
def _cat_fontsource() -> list[dict]:
    raw = _cache_json("fontsource", lambda: _http_json("https://api.fontsource.org/v1/fonts"))
    out = []
    for f in raw:
        out.append({
            "family": f["family"], "category": f.get("category", "sans-serif"),
            "source": "fontsource", "key": f["id"], "weights": f.get("weights") or [400],
            "styles": f.get("styles") or ["normal"], "subset": f.get("defSubset", "latin"),
            "license": f.get("license", ""),
        })
    return out


def _cat_fontshare() -> list[dict]:
    def fetch():
        out, page = [], 1
        while page <= 5:
            d = _http_json(f"https://api.fontshare.com/v2/fonts?limit=100&page={page}")
            fonts = d.get("fonts") or []
            for f in fonts:
                weights = sorted({int((s.get("weight") or {}).get("weight", 400)) if isinstance(s.get("weight"), dict)
                                  else int(s.get("weight", 400)) for s in (f.get("styles") or [])}) or [400]
                out.append({"family": f.get("name"), "slug": f.get("slug"),
                            "category": (f.get("category") or "sans-serif").lower(), "weights": weights})
            if len(fonts) < 100:
                break
            page += 1
        return out
    raw = _cache_json("fontshare", fetch)
    return [{"family": e["family"], "category": e.get("category", "display"), "source": "fontshare",
             "key": e["slug"], "weights": e.get("weights") or [400], "styles": ["normal"],
             "subset": "latin", "license": "Fontshare (free)"} for e in raw if e.get("family") and e.get("slug")]


def _cat_google() -> list[dict]:
    return [{"family": n, "category": c, "source": "google", "key": n,
             "weights": [100, 300, 400, 500, 700, 900], "styles": ["normal", "italic"],
             "subset": "latin", "license": "OFL"} for (n, c) in CATALOG]


_SOURCE_FETCH = {"fontsource": _cat_fontsource, "fontshare": _cat_fontshare, "google": _cat_google}

_CATALOG = None              # merged, deduped, sorted — for search/browse
_SOURCE_INDEX: dict = {}     # source -> {family_lower: entry} — for resolution
_CATALOG_LOCK = threading.Lock()


def _build_catalog():
    global _CATALOG, _SOURCE_INDEX
    with _CATALOG_LOCK:
        if _CATALOG is not None:
            return
        by_family: dict[str, dict] = {}
        index: dict[str, dict] = {}
        for src in SOURCE_ORDER:
            try:
                entries = _SOURCE_FETCH[src]()
            except Exception:  # noqa: BLE001 — one source down must not sink the rest
                entries = []
            index[src] = {}
            for e in entries:
                fl = (e.get("family") or "").lower()
                if not fl:
                    continue
                index[src][fl] = e
                if fl not in by_family:
                    by_family[fl] = dict(e)
                else:
                    by_family[fl].setdefault("also", []).append(src)
        # Guarantee the curated Google families are always present (even if every fetch failed).
        for (n, c) in CATALOG:
            by_family.setdefault(n.lower(), {"family": n, "category": c, "source": "google",
                                             "key": n, "weights": [400], "styles": ["normal"], "subset": "latin"})
            index.setdefault("google", {}).setdefault(n.lower(), {"family": n, "category": c, "source": "google",
                                             "key": n, "weights": [400], "styles": ["normal", "italic"], "subset": "latin"})
        _CATALOG = sorted(by_family.values(), key=lambda e: e["family"].lower())
        _SOURCE_INDEX = index


def font_catalog(query: str = "", limit: int = 60, source: str = "") -> dict:
    """Search the merged catalogue. Ranks exact/prefix matches first so 'roboto' surfaces
    'Roboto' before 'Roboto Slab'. `source` (optional) filters to one provider."""
    _build_catalog()
    q = (query or "").strip().lower()
    items = _CATALOG or []
    if source:
        items = [e for e in items if e.get("source") == source or source in (e.get("also") or [])]
    if q:
        items = [e for e in items if q in e["family"].lower()]
        items.sort(key=lambda e: (e["family"].lower() != q, not e["family"].lower().startswith(q), len(e["family"])))
    out = [{"family": e["family"], "category": e.get("category", "sans-serif"),
            "source": e.get("source", "google"), "sourceLabel": SOURCE_LABELS.get(e.get("source", "google"), "Web"),
            "license": e.get("license", ""), "also": e.get("also", [])} for e in items[:limit]]
    return {"fonts": out, "total": len(items), "sources": [SOURCE_LABELS[s] for s in SOURCE_ORDER]}


# ---- resolution (family -> a downloadable .woff2 URL) ----------------------
def _nearest_weight(weights: list[int], target: int) -> int:
    return min(weights, key=lambda w: abs(int(w) - int(target))) if weights else int(target)


def _gf_woff2_url(family: str, weight: int, italic: bool) -> str | None:
    axis = (f"ital,wght@1,{weight}" if italic else f"wght@{weight}")
    url = (f"https://fonts.googleapis.com/css2?family={urllib.parse.quote(family)}:{axis}&display=swap")
    css = _http_text(url, 15)
    found = re.findall(r"/\*\s*([\w-]+)\s*\*/\s*@font-face\s*\{[^}]*?url\((https://[^)]+\.woff2)\)", css)
    if not found:
        m = re.search(r"url\((https://[^)]+\.woff2)\)", css)
        return m.group(1) if m else None
    for subset, u in found:
        if subset == "latin":
            return u
    return found[0][1]


def _fontshare_woff2(slug: str, weight: int) -> str | None:
    css = _http_text(f"https://api.fontshare.com/v2/css?f[]={urllib.parse.quote(slug)}@{weight}", 15)
    # Fontshare wraps the URL in single quotes: url('//cdn.fontshare.com/...woff2')
    m = re.search(r"url\(['\"]?((?://|https://)[^)'\"]+\.woff2)['\"]?\)", css)
    if not m:
        return None
    u = m.group(1)
    return ("https:" + u) if u.startswith("//") else u


def _entry_for(family: str, source: str = "") -> dict | None:
    _build_catalog()
    fl = (family or "").lower()
    if source and source in _SOURCE_INDEX and fl in _SOURCE_INDEX[source]:
        return _SOURCE_INDEX[source][fl]
    for src in SOURCE_ORDER:                       # any source that has it
        if fl in _SOURCE_INDEX.get(src, {}):
            return _SOURCE_INDEX[src][fl]
    return {"family": family, "source": "google", "key": family, "weights": [400], "subset": "latin"}


def _resolve_url(entry: dict, weight: int, italic: bool) -> str | None:
    src = entry.get("source", "google")
    style = "italic" if italic else "normal"
    w = _nearest_weight(entry.get("weights") or [400], weight)
    sub = entry.get("subset", "latin")
    if src == "fontsource":
        return f"https://cdn.jsdelivr.net/fontsource/fonts/{entry['key']}@latest/{sub}-{w}-{style}.woff2"
    if src == "bunny":
        return f"https://fonts.bunny.net/{entry['key']}/files/{entry['key']}-{sub}-{w}-{style}.woff2"
    if src == "fontshare":
        return _fontshare_woff2(entry["key"], w)
    return _gf_woff2_url(entry.get("family", entry.get("key", "")), w, italic)


def _slug(family: str, weight: int, italic: bool, source: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", f"{source}-{family}".lower()).strip("-")
    return f"{base}-{weight}{'i' if italic else ''}"


def ensure_font(family: str, weight: int = 400, italic: bool = False, source: str = "") -> Path:
    """Return the cached .woff2 for this family/weight, downloading once from its source if
    needed. Falls back across sources (e.g. Fontsource CDN miss → Google CSS) before giving up."""
    FONTS_DIR.mkdir(parents=True, exist_ok=True)
    entry = _entry_for(family, source) or {"family": family, "source": "google", "key": family}
    path = FONTS_DIR / f"{_slug(family, weight, italic, entry.get('source', 'google'))}.woff2"
    if path.is_file() and path.stat().st_size > 0:
        return path
    tried = []
    candidates = [entry]
    # cross-source fallback: try Google last for any Google-mirrored family
    if entry.get("source") != "google":
        candidates.append({"family": family, "source": "google", "key": family, "weights": [400], "subset": "latin"})
    for cand in candidates:
        try:
            url = _resolve_url(cand, weight, italic)
            if not url:
                continue
            data = _http_bytes(url, 20)
            if data and len(data) > 64:
                path.write_bytes(data)
                return path
        except Exception as exc:  # noqa: BLE001
            tried.append(f"{cand.get('source')}: {exc}")
    raise ValueError(f"Could not fetch '{family}' {weight}{'i' if italic else ''} ({'; '.join(tried) or 'no source'})")


# System / non-downloadable faces → a free OFL stand-in for OUTLINING only (the browser still
# renders the real system font on screen). The Liberation/Croscore families are metric-compatible
# (same advances) with the classic system fonts, so the outline lines up; the generic-stack and
# rough rows are close-in-spirit fallbacks. Reported to the client so the substitution is explicit.
_FONT_SUBSTITUTES = {
    "arial": "Arimo", "helvetica": "Arimo", "helvetica neue": "Arimo", "liberation sans": "Arimo",
    "times": "Tinos", "times new roman": "Tinos", "liberation serif": "Tinos",
    "courier": "Cousine", "courier new": "Cousine", "liberation mono": "Cousine",
    "georgia": "Gelasio",                       # Gelasio is metric-compatible with Georgia
    "sans-serif": "Arimo", "serif": "Tinos", "monospace": "Cousine", "ui-sans-serif": "Arimo",
    # rough (not metric-identical, but free + visually close)
    "verdana": "Arimo", "tahoma": "Arimo", "trebuchet ms": "Arimo", "segoe ui": "Arimo",
    "calibri": "Arimo", "system-ui": "Arimo", "ui-serif": "Tinos", "ui-monospace": "Cousine",
}


def _font_substitute(family: str):
    """An OFL stand-in family for a system/undownloadable face, or None if we don't know one."""
    return _FONT_SUBSTITUTES.get((family or "").strip().strip("'\"").lower())


# Slug→family manifest: the cached files are named by slug (dm-sans-400.woff2), which loses the
# real family ("DM Sans"). We record it at download time so the installed library + the in-app
# registry can be re-hydrated by family after a page reload (else saved docs can't re-embed their
# fonts and the Installed tab is empty until you search again).
_MANIFEST_LOCK = threading.Lock()


def _read_manifest() -> dict:
    p = FONTS_DIR / "manifest.json"
    if p.is_file():
        try:
            return json.loads(p.read_text("utf-8"))
        except Exception:  # noqa: BLE001 — corrupt manifest just resets
            return {}
    return {}


def _record_manifest(file_name: str, family: str, source: str, weight: int, italic: bool) -> None:
    with _MANIFEST_LOCK:
        m = _read_manifest()
        m[file_name] = {"family": family, "source": source, "weight": int(weight), "italic": bool(italic)}
        try:
            (FONTS_DIR / "manifest.json").write_text(json.dumps(m), "utf-8")
        except Exception:  # noqa: BLE001 — best effort; the cache still works without it
            pass


def load_font(payload: dict) -> dict:
    family = (payload.get("family") or "").strip()
    if not family:
        raise ValueError("family required")
    weight = int(payload.get("weight", 400))
    italic = bool(payload.get("italic", False))
    source = payload.get("source", "")
    path = ensure_font(family, weight, italic, source)
    entry = _entry_for(family, source) or {}
    src = entry.get("source", source or "google")
    _record_manifest(path.name, family, src, weight, italic)
    return {"family": family, "weight": weight, "italic": italic,
            "source": src, "url": f"/outputs/.fonts/{path.name}",
            "bytes": path.stat().st_size}


def installed_fonts(payload: dict | None = None) -> dict:
    """List the fonts already downloaded into the local cache — the 'installed library'. Files are
    enriched with their real family (via the manifest) and grouped into `families` so the client
    can re-hydrate its registry by family name after a reload."""
    out, fams = [], {}
    if FONTS_DIR.is_dir():
        manifest = _read_manifest()
        for p in sorted(FONTS_DIR.glob("*.woff2")):
            meta = manifest.get(p.name, {})
            fam = meta.get("family")
            url = f"/outputs/.fonts/{p.name}"
            out.append({"file": p.name, "url": url, "bytes": p.stat().st_size,
                        "family": fam, "source": meta.get("source"),
                        "weight": meta.get("weight"), "italic": meta.get("italic")})
            if fam:
                g = fams.setdefault(fam, {"family": fam, "source": meta.get("source"), "variants": []})
                g["variants"].append({"weight": meta.get("weight", 400),
                                      "italic": bool(meta.get("italic", False)), "url": url})
    return {"installed": out, "families": sorted(fams.values(), key=lambda f: f["family"].lower()),
            "count": len(out)}


# ---- text shaping (kerning + ligatures) -----------------------------------
# Browsers SHAPE text with HarfBuzz before rendering: kerning tightens pairs (AV, To, Wa),
# standard ligatures fuse runs (fi, ffi, fl). A naive cmap+advance walk drifts from what's on
# screen, so a converted outline would "jump". We reproduce shaping so text→vector is exact.
# Preferred: uharfbuzz (browser-identical, every script). Fallback: fontTools-only GPOS/kern
# pair kerning + GSUB liga/clig ligatures (covers Latin — the common case — faithfully).
try:
    import uharfbuzz as _hb   # optional; pip install uharfbuzz for browser-exact shaping
except Exception:  # noqa: BLE001
    _hb = None

_SHAPE_CACHE: dict = {}   # path -> {"kern": fn, "liga": dict}
_SHAPE_LOCK = threading.Lock()


def _kern_func(font):
    """Build (g1,g2)->x-advance-adjustment (font units) from legacy `kern` + GPOS PairPos."""
    pairs: dict = {}
    classfns = []
    try:
        if "kern" in font:
            for st in font["kern"].kernTables:
                for (l, r), v in getattr(st, "kernTable", {}).items():
                    pairs[(l, r)] = pairs.get((l, r), 0) + v
    except Exception:  # noqa: BLE001
        pass
    try:
        gpos = font["GPOS"].table if "GPOS" in font else None
        if gpos and gpos.LookupList:
            for lookup in gpos.LookupList.Lookup:
                if _eff_type(lookup) != 2:                 # 2 = PairPos (kerning); unwraps type-9 Extension
                    continue
                for sub in _real_subtables(lookup):        # unwrap Extension wrappers
                    if getattr(sub, "Format", None) == 1:
                        for i, pset in enumerate(sub.PairSet):
                            g1 = sub.Coverage.glyphs[i]
                            for pvr in pset.PairValueRecord:
                                adj = getattr(pvr.Value1, "XAdvance", 0) if pvr.Value1 else 0
                                if adj:
                                    pairs[(g1, pvr.SecondGlyph)] = pairs.get((g1, pvr.SecondGlyph), 0) + adj
                    elif getattr(sub, "Format", None) == 2:
                        cov = set(sub.Coverage.glyphs)
                        c1 = dict(sub.ClassDef1.classDefs) if sub.ClassDef1 else {}
                        c2 = dict(sub.ClassDef2.classDefs) if sub.ClassDef2 else {}
                        recs = sub.Class1Record

                        def make(cov, c1, c2, recs):
                            def fn(g1, g2):
                                if g1 not in cov:
                                    return 0
                                try:
                                    v = recs[c1.get(g1, 0)].Class2Record[c2.get(g2, 0)].Value1
                                    return getattr(v, "XAdvance", 0) if v else 0
                                except Exception:  # noqa: BLE001
                                    return 0
                            return fn
                        classfns.append(make(cov, c1, c2, recs))
    except Exception:  # noqa: BLE001
        pass

    def kern(g1, g2):
        v = pairs.get((g1, g2), 0)
        for fn in classfns:
            v += fn(g1, g2)
        return v
    return kern


def _real_subtables(lookup):
    """Yield a lookup's subtables, unwrapping Extension wrappers (GSUB type-7 / GPOS type-9) so
    the real Ligature/PairPos/contextual structure is reachable (fonts use these for large offsets)."""
    for sub in lookup.SubTable:
        yield getattr(sub, "ExtSubTable", sub)


def _eff_type(lookup) -> int:
    """A lookup's effective type, seeing THROUGH an Extension wrapper (GSUB 7 / GPOS 9)."""
    if lookup.LookupType in (7, 9) and lookup.SubTable:
        return getattr(lookup.SubTable[0], "ExtensionLookupType", lookup.LookupType)
    return lookup.LookupType


def _referenced_lookups(lookup) -> set:
    """Lookup indices a contextual/chaining lookup (type 5/6) invokes — found by scanning its
    subtables for SubstLookupRecord.LookupListIndex (works across formats 1/2/3)."""
    refs, seen = set(), set()

    def walk(o, depth=0):
        if o is None or depth > 6 or id(o) in seen:
            return
        seen.add(id(o))
        slr = getattr(o, "SubstLookupRecord", None)
        if slr:
            for r in slr:
                li = getattr(r, "LookupListIndex", None)
                if li is not None:
                    refs.add(li)
        for v in getattr(o, "__dict__", {}).values():
            if isinstance(v, list):
                for it in v:
                    if hasattr(it, "__dict__"):
                        walk(it, depth + 1)
            elif hasattr(v, "__dict__"):
                walk(v, depth + 1)
    for sub in _real_subtables(lookup):
        walk(sub)
    return refs


def _ligatures(font) -> dict:
    """first-glyph -> [(component-tail tuple, ligature glyph), …] from GSUB liga/clig. Follows
    the type-6 chaining indirection many fonts use (liga → chain lookup → the type-4 ligature)."""
    ligs: dict = {}
    if "GSUB" not in font:
        return ligs
    try:
        gsub = font["GSUB"].table
        if not gsub.LookupList:
            return ligs
        lookups = gsub.LookupList.Lookup
        seed = set()
        if gsub.FeatureList:
            for frec in gsub.FeatureList.FeatureRecord:
                if frec.FeatureTag in ("liga", "clig"):
                    seed.update(frec.Feature.LookupListIndex)
        if not seed:
            seed = set(range(len(lookups)))
        # resolve seed lookups down to the type-4 ligature lookups they ultimately invoke
        want, frontier, seen = set(), list(seed), set()
        while frontier:
            li = frontier.pop()
            if li in seen or li < 0 or li >= len(lookups):
                continue
            seen.add(li)
            lk = lookups[li]
            # fontTools' high-level LigatureSubst exposes a `.ligatures` dict {firstGlyph:[Ligature]}
            has_lig = any(getattr(s, "ligatures", None) for s in _real_subtables(lk))
            if has_lig:
                want.add(li)
            elif _eff_type(lk) in (5, 6):                  # contextual/chaining (seen through Extension) → follow
                frontier.extend(r for r in _referenced_lookups(lk) if r not in seen)
        for li in want:
            for sub in _real_subtables(lookups[li]):
                table = getattr(sub, "ligatures", None)
                if not table:
                    continue
                for first, ligature_list in table.items():
                    for lig in ligature_list:
                        ligs.setdefault(first, []).append((tuple(lig.Component), lig.LigGlyph))
        for first in ligs:                                 # longest match first
            ligs[first].sort(key=lambda t: -len(t[0]))
    except Exception:  # noqa: BLE001
        ligs = {}
    return ligs


def _shape_tables(path, font):
    key = str(path)
    with _SHAPE_LOCK:
        ent = _SHAPE_CACHE.get(key)
        if ent is None:
            ent = {"kern": _kern_func(font), "liga": _ligatures(font)}
            _SHAPE_CACHE[key] = ent
        return ent


def _hb_font(font):
    """A HarfBuzz font from the raw SFNT (HarfBuzz may not read woff2, so re-emit TTF/OTF)."""
    import io
    font.flavor = None
    bio = io.BytesIO()
    font.save(bio)
    blob = _hb.Blob(bio.getvalue())
    return _hb.Font(_hb.Face(blob))


def _shape_line(font, hbfont, line: str, tables):
    """Return positioned glyphs [(glyphname, x_advance, x_offset, y_offset)] in FONT UNITS,
    with kerning + ligatures applied (HarfBuzz if available, else the fontTools fallback)."""
    if hbfont is not None:
        buf = _hb.Buffer()
        buf.add_str(line)
        buf.guess_segment_properties()
        _hb.shape(hbfont, buf, {"kern": True, "liga": True})
        out = []
        for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
            out.append((font.getGlyphName(info.codepoint), pos.x_advance, pos.x_offset, pos.y_offset))
        return out
    cmap = font.getBestCmap()
    hmtx = font["hmtx"]
    glyphs = [cmap.get(ord(ch)) for ch in line]
    # GSUB liga substitution over the glyph-name run
    ligs = tables["liga"]
    if ligs:
        sub, i, n = [], 0, len(glyphs)
        while i < n:
            g = glyphs[i]
            hit = None
            if g is not None:
                for comps, lig in ligs.get(g, ()):
                    L = len(comps)
                    if list(glyphs[i + 1:i + 1 + L]) == list(comps):
                        hit = (lig, 1 + L)
                        break
            if hit:
                sub.append(hit[0])
                i += hit[1]
            else:
                sub.append(g)
                i += 1
        glyphs = sub
    kern = tables["kern"]
    out = []
    for j, g in enumerate(glyphs):
        if g is None:                                      # missing glyph → keep a space gap
            out.append((None, hmtx["space"][0] if "space" in hmtx.metrics else int(font["head"].unitsPerEm * 0.3), 0, 0))
            continue
        adv = hmtx[g][0] if g in hmtx.metrics else 0
        if out and out[-1][0] is not None:                 # fold kern into the PREVIOUS advance
            k = kern(out[-1][0], g)
            if k:
                p = out[-1]
                out[-1] = (p[0], p[1] + k, p[2], p[3])
        out.append((g, adv, 0, 0))
    return out


# Scripts that need a real shaping engine (reordering, joining, mark positioning) — the
# fontTools fallback only does GPOS pair-kern + GSUB ligatures (Latin-grade), so an outline of
# these without HarfBuzz can be mispositioned or mis-ordered. Used to WARN, not refuse.
_COMPLEX_RANGES = (
    (0x0300, 0x036F, "combining marks"),
    (0x0590, 0x05FF, "Hebrew"), (0xFB1D, 0xFB4F, "Hebrew"),
    (0x0600, 0x06FF, "Arabic"), (0x0750, 0x077F, "Arabic"),
    (0x08A0, 0x08FF, "Arabic"), (0xFB50, 0xFDFF, "Arabic"), (0xFE70, 0xFEFF, "Arabic"),
    (0x0700, 0x074F, "Syriac"), (0x0780, 0x07BF, "Thaana"), (0x07C0, 0x07FF, "NKo"),
    (0x0900, 0x097F, "Devanagari"), (0x0980, 0x09FF, "Bengali"), (0x0A00, 0x0A7F, "Gurmukhi"),
    (0x0A80, 0x0AFF, "Gujarati"), (0x0B00, 0x0B7F, "Oriya"), (0x0B80, 0x0BFF, "Tamil"),
    (0x0C00, 0x0C7F, "Telugu"), (0x0C80, 0x0CFF, "Kannada"), (0x0D00, 0x0D7F, "Malayalam"),
    (0x0D80, 0x0DFF, "Sinhala"), (0x0E00, 0x0E7F, "Thai"), (0x0E80, 0x0EFF, "Lao"),
    (0x0F00, 0x0FFF, "Tibetan"), (0x1000, 0x109F, "Myanmar"), (0x1780, 0x17FF, "Khmer"),
)


def _complex_script(text: str):
    """The first complex script found in `text`, or None — only meaningful for the fallback."""
    for ch in text:
        o = ord(ch)
        for lo, hi, name in _COMPLEX_RANGES:
            if lo <= o <= hi:
                return name
    return None


# ---- text -> outlines (T15, T23) ------------------------------------------
def text_to_outline(payload: dict) -> dict:
    from fontTools.ttLib import TTFont
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.transformPen import TransformPen
    from fontTools.pens.qu2cuPen import Qu2CuPen
    from fontTools.pens.recordingPen import DecomposingRecordingPen

    text = payload.get("text", "")
    family = (payload.get("family") or "").strip()
    if not family:
        raise ValueError("family required")
    weight = int(payload.get("weight", 400))
    italic = bool(payload.get("italic", False))
    source = payload.get("source", "")
    size = float(payload.get("fontSize", 16))
    letter_spacing = float(payload.get("letterSpacing", 0))   # user units (px)
    line_height = float(payload.get("lineHeight", 1.2))
    anchor = payload.get("anchor", "start")
    x0 = float(payload.get("x", 0))
    y0 = float(payload.get("y", 0))

    # Outline the requested face; if it isn't a downloadable web font (a system font like Arial),
    # fall back to a metric-compatible OFL stand-in so the text can still be vectorised.
    substituted = None
    try:
        path = ensure_font(family, weight, italic, source)
    except Exception:
        sub = _font_substitute(family)
        if not sub:
            raise
        path = ensure_font(sub, weight, italic, "")
        substituted = sub
    font = TTFont(path)
    upm = font["head"].unitsPerEm or 1000
    scale = size / upm
    glyphset = font.getGlyphSet()
    tables = _shape_tables(path, font)
    hbfont = _hb_font(font) if _hb is not None else None
    ls_font = (letter_spacing / scale) if scale else 0       # tracking, converted to font units
    # Characters the font has no glyph for — they'd shape to a blank advance (silent gap), so
    # report them and the client warns the user instead of letting them vanish.
    _cmap = set(font.getBestCmap().keys())
    missing = sorted({ch for ch in text if ch.strip() and ord(ch) not in _cmap})
    # Complex scripts need a real shaping engine; without HarfBuzz the fallback may mis-order or
    # mis-position them. Report the script so the client warns (we still emit a best-effort outline).
    complex_script = _complex_script(text) if hbfont is None else None

    def emit_glyph(gname, tx, ty, ds):
        spen = SVGPathPen(glyphset)
        tpen = TransformPen(spen, (scale, 0, 0, -scale, tx, ty))
        try:
            # Decompose composites (accents, ligatures like f_f_i) to contours FIRST, so their
            # quadratics flow through Qu2CuPen (all_cubic → clean, node-editable cubics) — a raw
            # addComponent would slip past the converter and leave quadratic Q segments.
            rec = DecomposingRecordingPen(glyphset)
            glyphset[gname].draw(rec)
            rec.replay(Qu2CuPen(tpen, max_err=0.25, all_cubic=True))
        except Exception:  # noqa: BLE001 — odd glyph: draw directly (still correct, may be quadratic)
            glyphset[gname].draw(tpen)
        d = spen.getCommands()
        if d:
            ds.append(d)
        return d

    # Per-glyph mode (text-on-path, T19): the curve layout is done in the browser (it owns the
    # bound path's getPointAtLength), so emit each glyph at a LOCAL origin (baseline y=0, pen
    # x=0) with its own advance + the kern/tracking step. The client places + rotates each glyph
    # along the path and bakes them into one editable all-cubic path. Single line (the textPath
    # run is one line; the caller already flattened newlines to spaces).
    if bool(payload.get("perGlyph")):
        line = text.replace("\n", " ")
        shaped = _shape_line(font, hbfont, line, tables)
        out_glyphs = []
        run = 0.0
        for gname, xadv, xoff, yoff in shaped:
            gd = ""
            if gname is not None:
                gd = emit_glyph(gname, xoff * scale, -yoff * scale, []) or ""
                if gd:
                    gd = re.sub(r"-?\d+\.\d+", lambda m: _num(m.group()), gd)
            w = xadv * scale                                  # the glyph's own advance (px)
            step = w + ls_font * scale                        # advance + tracking → next pen pos
            out_glyphs.append({"d": gd, "w": round(w, 3), "adv": round(step, 3),
                               "missing": gname is None})
            run += step
        return {"glyphs": out_glyphs, "count": len(out_glyphs),
                "empty": not any(g["d"] for g in out_glyphs),
                "advance": round(run, 2), "missing": missing, "substituted": substituted,
                "complexScript": complex_script,
                "shaper": "harfbuzz" if hbfont is not None else "fonttools"}

    ds: list[str] = []
    glyph_count = 0
    max_advance = 0.0
    for i, line in enumerate(text.split("\n")):
        shaped = _shape_line(font, hbfont, line, tables)
        # total advance (font units) incl. kerning + tracking, for anchor alignment
        total = sum(g[1] for g in shaped) + ls_font * max(0, len(shaped) - 1)
        lw = total * scale
        max_advance = max(max_advance, lw)
        lx = x0 - (lw / 2 if anchor == "middle" else lw if anchor == "end" else 0)
        ly = y0 + i * size * line_height
        penx = 0.0                                           # running advance in FONT units
        for gname, xadv, xoff, yoff in shaped:
            if gname is not None:
                tx = lx + (penx + xoff) * scale
                ty = ly - yoff * scale
                emit_glyph(gname, tx, ty, ds)
                glyph_count += 1
            penx += xadv + ls_font

    d = " ".join(ds)
    d = re.sub(r"-?\d+\.\d+", lambda m: _num(m.group()), d)   # round coords → clean, small path
    return {"d": d, "empty": not ds, "glyphs": glyph_count,
            "advance": round(max_advance, 2), "missing": missing, "substituted": substituted,
            "complexScript": complex_script,
            "shaper": "harfbuzz" if hbfont is not None else "fonttools"}


def _num(s: str) -> str:
    v = round(float(s), 2)
    out = f"{v:.2f}".rstrip("0").rstrip(".")
    return out if out and out != "-0" else "0"
