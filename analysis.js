const AN = (() => {
  const sleep = () => new Promise(r => setTimeout(r, 0));

  function makeFFT(n) {
    const levels = Math.round(Math.log2(n));
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0, x = i;
      for (let j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>= 1; }
      rev[i] = r;
    }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
    const win = new Float32Array(n);
    for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    const re = new Float64Array(n), im = new Float64Array(n), mag = new Float32Array(n / 2);
    return function (data, off) {
      for (let i = 0; i < n; i++) {
        const idx = off + i;
        const v = idx < data.length ? data[idx] * win[i] : 0;
        re[rev[i]] = v; im[rev[i]] = 0;
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = 0, k = 0; j < half; j++, k += step) {
            const a = i + j, b = a + half;
            const tr = re[b] * cos[k] + im[b] * sin[k];
            const ti = im[b] * cos[k] - re[b] * sin[k];
            re[b] = re[a] - tr; im[b] = im[a] - ti;
            re[a] += tr; im[a] += ti;
          }
        }
      }
      for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
      return mag;
    };
  }

  function interp(a, t) {
    const i = Math.floor(t);
    if (i < 0 || i + 1 >= a.length) return 0;
    const f = t - i;
    return a[i] * (1 - f) + a[i + 1] * f;
  }

  function detrend(env, w) {
    const n = env.length, pre = new Float64Array(n + 1), out = new Float32Array(n);
    for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + env[i];
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - w), b = Math.min(n, i + w + 1);
      const m = (pre[b] - pre[a]) / (b - a);
      out[i] = Math.max(0, env[i] - m);
    }
    return out;
  }

  // Spectral flux onset envelope (full band for tempo, low band for beat phase)
  async function onsetEnvelope(x, sr) {
    const N = 1024, hop = 256, fft = makeFFT(N), fps = sr / hop;
    const nF = Math.max(1, Math.floor((x.length - N) / hop) + 1);
    const binHz = sr / N;
    const maxBin = Math.min(N / 2, Math.floor(6000 / binHz));
    const lowBin = Math.max(2, Math.ceil(160 / binHz));
    const prev = new Float32Array(maxBin);
    const env = new Float32Array(nF), envLow = new Float32Array(nF);
    for (let f = 0; f < nF; f++) {
      const mag = fft(x, f * hop);
      let s = 0, sl = 0;
      for (let k = 1; k < maxBin; k++) {
        const v = Math.log1p(100 * mag[k]);
        const d = v - prev[k];
        if (d > 0) { s += d; if (k < lowBin) sl += d; }
        prev[k] = v;
      }
      env[f] = s; envLow[f] = sl;
      if ((f & 4095) === 4095) await sleep();
    }
    const w = Math.max(1, Math.round(fps * 0.25));
    return { env: detrend(env, w), envLow: detrend(envLow, w), fps, hop, N };
  }

  function tempo(env, fps) {
    const n = env.length;
    const lagMin = Math.floor(60 * fps / 180), lagMax = Math.ceil(60 * fps / 70);
    const maxL = Math.min(n - 2, lagMax * 8 + 2);
    const acf = new Float32Array(Math.max(1, maxL + 1));
    for (let l = 0; l <= maxL; l++) {
      let s = 0;
      for (let i = 0; i + l < n; i++) s += env[i] * env[i + l];
      acf[l] = s / (n - l);
    }
    const score = (T, K) => { let s = 0; for (let k = 1; k <= K; k++) s += interp(acf, k * T); return s / K; };
    let best = lagMin, bs = -Infinity;
    for (let T = lagMin; T <= lagMax; T += 0.5) {
      const bpm = 60 * fps / T;
      const w = Math.exp(-0.5 * (Math.log2(bpm / 122) / 0.7) ** 2);
      const s = score(T, 4) * w;
      if (s > bs) { bs = s; best = T; }
    }
    let fine = best, fs = -Infinity;
    for (let T = best - 1; T <= best + 1; T += 0.005) {
      const s = score(T, 8);
      if (s > fs) { fs = s; fine = T; }
    }
    let bpm = 60 * fps / fine;
    bpm = Math.abs(bpm - Math.round(bpm)) < 0.15 ? Math.round(bpm) : Math.round(bpm * 10) / 10;
    return bpm;
  }

  function beatPhase(env, T) {
    let best = 0, bs = -Infinity;
    for (let p = 0; p < T; p += 0.25) {
      let s = 0;
      for (let t = p; t < env.length - 1; t += T) s += interp(env, t);
      if (s > bs) { bs = s; best = p; }
    }
    return best;
  }

  async function chroma(x, sr) {
    const N = 8192, hop = 4096, fft = makeFFT(N), binHz = sr / N;
    const pcOf = new Int8Array(N / 2).fill(-1);
    for (let k = 1; k < N / 2; k++) {
      const f = k * binHz;
      if (f < 80 || f > 2000) continue;
      const m = 69 + 12 * Math.log2(f / 440);
      pcOf[k] = ((Math.round(m) % 12) + 12) % 12;
    }
    const c = new Float64Array(12);
    let i = 0;
    for (let o = 0; o + N <= x.length; o += hop, i++) {
      const mag = fft(x, o);
      for (let k = 1; k < N / 2; k++) { const p = pcOf[k]; if (p >= 0) c[p] += mag[k]; }
      if ((i & 63) === 63) await sleep();
    }
    return c;
  }

  const MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const MINOR_CAM = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];
  const MAJOR_CAM = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];

  function pearson(a, b) {
    const n = a.length; let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
    return num / Math.sqrt(da * db || 1);
  }

  function keyFromChroma(c) {
    const res = [];
    for (let t = 0; t < 12; t++) {
      const pM = [], pm = [];
      for (let i = 0; i < 12; i++) { pM[i] = MAJ[(i - t + 12) % 12]; pm[i] = MIN[(i - t + 12) % 12]; }
      res.push({ pc: t, mode: 'major', r: pearson(c, pM) });
      res.push({ pc: t, mode: 'minor', r: pearson(c, pm) });
    }
    res.sort((a, b) => b.r - a.r);
    const k = res[0];
    const n = k.mode === 'minor' ? MINOR_CAM[k.pc] : MAJOR_CAM[k.pc];
    return { pc: k.pc, mode: k.mode, n, letter: k.mode === 'minor' ? 'A' : 'B', code: n + (k.mode === 'minor' ? 'A' : 'B'), r: k.r, margin: k.r - res[1].r };
  }

  function bands(x, sr, rate) {
    const size = Math.max(1, Math.round(sr / rate));
    const n = Math.ceil(x.length / size);
    const peak = new Float32Array(n), lo = new Float32Array(n), mi = new Float32Array(n), hi = new Float32Array(n);
    const a1 = Math.exp(-2 * Math.PI * 250 / sr), a2 = Math.exp(-2 * Math.PI * 2500 / sr);
    let l1 = 0, l2 = 0, max = 1e-6;
    for (let b = 0; b < n; b++) {
      let p = 0, sl = 0, sm = 0, sh = 0;
      const start = b * size, end = Math.min(x.length, start + size);
      for (let i = start; i < end; i++) {
        const v = x[i];
        l1 = a1 * l1 + (1 - a1) * v; l2 = a2 * l2 + (1 - a2) * v;
        const M = l2 - l1, H = v - l2, av = v < 0 ? -v : v;
        if (av > p) p = av;
        sl += l1 * l1; sm += M * M; sh += H * H;
      }
      const cnt = Math.max(1, end - start);
      peak[b] = p; lo[b] = Math.sqrt(sl / cnt); mi[b] = Math.sqrt(sm / cnt); hi[b] = Math.sqrt(sh / cnt);
      if (p > max) max = p;
    }
    return { rate: sr / size, peak, lo, mi, hi, max };
  }

  function energy(w) {
    const per = Math.max(1, Math.round(w.rate * 0.5));
    const chunks = [];
    let hiSum = 0, totSum = 0;
    for (let i = 0; i < w.peak.length; i += per) {
      let e = 0, c = 0;
      for (let j = i; j < Math.min(w.peak.length, i + per); j++) {
        const L = w.lo[j] ** 2, M = w.mi[j] ** 2, H = w.hi[j] ** 2;
        e += L + M + H; hiSum += H; totSum += L + M + H; c++;
      }
      chunks.push(e / Math.max(1, c));
    }
    chunks.sort((a, b) => a - b);
    const e70 = chunks[Math.floor(chunks.length * 0.7)] || 0;
    const db = 10 * Math.log10(e70 + 1e-12);
    const clamp = (v) => Math.min(1, Math.max(0, v));
    const loud = clamp((db + 28) / 18);
    const bright = clamp((Math.sqrt(hiSum / (totSum || 1)) - 0.08) / 0.35);
    return Math.min(10, Math.max(1, Math.round(1 + 9 * (0.7 * loud + 0.3 * bright))));
  }

  async function analyze(x, sr, progress) {
    progress && progress('Tempo');
    await sleep();
    const o = await onsetEnvelope(x, sr);
    const bpm = tempo(o.env, o.fps);
    const beatSec = 60 / bpm;
    const T = o.fps * beatSec;
    const lowStrength = o.envLow.reduce((a, b) => a + b, 0);
    const p = beatPhase(lowStrength > 1e-3 ? o.envLow : o.env, T);
    let firstBeat = (p * o.hop + o.N * 0.75) / sr;
    firstBeat = ((firstBeat % beatSec) + beatSec) % beatSec;
    progress && progress('Key');
    await sleep();
    const c = await chroma(x, sr);
    const key = keyFromChroma(c);
    progress && progress('Waveform');
    await sleep();
    const wave = bands(x, sr, 150);
    return { bpm, firstBeat, key, energy: energy(wave), wave };
  }

  return { analyze, bands, keyFromChroma, MINOR_CAM, MAJOR_CAM };
})();
if (typeof module !== 'undefined') module.exports = AN;
