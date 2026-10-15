"""Audio I/O and processing: loudness measurement, volume leveling with clip repair and limiter,
key shifting and stem separation. Everything works on float32 arrays shaped (samples, channels).
"""

import shutil
from dataclasses import dataclass
from pathlib import Path

import numpy as np

try:
    import essentia

    essentia.log.infoActive = False
    essentia.log.warningActive = False
    import essentia.standard as es
except ImportError:
    es = None


# ---------- I/O ----------

def load_stereo(path: Path) -> tuple[np.ndarray, int]:
    """Decodes any format essentia/ffmpeg or libsndfile can read. Returns (samples, 2) float32 and the sample rate."""
    if es is not None:
        audio, sr, *_ = es.AudioLoader(filename=str(path))()
        x = np.asarray(audio, dtype=np.float32)
    else:
        import soundfile as sf

        x, sr = sf.read(str(path), dtype="float32", always_2d=True)
    if x.ndim == 1:
        x = x[:, None]
    if x.shape[1] == 1:
        x = np.repeat(x, 2, axis=1)
    return x[:, :2], int(sr)


def to_mono_44k(x: np.ndarray, sr: int) -> np.ndarray:
    y = x.mean(axis=1)
    if sr != 44100:
        import soxr

        y = soxr.resample(y, sr, 44100)
    return y.astype(np.float32)


WRITABLE = {".wav": "WAV", ".flac": "FLAC", ".aif": "AIFF", ".aiff": "AIFF", ".mp3": "MP3", ".ogg": "OGG"}


def write(path: Path, x: np.ndarray, sr: int) -> Path:
    """Writes audio; formats soundfile cannot encode (m4a, alac, opus) become AIFF next to the requested name."""
    import soundfile as sf

    ext = path.suffix.lower()
    if ext not in WRITABLE:
        path = path.with_suffix(".aiff")
        ext = ".aiff"
    kw = {}
    if ext == ".mp3":
        kw = {"bitrate_mode": "CONSTANT", "compression_level": 0.0}  # 320 kbit/s
    sub = {"WAV": "PCM_24", "AIFF": "PCM_24", "FLAC": "PCM_24"}.get(WRITABLE[ext])
    sf.write(str(path), np.clip(x, -1, 1), sr, format=WRITABLE[ext], subtype=sub, **kw)
    return path


def copy_tags(src: Path, dst: Path) -> bool:
    """Best-effort copy of title/artist/key/artwork tags with mutagen."""
    try:
        import mutagen

        s, d = mutagen.File(str(src)), mutagen.File(str(dst))
        if s is None or d is None or s.tags is None:
            return False
        if d.tags is None:
            d.add_tags()
        if type(s.tags) is type(d.tags):
            for k in list(s.tags.keys()):
                d.tags[k] = s.tags[k]
        else:  # different tag systems (e.g. ID3 -> Vorbis): copy the easy fields
            se, de = mutagen.File(str(src), easy=True), mutagen.File(str(dst), easy=True)
            if de.tags is None:
                de.add_tags()
            for k in ("title", "artist", "album", "genre", "date", "bpm", "tracknumber"):
                if se.tags and k in se.tags:
                    de.tags[k] = se.tags[k]
            de.save()
            return True
        d.save()
        return True
    except Exception:  # noqa: BLE001 - tags are a nice-to-have
        return False


# ---------- loudness ----------

def lufs(x: np.ndarray, sr: int) -> float:
    import pyloudnorm

    v = pyloudnorm.Meter(sr).integrated_loudness(x.astype(np.float64))
    return float(v) if np.isfinite(v) else -70.0


def true_peak_db(x: np.ndarray) -> float:
    from scipy.signal import resample_poly

    # 4x oversampling on a decimated copy keeps this fast while catching inter-sample peaks.
    peak = np.abs(resample_poly(x, 4, 1, axis=0)).max() if len(x) < 30_000_000 else np.abs(x).max()
    return float(20 * np.log10(peak + 1e-12))


def clipped_runs(ch: np.ndarray) -> list[tuple[int, int]]:
    """Flat tops: 4+ consecutive (nearly) identical samples near the channel's maximum (digital clipping)."""
    a = np.abs(ch)
    m = a.max()
    if m < 0.5:
        return []
    flat = (a[1:] >= 0.9 * m) & (np.abs(np.diff(ch)) < 1e-5)
    if not flat.any():
        return []
    d = np.diff(np.concatenate(([0], flat.astype(np.int8), [0])))
    starts, ends = np.flatnonzero(d == 1), np.flatnonzero(d == -1)
    return [(s, e + 1) for s, e in zip(starts, ends) if e - s >= 3]


def measure(x: np.ndarray, sr: int) -> dict:
    return {
        "lufs": round(lufs(x, sr), 2),
        "peak_db": round(true_peak_db(x), 2),
        "clipped": int(sum(len(clipped_runs(x[:, c])) for c in range(x.shape[1]))),
    }


# ---------- processing (volume leveling) ----------

@dataclass(frozen=True)
class Preset:
    key: str
    name: str
    lufs: float  # integrated loudness target
    ceiling_db: float  # limiter ceiling
    description: str


PRESETS = {
    "official": Preset("official", "Official", -12.0, -1.0, "Natural and dynamic. For hi-fi, home and club."),
    "festival": Preset("festival", "Festival", -9.0, -0.5, "For clubs, festivals and big sound systems."),
    "bigboost": Preset("bigboost", "Big Boost", -7.0, -0.3, "Very loud, like current Beatport releases."),
}


def declip(x: np.ndarray) -> tuple[np.ndarray, int]:
    """Rebuilds clipped peaks with a cubic spline through the samples around each flat run."""
    from scipy.interpolate import CubicSpline

    y = x.copy()
    fixed = 0
    for c in range(y.shape[1]):
        ch = y[:, c]
        for s, e in clipped_runs(ch):
            if e - s > 64:
                continue  # long flat stretches are intentional (or silence-like); leave them
            lo, hi = max(0, s - 4), min(len(ch), e + 4)
            idx = np.r_[lo:s, e:hi]
            if len(idx) < 4:
                continue
            ch[s:e] = CubicSpline(idx, ch[idx])(np.arange(s, e))
            fixed += 1
    return y, fixed


def _true_peak_env(x: np.ndarray) -> np.ndarray:
    """Per-sample peak including inter-sample overs (4x oversampled), shape (samples,)."""
    from scipy.signal import resample_poly

    up = np.abs(resample_poly(x, 4, 1, axis=0)).max(axis=1)
    n = len(x)
    return np.maximum(up[: n * 4].reshape(n, 4).max(axis=1), np.abs(x).max(axis=1))


def limiter(x: np.ndarray, sr: int, ceiling_db: float, lookahead_ms: float = 5.0, release_ms: float = 80.0) -> np.ndarray:
    """Look-ahead peak limiter: gain reduction starts before each peak and recovers smoothly."""
    from scipy.ndimage import maximum_filter1d
    from scipy.signal import lfilter

    ceil = 10 ** (ceiling_db / 20)
    look = max(1, int(sr * lookahead_ms / 1000))
    peak = _true_peak_env(x)
    need = np.clip(1 - ceil / np.maximum(peak, 1e-9), 0, None)  # required attenuation (0 = none)
    from scipy.ndimage import uniform_filter1d

    # Hold the needed attenuation +-look samples, then average over look samples: the gain ramps down
    # smoothly before each peak and is fully applied at the peak itself.
    held = maximum_filter1d(need, size=2 * look + 1)
    ramp = uniform_filter1d(held, size=look + 1)
    a_rel = np.exp(-1 / (sr * release_ms / 1000))
    # Smooth release: one-pole filter, but never below what is needed right now.
    att = np.maximum(lfilter([1 - a_rel], [1, -a_rel], ramp), ramp)
    y = x * (1 - att)[:, None]
    return np.clip(y, -ceil, ceil)


def contrast(x: np.ndarray, sr: int, amount_db: float = 1.5) -> np.ndarray:
    """Gently widens the difference between quiet and loud sections (slow upward/downward gain riding)."""
    from scipy.ndimage import uniform_filter1d

    hop = sr // 10
    n = len(x) // hop
    if n < 30:
        return x
    rms = np.sqrt((x[: n * hop].mean(axis=1).reshape(n, hop) ** 2).mean(axis=1) + 1e-12)
    db = 20 * np.log10(rms)
    st = uniform_filter1d(db, 30)  # 3 s short-term level
    dev = st - np.median(st[st > st.max() - 30])
    g_db = np.clip(0.25 * dev, -amount_db, amount_db)
    g_db = uniform_filter1d(g_db, 20)
    g = np.interp(np.arange(len(x)), np.arange(n) * hop + hop // 2, 10 ** (g_db / 20))
    return x * g[:, None].astype(np.float32)


def process(x: np.ndarray, sr: int, preset: Preset, repair: bool = True, use_contrast: bool = False) -> tuple[np.ndarray, dict]:
    """Levels a track to the preset loudness. Returns the processed audio and a report."""
    before = measure(x, sr)
    y = x.astype(np.float32)
    fixed = 0
    if repair:
        y, fixed = declip(y)
    if use_contrast:
        y = contrast(y, sr)
    # Two passes: the limiter takes away some loudness, so correct once more after it.
    gain_db = 0.0
    for _ in range(2):
        cur = lufs(y, sr)
        g = preset.lufs - cur
        gain_db += g
        y = limiter(y * 10 ** (g / 20), sr, preset.ceiling_db)
    after = measure(y, sr)
    return y, {"before": before, "after": after, "gain_db": round(gain_db, 2), "peaks_fixed": fixed}


def playback_gain(track_lufs: float | None, target_lufs: float, max_boost_db: float = 12.0) -> float:
    """Non-destructive gain (dB) the player applies when 'Level volume' is on."""
    if track_lufs is None:
        return 0.0
    return float(np.clip(target_lufs - track_lufs, -24.0, max_boost_db))


# ---------- key shift ----------

def pitch_shift(x: np.ndarray, sr: int, semitones: int) -> np.ndarray:
    """Changes the key without changing the tempo. Uses Rubber Band when installed, otherwise librosa."""
    if semitones == 0:
        return x
    if shutil.which("rubberband"):
        import pyrubberband

        return pyrubberband.pitch_shift(x, sr, semitones).astype(np.float32)
    import librosa

    return np.stack([librosa.effects.pitch_shift(x[:, c], sr=sr, n_steps=semitones, res_type="soxr_hq")
                     for c in range(x.shape[1])], axis=1).astype(np.float32)


# ---------- stems ----------

_separator = None


def stems_available() -> bool:
    try:
        import demucs.api  # noqa: F401
        return True
    except ImportError:
        return False


def separate(x: np.ndarray, sr: int, progress=None) -> dict[str, np.ndarray]:
    """Splits into 'vocals' and 'instrumental' with Demucs (htdemucs). Model weights download on first use."""
    global _separator
    import torch
    from demucs.api import Separator

    if _separator is None:
        device = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
        _separator = Separator(model="htdemucs", device=device, segment=7)

    def cb(info):
        if progress and info.get("state") == "end" and info.get("audio_length"):
            progress(min(0.99, info["segment_offset"] / info["audio_length"]))

    _separator.update_parameter(callback=cb)
    wav = torch.from_numpy(np.ascontiguousarray(x.T))
    _, parts = _separator.separate_tensor(wav, sr)
    out_sr = _separator.samplerate
    vocals = parts["vocals"].cpu().numpy().T
    inst = sum(v for k, v in parts.items() if k != "vocals").cpu().numpy().T
    if out_sr != sr:
        import soxr

        vocals, inst = soxr.resample(vocals, out_sr, sr), soxr.resample(inst, out_sr, sr)
    return {"vocals": vocals.astype(np.float32), "instrumental": inst.astype(np.float32)}
