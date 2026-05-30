"""Refit traced outlines to their minimal cubic-bezier representation.

vtracer over-segments: a straight spike becomes dozens of tiny splines, a round
letter dozens more. This collapses each subpath to the fewest anchors that still
reproduce it within a tolerance — corners stay sharp (the path is split at sharp
turns and each run fit independently), smooth runs become a few cubics.

The tolerance is a FRACTION of the image size, so node count is resolution-stable:
a 2000px and a 500px trace of the same logo simplify to the same handful of nodes.
That is the cure for "node aliasing as resolution scales" — denser pixels no
longer mean denser output.

Pure numpy. Implements Philip J. Schneider's curve-fitting (Graphics Gems, 1990)
with corner pre-splitting.
"""
from __future__ import annotations
import math
import re
import numpy as np

# ---------------------------------------------------------------- path parsing
def _parse(d: str):
    for m in re.finditer(r'([MLCZmlcz])([^MLCZmlcz]*)', d):
        nums = [float(x) for x in re.findall(r'-?\d*\.?\d+(?:[eE]-?\d+)?', m.group(2))]
        yield m.group(1), nums


def _subpaths(d: str, samples: int = 12):
    """Flatten a path's d to a list of closed polylines (Nx2 arrays)."""
    subs, cur = [], []
    px = py = 0.0
    for cmd, n in _parse(d):
        u = cmd.upper()
        if u == "M":
            if cur:
                subs.append(cur)
            px, py = n[0], n[1]
            cur = [(px, py)]
            for i in range(2, len(n), 2):
                px, py = n[i], n[i + 1]
                cur.append((px, py))
        elif u == "L":
            for i in range(0, len(n), 2):
                px, py = n[i], n[i + 1]
                cur.append((px, py))
        elif u == "C":
            for i in range(0, len(n), 6):
                x1, y1, x2, y2, x, y = n[i:i + 6]
                for t in np.linspace(0, 1, samples)[1:]:
                    mt = 1 - t
                    cur.append((mt**3*px + 3*mt**2*t*x1 + 3*mt*t*t*x2 + t**3*x,
                                mt**3*py + 3*mt**2*t*y1 + 3*mt*t*t*y2 + t**3*y))
                px, py = x, y
        elif u == "Z":
            if cur:
                subs.append(cur)
                cur = []
    if cur:
        subs.append(cur)
    out = []
    for s in subs:
        a = np.array(s, float)
        # drop consecutive duplicates
        if len(a) > 1:
            keep = np.concatenate(([True], (np.abs(np.diff(a, axis=0)).sum(1) > 1e-6)))
            a = a[keep]
        if len(a) >= 3:
            out.append(a)
    return out


# ---------------------------------------------------------------- Schneider fit
def _bez(ctrl, t):
    mt = 1 - t
    return (mt**3*ctrl[0] + 3*mt**2*t*ctrl[1] + 3*mt*t*t*ctrl[2] + t**3*ctrl[3])


def _chord_param(P):
    d = np.concatenate(([0.0], np.cumsum(np.hypot(*(np.diff(P, axis=0).T)))))
    return d / d[-1] if d[-1] > 0 else np.linspace(0, 1, len(P))


def _generate_bezier(P, u, t1, t2):
    p0, pl = P[0], P[-1]
    A0 = t1 * (3 * (1 - u)**2 * u)[:, None]
    A1 = t2 * (3 * (1 - u) * u**2)[:, None]
    B0 = (1 - u)**3; B1 = 3 * (1 - u)**2 * u; B2 = 3 * (1 - u) * u**2; B3 = u**3
    fp = p0 * (B0 + B1)[:, None] + pl * (B2 + B3)[:, None]
    res = P - fp
    c00 = (A0 * A0).sum(); c01 = (A0 * A1).sum(); c11 = (A1 * A1).sum()
    x0 = (A0 * res).sum(); x1 = (A1 * res).sum()
    det = c00 * c11 - c01 * c01
    chord = np.hypot(*(pl - p0))
    if abs(det) < 1e-12:
        a0 = a1 = chord / 3.0
    else:
        a0 = (x0 * c11 - x1 * c01) / det
        a1 = (c00 * x1 - c01 * x0) / det
    if a0 < 1e-6 or a1 < 1e-6:
        a0 = a1 = chord / 3.0
    return np.array([p0, p0 + t1 * a0, pl + t2 * a1, pl])


def _max_error(P, ctrl, u):
    pts = np.array([_bez(ctrl, ui) for ui in u])
    d2 = ((pts - P)**2).sum(1)
    i = int(d2.argmax())
    return math.sqrt(d2[i]), i


def _reparam(P, ctrl, u):
    out = u.copy()
    for i, ui in enumerate(u):
        q = _bez(ctrl, ui)
        d1 = 3*(1-ui)**2*(ctrl[1]-ctrl[0]) + 6*(1-ui)*ui*(ctrl[2]-ctrl[1]) + 3*ui*ui*(ctrl[3]-ctrl[2])
        d2 = 6*(1-ui)*(ctrl[2]-2*ctrl[1]+ctrl[0]) + 6*ui*(ctrl[3]-2*ctrl[2]+ctrl[1])
        num = ((q - P[i]) * d1).sum()
        den = (d1 * d1).sum() + ((q - P[i]) * d2).sum()
        out[i] = ui if abs(den) < 1e-12 else ui - num / den
    return np.clip(out, 0.0, 1.0)


def _unit(v):
    n = np.hypot(*v)
    return v / n if n > 1e-9 else np.zeros(2)


def _fit(P, t1, t2, tol, depth=0):
    if len(P) == 2:
        d = np.hypot(*(P[1] - P[0])) / 3.0
        return [np.array([P[0], P[0] + t1 * d, P[1] + t2 * d, P[1]])]
    u = _chord_param(P)
    ctrl = _generate_bezier(P, u, t1, t2)
    err, split = _max_error(P, ctrl, u)
    if err < tol:
        return [ctrl]
    if err < tol * 4 and depth < 24:
        for _ in range(4):
            u = _reparam(P, ctrl, u)
            ctrl = _generate_bezier(P, u, t1, t2)
            err, split = _max_error(P, ctrl, u)
            if err < tol:
                return [ctrl]
    if depth > 28 or split <= 0 or split >= len(P) - 1:
        return [ctrl]
    tc = _unit(P[split - 1] - P[split + 1])
    left = _fit(P[:split + 1], t1, tc, tol, depth + 1)
    right = _fit(P[split:], -tc, t2, tol, depth + 1)
    return left + right


# ---------------------------------------------------------------- decimate
def _rdp_mask(P, eps):
    """RDP keep-mask over an open polyline (iterative). True = keep."""
    n = len(P)
    keep = np.zeros(n, bool)
    if n == 0:
        return keep
    keep[0] = keep[-1] = True
    if n < 3:
        return keep
    stack = [(0, n - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        seg = P[a:b + 1]
        d = seg[-1] - seg[0]; L = math.hypot(*d)
        dist = (np.hypot(*((seg - seg[0]).T)) if L < 1e-9
                else np.abs(np.cross(d / L, seg - seg[0])))
        i = int(dist.argmax())
        if dist[i] > eps:
            keep[a + i] = True
            stack.append((a, a + i)); stack.append((a + i, b))
    return keep


def _corner_flags(K, ang_deg):
    """Which decimated vertices turn sharper than ang_deg (a real corner)."""
    n = len(K); thr = math.cos(math.radians(ang_deg)); out = []
    for i in range(n):
        a = _unit(K[i] - K[(i - 1) % n])
        b = _unit(K[(i + 1) % n] - K[i])
        out.append(bool(a.any() and b.any() and float(a @ b) < thr))
    return out


def _dedup(run):
    if len(run) < 2:
        return run
    keep = np.concatenate(([True], np.abs(np.diff(run, axis=0)).sum(1) > 1e-6))
    return run[keep]


def _fit_loop(P, tol, corner_ang):
    """Locate corners on an RDP-decimated copy (so spike tips are crisp single
    vertices), but fit cubics to the *dense* points in each run between corners —
    accurate curves, minimal segments, response that tracks the tolerance."""
    dense = np.vstack([P, P[0]])              # close the loop
    mask = _rdp_mask(dense, tol)
    idx = np.nonzero(mask)[0]                  # dense indices kept by RDP
    if len(idx) < 3:
        return []
    K = dense[idx]
    if np.allclose(K[0], K[-1]):
        K = K[:-1]; idx = idx[:-1]
    flags = _corner_flags(K, corner_ang)
    cuts = sorted(int(idx[i]) for i in range(len(idx)) if flags[i])
    if not cuts:
        # smooth closed loop: seam at the sharpest decimated vertex, fit dense once
        si = min(range(len(K)), key=lambda i: float(_unit(K[i]-K[(i-1)%len(K)]) @ _unit(K[(i+1)%len(K)]-K[i])))
        s = int(idx[si]); Q = _dedup(np.vstack([dense[s:], dense[1:s + 1]]))
        return _fit(Q, _unit(Q[1]-Q[0]), _unit(Q[-2]-Q[-1]), tol) if len(Q) >= 2 else []
    segs = []
    for j in range(len(cuts)):
        a, b = cuts[j], cuts[(j + 1) % len(cuts)]
        run = dense[a:b + 1] if b > a else np.vstack([dense[a:], dense[:b + 1]])
        run = _dedup(run)
        if len(run) < 2:
            continue
        segs += _fit(run, _unit(run[1]-run[0]), _unit(run[-2]-run[-1]), tol)
    return segs


# ---------------------------------------------------------------- emit
def _fmt(v, prec):
    s = f"{v:.{prec}f}".rstrip("0").rstrip(".")
    return s if s not in ("", "-0") else "0"


def _emit(segs, prec):
    if not segs:
        return ""
    p = lambda xy: f"{_fmt(xy[0], prec)},{_fmt(xy[1], prec)}"
    out = [f"M{p(segs[0][0])}"]
    for s in segs:
        # collapse a near-straight cubic to a line (controls on the chord)
        chord = s[3] - s[0]; cl = np.hypot(*chord)
        if cl > 1e-6:
            cdir = chord / cl
            dev = max(abs(np.cross(cdir, s[1]-s[0])), abs(np.cross(cdir, s[2]-s[0])))
        else:
            dev = 1.0
        if dev < 0.25:
            out.append(f"L{p(s[3])}")
        else:
            out.append(f"C{p(s[1])} {p(s[2])} {p(s[3])}")
    out.append("Z")
    return "".join(out)


def simplify_d(d: str, frac: float, corner_ang: float = 42.0, prec: int = 1, floor: float = 0.75):
    """Simplify one path. Tolerance is per-SUBPATH and feature-relative — a fraction
    of that subpath's own size — so a tiny letter and a giant spike are each reduced
    in proportion to themselves, never by one global pixel budget."""
    segs_count = 0
    pieces = []
    for P in _subpaths(d):
        lo = P.min(0); hi = P.max(0)
        tol = max(floor, frac * float(max(hi[0] - lo[0], hi[1] - lo[1])))
        segs = _fit_loop(P, tol, corner_ang)
        if segs:
            pieces.append(_emit(segs, prec))
            segs_count += len(segs)
    return " ".join(pieces), segs_count


# ---------------------------------------------------------------- whole SVG
def simplify_svg_text(text: str, frac: float = 0.02, corner_ang: float = 42.0):
    """Refit every <path> in an SVG. Tolerance is feature-relative (per subpath),
    so node count is stable across resolutions and small features keep their shape
    while large ones collapse to their minimal anchors."""
    before = after = 0

    def repl(m):
        nonlocal before, after
        d = m.group(1)
        before += len(re.findall(r'[MLCZ]', d))
        nd, segs = simplify_d(d, frac, corner_ang)
        after += segs
        return f'd="{nd}"' if nd else m.group(0)

    new = re.sub(r'd="([^"]*)"', repl, text)
    return new, {"nodes_before": before, "nodes_after": after, "frac": frac}
