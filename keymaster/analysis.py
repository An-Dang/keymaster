"""Audio analysis: key, BPM + first beat, energy (1-10) and automatic phrase cues.

Uses essentia (KeyExtractor with the EDM profile, RhythmExtractor2013) when it is installed,
otherwise librosa. Both paths return the same Analysis.
"""

import threading
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .keys import Key, pitch_class

try:
    import essentia

    essentia.log.infoActive = False
    essentia.log.warningActive = False
    import essentia.standard as es
except ImportError:  # librosa-only install
    es = None

ENGINES = ("essentia", "librosa") if es else ("librosa",)

# Krumhansl-Kessler profiles, same as analysis.js
KK_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KK_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


@dataclass
class Cue:
    slot: int  # hot cue pad 0..7 (A..H)
    t: float  # seconds
    name: str = ""


@dataclass
class Analysis:
    path: Path
    duration: float
    sample_rate: int
    bpm: float
    first_beat: float
    key: Key
    energy: int
    cues: list[Cue] = field(default_factory=list)


def load(path: Path, engine: str) -> tuple[np.ndarray, int]:
    if engine == "essentia":
        sr = 44100
        return es.MonoLoader(filename=str(path), sampleRate=sr)(), sr
    import librosa

    try:
        y, sr = librosa.load(str(path), sr=22050, mono=True)
    except Exception as e:
        raise RuntimeError(f"{e} - librosa cannot read this file; --engine essentia "
                           "or ffmpeg (brew install ffmpeg) usually helps") from e
    return y.astype(np.float32), sr


# ---------- key ----------

def key_essentia(y: np.ndarray, sr: int) -> Key:
    name, scale, strength = es.KeyExtractor(profileType="edma", sampleRate=sr)(y)
    return Key(pitch_class(name), scale == "minor", float(strength))


def key_librosa(y: np.ndarray, sr: int) -> Key:
    import librosa

    y_h = librosa.effects.harmonic(y, margin=4)
    tuning = librosa.estimate_tuning(y=y_h, sr=sr)
    chroma = librosa.feature.chroma_cqt(y=y_h, sr=sr, tuning=tuning, bins_per_octave=36)
    chroma = np.log1p(10 * chroma)
    profiles = [(pc, minor, np.roll(KK_MINOR if minor else KK_MAJOR, pc)) for minor in (False, True) for pc in range(12)]
    # Vote over ~20 s windows so a long break in another key does not dominate the result.
    hop_s = 512 / sr
    win = max(1, int(20 / hop_s))
    scores = np.zeros(len(profiles))
    for start in range(0, chroma.shape[1], win):
        c = chroma[:, start:start + win].mean(axis=1)
        if c.std() < 1e-6:
            continue
        r = np.array([np.corrcoef(c, p)[0, 1] for _, _, p in profiles])
        scores += np.clip(r, 0, None) * c.sum()
    order = np.argsort(scores)[::-1]
    pc, minor, _ = profiles[order[0]]
    total = scores[order[0]] or 1.0
    return Key(pc, minor, float((scores[order[0]] - scores[order[1]]) / total))


# ---------- tempo / grid ----------

def _round_bpm(bpm: float) -> float:
    while bpm < 70:
        bpm *= 2
    while bpm > 180:
        bpm /= 2
    return float(round(bpm)) if abs(bpm - round(bpm)) < 0.15 else round(bpm, 1)


HOP = 256


def _onset_env(y: np.ndarray, sr: int) -> tuple[np.ndarray, float]:
    import librosa

    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=HOP, aggregate=np.median)
    return env - env.mean(), sr / HOP


def refine_bpm(env: np.ndarray, fps: float, rough_bpm: float) -> float:
    """Sharpens a rough tempo with a comb over the onset autocorrelation (long lags = fine resolution)."""
    n = len(env)
    spec = np.fft.rfft(env, 2 * n)
    acf = np.fft.irfft(spec * np.conj(spec))[:n] / np.arange(n, 0, -1)
    rough = _round_bpm(rough_bpm)

    def score(bpm):
        lags = 60 * fps / bpm * np.arange(1, 33)
        lags = lags[lags < n - 1]
        return np.interp(lags, np.arange(n), acf).mean() if len(lags) else -np.inf

    best = max(np.arange(rough - 1.5, rough + 1.5, 0.01), key=score)
    # Produced dance music is almost always a whole BPM; a near-miss like 154.7 drifts ~1.5 beats over 5 min.
    whole = round(best)
    if abs(best - whole) < 0.5 and score(whole) >= 0.97 * score(best):
        best = whole
    return _round_bpm(best)


def grid_phase(beats: np.ndarray, bpm: float) -> float:
    """First beat (seconds, within one beat) as the circular mean of the beat phases."""
    if not len(beats):
        return 0.0
    period = 60.0 / bpm
    ang = 2 * np.pi * (beats % period) / period
    return float((np.angle(np.mean(np.exp(1j * ang))) / (2 * np.pi)) % 1.0 * period)


_beat_model = None
# Metal (MPS) aborts the whole process when two threads submit GPU work at once; every model call takes this lock.
GPU_LOCK = threading.Lock()


def beat_grid(y: np.ndarray, sr: int, bpm: float) -> float | None:
    """First downbeat (seconds, within one bar) from the Beat This! beat/downbeat model, or None if unavailable.

    General onset trackers often lock onto the off-beat in tracks with a rolling off-beat bass;
    the model tells kicks from off-beats and also finds bar starts.
    """
    global _beat_model
    try:
        import torch
        from beat_this.inference import Audio2Beats
    except ImportError:
        return None
    with GPU_LOCK:
        if _beat_model is None:
            device = "mps" if torch.backends.mps.is_available() else "cpu"
            _beat_model = Audio2Beats(checkpoint_path="final0", device=device)
        beats, downbeats = _beat_model(y, sr)
    if len(beats) < 16:
        return None
    period = 60.0 / bpm

    def circ(times: np.ndarray, unit: float) -> float:
        ang = 2 * np.pi * (times % unit) / unit
        return float((np.angle(np.mean(np.exp(1j * ang))) / (2 * np.pi)) % 1.0 * unit)

    beat = circ(np.asarray(beats), period)
    if len(downbeats) < 4:
        return beat
    # Bar start: the beat-grid position (0..3 beats after `beat`) closest to the detected downbeats.
    bar = circ(np.asarray(downbeats), 4 * period)
    k = round(((bar - beat) / period)) % 4
    return beat + k * period


def tempo_essentia(y: np.ndarray, sr: int) -> tuple[float, float]:
    bpm, ticks, *_ = es.RhythmExtractor2013(method="multifeature")(y)
    env, fps = _onset_env(y, sr)
    bpm = refine_bpm(env, fps, float(bpm))
    phase = beat_grid(y, sr, bpm)
    return bpm, phase if phase is not None else grid_phase(np.asarray(ticks), bpm)


def tempo_librosa(y: np.ndarray, sr: int) -> tuple[float, float]:
    import librosa

    env, fps = _onset_env(y, sr)
    tempo, beats = librosa.beat.beat_track(onset_envelope=env - env.min(), sr=sr, hop_length=HOP,
                                           start_bpm=122, units="time")
    bpm = refine_bpm(env, fps, float(np.atleast_1d(tempo)[0]))
    phase = beat_grid(y, sr, bpm)
    return bpm, phase if phase is not None else grid_phase(np.asarray(beats), bpm)


# ---------- energy ----------

def _bands(y: np.ndarray, sr: int) -> tuple[np.ndarray, np.ndarray]:
    from scipy.signal import butter, sosfilt

    low = sosfilt(butter(2, 150, "lowpass", fs=sr, output="sos"), y)
    high = sosfilt(butter(2, 2500, "highpass", fs=sr, output="sos"), y)
    return low, high


def _chunk_power(x: np.ndarray, size: int) -> np.ndarray:
    n = len(x) // size
    if n == 0:
        return np.array([float(np.mean(x ** 2))]) if len(x) else np.zeros(1)
    return (x[: n * size].reshape(n, size) ** 2).mean(axis=1)


def energy(y: np.ndarray, sr: int, high: np.ndarray) -> int:
    """1-10 rating from loudness (70th percentile of 0.5 s chunks) and brightness, like analysis.js."""
    size = sr // 2
    tot = _chunk_power(y, size)
    hi = _chunk_power(high, size)
    db = 10 * np.log10(np.percentile(tot, 70) + 1e-12)
    loud = np.clip((db + 28) / 18, 0, 1)
    bright = np.clip((np.sqrt(hi.sum() / (tot.sum() or 1)) - 0.08) / 0.35, 0, 1)
    return int(np.clip(round(1 + 9 * (0.7 * loud + 0.3 * bright)), 1, 10))


# ---------- auto cues ----------

def phrase_cues(y: np.ndarray, sr: int, low: np.ndarray, bpm: float, first_beat: float,
                max_cues: int = 8, phrase_beats: int = 32, min_change_db: float = 4.0) -> list[Cue]:
    """Hot cues at 8-bar phrase boundaries where the bass energy jumps (Drop) or falls away (Break).

    Pad A is the first audible beat. A heuristic for 4/4 dance music; it assumes the grid's
    first beat is a downbeat, as Rekordbox does.
    """
    period = 60.0 / bpm
    duration = len(y) / sr
    loud = np.flatnonzero(np.abs(y) > 0.02 * (np.abs(y).max() or 1))
    start = loud[0] / sr if len(loud) else 0.0
    t0 = first_beat + np.ceil((start - first_beat) / period - 0.25) * period
    t0 = max(t0, first_beat)
    cues = [Cue(0, float(t0), "Start")]

    bounds = np.arange(t0, duration, phrase_beats * period)
    if len(bounds) < 3:
        return cues
    level = []
    for a, b in zip(bounds[:-1], bounds[1:]):
        seg = low[int(a * sr):int(b * sr)]
        level.append(10 * np.log10(np.mean(seg ** 2) + 1e-12))
    level = np.array(level)
    cands = []
    for i in range(1, len(level)):
        d = level[i] - level[i - 1]
        if abs(d) >= min_change_db:
            cands.append((abs(d), float(bounds[i]), "Drop" if d > 0 else "Break"))
    cands.sort(reverse=True)
    picked = sorted(cands[: max_cues - 1], key=lambda c: c[1])
    cues += [Cue(i + 1, t, name) for i, (_, t, name) in enumerate(picked)]
    return cues


WAVE_RATE = 150  # waveform columns per second


def waveform(y: np.ndarray, sr: int, rate: int = WAVE_RATE) -> np.ndarray:
    """Three-band (low < 250 Hz, mid, high > 2.5 kHz) RMS per column as uint8, shape (n, 3)."""
    from scipy.signal import butter, sosfilt

    lo = sosfilt(butter(2, 250, "lowpass", fs=sr, output="sos"), y)
    hi = sosfilt(butter(2, 2500, "highpass", fs=sr, output="sos"), y)
    mid = y - lo - hi
    size = max(1, sr // rate)
    n = len(y) // size
    out = np.stack([np.sqrt((b[: n * size].reshape(n, size) ** 2).mean(axis=1)) for b in (lo, mid, hi)], axis=1)
    peak = out.max() or 1.0
    return np.clip(np.sqrt(out / peak) * 255, 0, 255).astype(np.uint8)


def analyze(path: Path, engine: str | None = None, auto_cues: bool = False,
            y: np.ndarray | None = None, sr: int | None = None) -> Analysis:
    """Analyzes a file; pass y/sr (mono float32, 44.1 kHz for essentia) to reuse an already decoded signal."""
    engine = engine or ENGINES[0]
    if engine not in ENGINES:
        raise ValueError(f"Engine '{engine}' not available (installed: {', '.join(ENGINES)})")
    if y is None:
        y, sr = load(path, engine)
    if len(y) < sr:
        raise ValueError("Audio is shorter than one second")
    if engine == "essentia":
        key = key_essentia(y, sr)
        bpm, first_beat = tempo_essentia(y, sr)
    else:
        key = key_librosa(y, sr)
        bpm, first_beat = tempo_librosa(y, sr)
    low, high = _bands(y, sr)
    res = Analysis(path=path, duration=len(y) / sr, sample_rate=sr, bpm=bpm,
                   first_beat=first_beat, key=key, energy=energy(y, sr, high))
    if auto_cues:
        res.cues = phrase_cues(y, sr, low, bpm, first_beat)
    return res
