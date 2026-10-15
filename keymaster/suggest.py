"""Harmonic matching: mashup ideas (with key shift), mix-out ideas and set ordering."""

from . import keys

# Camelot relations, best first. Score 0..1.
RELATIONS = {
    "same": (1.0, "Same key"),
    "adjacent": (0.85, "±1 Camelot"),
    "relative": (0.8, "Relative key"),
    "boost": (0.55, "Energy Boost (+2)"),
    "semitone": (0.45, "+1 semitone"),
}


def camelot_parts(code: str | None) -> tuple[int, str] | None:
    k = keys.parse(code or "")
    if not k:
        return None
    c = k.camelot
    return int(c[:-1]), c[-1]


def shift_camelot(code: str, semitones: int) -> str:
    """Key after shifting by semitones; one semitone up = +7 on the Camelot wheel."""
    n, letter = camelot_parts(code)
    return f"{(n - 1 + 7 * semitones) % 12 + 1}{letter}"


def relation(a: str | None, b: str | None) -> str | None:
    pa, pb = camelot_parts(a), camelot_parts(b)
    if not pa or not pb:
        return None
    (na, la), (nb, lb) = pa, pb
    d = (nb - na) % 12
    if la == lb:
        if d == 0:
            return "same"
        if d in (1, 11):
            return "adjacent"
        if d == 2:
            return "boost"
        if d == 7:
            return "semitone"
    elif d == 0:
        return "relative"
    return None


def tempo_match(a_bpm: float, b_bpm: float) -> tuple[float, float] | None:
    """(pitch change in %, ratio used) to play b at a's tempo, also via half/double time. None if > 10 %."""
    if not a_bpm or not b_bpm:
        return None
    best = None
    for r in (1.0, 2.0, 0.5):
        pct = (a_bpm / (b_bpm * r) - 1) * 100
        if best is None or abs(pct) < abs(best[0]):
            best = (pct, r)
    return best if abs(best[0]) <= 10 else None


def _score(rel: str, pct: float, shift: int, energy_delta: int = 0) -> float:
    s = RELATIONS[rel][0]
    s -= abs(pct) / 25  # 4 % pitch costs ~0.16
    s -= abs(shift) * 0.12
    s -= max(0, -energy_delta) * 0.04  # dropping energy is less attractive in a mix
    return round(s, 3)


def mashups(a: dict, pool: list[dict], max_shift: int = 2, limit: int = 40) -> list[dict]:
    """Tracks that work on top of track a, optionally after shifting their key by up to max_shift semitones."""
    out = []
    for b in pool:
        if b["id"] == a["id"] or not b.get("key") or not b.get("bpm"):
            continue
        tm = tempo_match(a.get("bpm") or 0, b["bpm"])
        if not tm:
            continue
        best = None
        for shift in range(-max_shift, max_shift + 1):
            rel = relation(a["key"], shift_camelot(b["key"], shift))
            if rel not in ("same", "adjacent", "relative"):
                continue
            sc = _score(rel, tm[0], shift)
            if best is None or sc > best["score"]:
                best = {"id": b["id"], "shift": shift, "relation": rel, "label": RELATIONS[rel][1],
                        "key_after": shift_camelot(b["key"], shift), "pitch_pct": round(tm[0], 2),
                        "ratio": tm[1], "score": sc}
        if best:
            out.append(best)
    out.sort(key=lambda m: -m["score"])
    return out[:limit]


def mixouts(a: dict, pool: list[dict], limit: int = 40) -> list[dict]:
    """Good next tracks after a: compatible key, close tempo, similar or rising energy."""
    out = []
    for b in pool:
        if b["id"] == a["id"] or not b.get("key") or not b.get("bpm"):
            continue
        rel = relation(a.get("key"), b["key"])
        tm = tempo_match(a.get("bpm") or 0, b["bpm"])
        if not rel or not tm or abs(tm[0]) > 6:
            continue
        de = (b.get("energy") or 5) - (a.get("energy") or 5)
        out.append({"id": b["id"], "relation": rel, "label": RELATIONS[rel][1], "pitch_pct": round(tm[0], 2),
                    "ratio": tm[1], "energy_delta": de, "score": _score(rel, tm[0], 0, de)})
    out.sort(key=lambda m: -m["score"])
    return out[:limit]


def order_set(tracks: list[dict], start_id: int | None = None, curve: str = "rise") -> list[int]:
    """Greedy harmonic ordering. curve 'rise' builds energy, 'peak' rises then falls, 'flat' keeps it level."""
    left = [t for t in tracks if t.get("key") and t.get("bpm")]
    rest = [t["id"] for t in tracks if t not in left]
    if not left:
        return rest
    by_id = {t["id"]: t for t in left}
    if start_id in by_id:
        cur = by_id[start_id]
    else:
        cur = min(left, key=lambda t: ((t.get("energy") or 5), t["bpm"]))
    order = [cur]
    left.remove(cur)
    n_total = len(left) + 1
    while left:
        pos = len(order) / n_total
        want = 1 if curve == "rise" or (curve == "peak" and pos < 0.7) else (-1 if curve == "peak" else 0)

        def cost(b):
            rel = relation(cur["key"], b["key"])
            tm = tempo_match(cur["bpm"], b["bpm"])
            c = 0.0 if rel is None else -RELATIONS[rel][0]
            c += 1.0 if rel is None else 0.0
            c += abs(tm[0]) / 10 if tm else 1.5
            de = (b.get("energy") or 5) - (cur.get("energy") or 5)
            c += abs(de - want) * 0.15
            return c

        nxt = min(left, key=cost)
        order.append(nxt)
        left.remove(nxt)
        cur = nxt
    return [t["id"] for t in order] + rest
