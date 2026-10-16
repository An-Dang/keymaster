/* Key Master app: two decks, mixer, library, mashup/mix ideas, set builder, loudness. Talks to keymaster/server.py. */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const dbToGain = (db) => Math.pow(10, db / 20);
const PAD_COLORS = ['#ff5d73', '#ff9f43', '#ffd84d', '#5ee38c', '#3fd1c4', '#5aa2ff', '#a77bff', '#ff74c8'];
const CUE_LETTERS = 'ABCDEFGH';

function fmtTime(s, tenths = true) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), r = s - m * 60;
  return m + ':' + (tenths ? r.toFixed(1).padStart(4, '0') : String(Math.floor(r)).padStart(2, '0'));
}
function fmtDb(db) { return (db > 0 ? '+' : db < 0 ? '−' : '±') + Math.abs(db).toFixed(1) + ' dB'; }

async function api(path, opts = {}) {
  const init = { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: {} };
  if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(path, init);
  if (!r.ok) {
    let msg = r.statusText;
    try { const j = await r.json(); msg = j.detail || msg; } catch (e) {}
    const err = new Error(msg); err.status = r.status; throw err;
  }
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r;
}

/* ---------- toast + dialog ---------- */
let toastTimer;
function toast(msg, opts = {}) {
  const t = $('#toast');
  t.innerHTML = msg; t.hidden = false; t.classList.toggle('err', !!opts.error);
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, opts.ms || 3200);
}
function dialog({ title, html, actions }) {
  return new Promise((resolve) => {
    $('#dlgTitle').textContent = title;
    $('#dlgBody').innerHTML = html || '';
    const box = $('#dlgActions'); box.innerHTML = '';
    const close = (v) => { $('#dlgBack').hidden = true; document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') close(null); };
    document.addEventListener('keydown', onKey);
    (actions || [{ label: 'OK', value: true, primary: true }]).forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn' + (a.primary ? ' primary' : ''); b.textContent = a.label;
      b.addEventListener('click', () => close(typeof a.value === 'function' ? a.value() : a.value));
      box.appendChild(b);
    });
    $('#dlgBack').hidden = false;
    const first = $('#dlgBody input, #dlgBody select') || box.lastChild;
    first && first.focus();
  });
}
const confirmDlg = (title, html, ok = 'Continue') => dialog({ title, html, actions: [{ label: 'Cancel', value: false }, { label: ok, value: true, primary: true }] });
async function promptDlg(title, label, value = '') {
  return dialog({
    title, html: `<p>${esc(label)}</p><input type="text" id="dlgIn" value="${esc(value)}">`,
    actions: [{ label: 'Cancel', value: null }, { label: 'OK', primary: true, value: () => $('#dlgIn').value.trim() }],
  });
}

/* ---------- keys ---------- */
function camParts(code) {
  const m = /^(\d{1,2})([AB])$/i.exec(code || '');
  return m ? [parseInt(m[1], 10), m[2].toUpperCase()] : null;
}
function shiftKey(code, semis) {
  const p = camParts(code); if (!p) return code;
  return (((p[0] - 1 + 7 * semis) % 12 + 12) % 12 + 1) + p[1];
}
function keyColor(code) {
  const p = camParts(code); if (!p) return 'var(--line)';
  const hue = ((p[0] - 1) * 30 + 140) % 360;
  return p[1] === 'A' ? `hsl(${hue} 62% 62%)` : `hsl(${hue} 70% 74%)`;
}
const CLASSIC = { '1A': 'Abm', '2A': 'Ebm', '3A': 'Bbm', '4A': 'Fm', '5A': 'Cm', '6A': 'Gm', '7A': 'Dm', '8A': 'Am', '9A': 'Em', '10A': 'Bm', '11A': 'F#m', '12A': 'Dbm',
  '1B': 'B', '2B': 'F#', '3B': 'Db', '4B': 'Ab', '5B': 'Eb', '6B': 'Bb', '7B': 'F', '8B': 'C', '9B': 'G', '10B': 'D', '11B': 'A', '12B': 'E' };
function relation(a, b) {
  const pa = camParts(a), pb = camParts(b); if (!pa || !pb) return null;
  const d = ((pb[0] - pa[0]) % 12 + 12) % 12;
  if (pa[1] === pb[1]) {
    if (d === 0) return ['Same key', 'good'];
    if (d === 1 || d === 11) return ['±1 Camelot', 'good'];
    if (d === 2) return ['Energy Boost', 'good'];
    if (d === 7) return ['+1 semitone', 'ok'];
  } else if (d === 0) return ['Relative key', 'good'];
  return ['Clash', 'bad'];
}

/* ---------- state ---------- */
const S = {
  tracks: new Map(), playlists: [], settings: {}, presets: {}, stems: false, mashups: [],
  sel: new Set(), plFilter: 'all', search: '', sort: { key: 'title', dir: 1 }, focus: 'A',
  since: 0, setOrder: null, procJobs: new Map(),
};
const targetLufs = () => (S.presets[S.settings.preset] || { lufs: -9 }).lufs;
const trackGain = (t) => (t && t.lufs != null ? clamp(targetLufs() - t.lufs, -24, 12) : null);

/* ---------- audio graph ---------- */
const AU = { ctx: null, limiter: null, xf: 0 };
function ensureCtx() {
  if (AU.ctx) { if (AU.ctx.state === 'suspended') AU.ctx.resume(); return AU.ctx; }
  const ctx = AU.ctx = new (window.AudioContext || window.webkitAudioContext)();
  const lim = AU.limiter = ctx.createDynamicsCompressor();
  lim.threshold.value = -1; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.12;
  lim.connect(ctx.destination);
  Object.values(DECKS).forEach((d) => d.connect(ctx));
  return ctx;
}
function xfGains() {
  const x = (AU.xf + 1) / 2;
  return { A: Math.cos(x * Math.PI / 2), B: Math.sin(x * Math.PI / 2) };
}

/* ---------- deck ---------- */
class Deck {
  constructor(id) {
    this.id = id;
    this.root = $('#deck' + id);
    this.root.appendChild($('#deckTpl').content.cloneNode(true));
    this.other = null;
    this.t = null;
    this.audio = new Audio(); this.audio.preload = 'auto'; this.audio.preservesPitch = true;
    this.stem = 'mix'; this.shift = 0; this.pending = null;
    this.pct = 0; this.range = 8; this.keylock = true; this.sync = false;
    this.loop = null; this.cuePoint = 0; this.zoomSec = 8; this.grid = false; this.metro = false;
    this.wave = null; this.waveRate = 150; this.ovCache = null; this.lastBeat = null; this.taps = [];
    this.fader = 1; this.dirty = true; this.syncTick = 0;
    this.q = (s) => $(s, this.root);
    $('.d-letter', this.root).textContent = id;
    $('.ld', this.root).textContent = id;
    this.buildPads();
    this.bind();
    this.audio.addEventListener('ended', () => this.renderTransport());
    this.audio.addEventListener('pause', () => this.renderTransport());
    this.audio.addEventListener('play', () => this.renderTransport());
    this.audio.addEventListener('loadedmetadata', () => { this.dirty = true; this.renderTransport(); });
    this.render();
  }

  connect(ctx) {
    this.srcNode = ctx.createMediaElementSource(this.audio);
    this.trim = ctx.createGain();
    this.gain = ctx.createGain();
    this.an = ctx.createAnalyser(); this.an.fftSize = 1024; this.buf = new Float32Array(1024);
    this.srcNode.connect(this.trim).connect(this.gain).connect(this.an).connect(AU.limiter);
    this.applyGain();
  }

  get rate() { return 1 + this.pct / 100; }
  get bpm() { return this.t && this.t.bpm ? this.t.bpm * this.rate : null; }
  get per() { return this.t && this.t.bpm ? 60 / this.t.bpm : null; }
  get fb() { return (this.t && this.t.first_beat) || 0; }
  get time() { return this.audio.currentTime || 0; }
  get dur() { return (isFinite(this.audio.duration) && this.audio.duration) || (this.t && this.t.duration) || 0; }
  get playing() { return !this.audio.paused && !this.audio.ended; }
  get key() { return this.t && this.t.key ? shiftKey(this.t.key, this.shift) : null; }

  /* ----- loading ----- */
  async load(t, opts = {}) {
    if (!t) return;
    this.audio.pause();
    this.t = t; this.stem = 'mix'; this.shift = 0; this.pending = null; this.loop = null;
    this.cuePoint = (t.cues && t.cues[0] && t.cues[0].t) || 0;
    this.pct = 0; this.sync = false; this.wave = null; this.ovCache = null;
    this.audio.src = `/api/audio/${t.id}?stem=mix&shift=0`;
    this.audio.currentTime = 0;
    S.focus = this.id;
    api(`/api/tracks/${t.id}/priority`, { body: {} }).catch(() => {});
    this.loadWave();
    this.render();
    this.applyGain();
    renderLibraryMarks();
    refreshSuggestions();
    if (opts.shift || (opts.stem && opts.stem !== 'mix')) await this.setVariant(opts.stem || 'mix', opts.shift || 0);
    if (opts.sync) this.setSync(true);
  }

  async loadWave() {
    if (!this.t) return;
    const id = this.t.id;
    try {
      const r = await fetch(`/api/wave/${id}`);
      if (!r.ok) { this.wave = null; this.render(); return; }
      if (!this.t || this.t.id !== id) return;
      this.waveRate = parseInt(r.headers.get('X-Wave-Rate') || '150', 10);
      this.wave = new Uint8Array(await r.arrayBuffer());
      this.ovCache = null; this.dirty = true; this.render();
    } catch (e) { /* retried when the analysis finishes */ }
  }

  trackUpdated(t) {
    const hadWave = !!this.wave;
    this.t = t;
    if (!hadWave && t.status === 'ready') this.loadWave();
    this.applyGain(); this.render();
  }

  async setVariant(stem, shift) {
    if (!this.t) return;
    shift = clamp(shift, -6, 6);
    if (stem !== 'mix' && !S.stems) { toast('Stem separation is not installed.', { error: true }); return; }
    this.pending = { stem, shift };
    this.renderVariant();
    let r;
    try { r = await api(`/api/tracks/${this.t.id}/render`, { body: { stem, shift } }); }
    catch (e) { this.pending = null; this.renderVariant(); toast(e.message, { error: true }); return; }
    if (r.ready) this.swapSource(stem, shift);
    // otherwise the poller retries until the render job is done
  }

  async pollPending() {
    if (!this.pending || !this.t) return;
    const { stem, shift } = this.pending;
    try {
      const r = await api(`/api/tracks/${this.t.id}/render`, { body: { stem, shift } });
      if (r.ready && this.pending && this.pending.stem === stem && this.pending.shift === shift) this.swapSource(stem, shift);
    } catch (e) { this.pending = null; this.renderVariant(); toast(e.message, { error: true }); }
  }

  swapSource(stem, shift) {
    const t = this.time, wasPlaying = this.playing;
    this.stem = stem; this.shift = shift; this.pending = null;
    this.audio.src = `/api/audio/${this.t.id}?stem=${stem}&shift=${shift}`;
    this.audio.playbackRate = this.rate; this.audio.preservesPitch = this.keylock;
    const resume = () => {
      this.audio.currentTime = t;
      this.audio.playbackRate = this.rate;
      if (wasPlaying) this.audio.play().catch(() => {});
      this.audio.removeEventListener('loadedmetadata', resume);
    };
    this.audio.addEventListener('loadedmetadata', resume);
    this.render();
    refreshSuggestions();
  }

  /* ----- transport ----- */
  toggle() {
    if (!this.t) return;
    ensureCtx();
    if (this.playing) this.audio.pause(); else this.audio.play().catch((e) => toast('Cannot play: ' + e.message, { error: true }));
    S.focus = this.id;
  }
  seek(t) { this.audio.currentTime = clamp(t, 0, Math.max(0, this.dur - 0.05)); this.dirty = true; }
  quantize(t) {
    if (!this.per || !S.settings.quantize) return t;
    const k = Math.round((t - this.fb) / this.per);
    return Math.max(0, this.fb + k * this.per);
  }
  cue() {
    if (!this.t) return;
    if (this.playing) { this.audio.pause(); this.seek(this.cuePoint); }
    else { this.cuePoint = this.quantize(this.time); this.seek(this.cuePoint); toast(`Cue set at ${fmtTime(this.cuePoint)}`); }
  }
  setTempo(pct) {
    this.pct = clamp(pct, -this.range, this.range);
    this.audio.playbackRate = this.rate;
    this.renderTempo();
    if (this.other && this.other.sync && this.other.t) this.other.followTempo();
  }
  followTempo() {
    if (!this.other || !this.other.bpm || !this.t || !this.t.bpm) return;
    let best = null;
    for (const r of [1, 2, 0.5]) {
      const pct = (this.other.bpm / (this.t.bpm * r) - 1) * 100;
      if (best === null || Math.abs(pct) < Math.abs(best)) best = pct;
    }
    if (Math.abs(best) > this.range) this.range = Math.abs(best) <= 16 ? 16 : 50;
    this.pct = best; this.audio.playbackRate = this.rate;
    this.renderTempo();
  }
  setSync(on) {
    this.sync = on;
    if (on) {
      if (!this.other || !this.other.t || !this.other.bpm || !this.t || !this.t.bpm) { this.sync = false; toast('SYNC needs a track with BPM on both decks.'); }
      else { this.followTempo(); this.alignPhase(true); }
    }
    this.renderTransport();
  }
  // Phase difference to the other deck in beats (bar-aware when `bar` is true), range -0.5..0.5 of the unit.
  phaseError(bar) {
    const o = this.other;
    const unit = bar ? 4 : 1;
    const po = (((o.time - o.fb) / o.per) % unit + unit) % unit;
    const pm = (((this.time - this.fb) / this.per) % unit + unit) % unit;
    let d = pm - po;
    if (d > unit / 2) d -= unit; if (d < -unit / 2) d += unit;
    return d;
  }
  alignPhase(bar) {
    const o = this.other;
    if (!o || !o.t || !o.per || !this.per) return;
    const d = this.phaseError(bar);
    this.seek(this.time - d * this.per);
  }
  syncCorrect() {
    // Keeps both decks locked while playing: small tempo bends instead of audible jumps.
    const o = this.other;
    if (!this.sync || !this.playing || !o || !o.playing || !o.per || !this.per) { this.audio.playbackRate = this.rate; return; }
    const errSec = this.phaseError(false) * this.per;
    if (Math.abs(errSec) > 0.12) { this.seek(this.time - errSec); return; }
    const bend = clamp(-errSec * 0.6, -0.03, 0.03);
    this.audio.playbackRate = this.rate * (1 + bend);
  }
  setLoop(beats) {
    if (!this.per) { toast('Loops need a track with a beatgrid.'); return; }
    if (this.loop && this.loop.beats === beats) { this.loop = null; this.renderLoop(); return; }
    const start = this.loop ? this.loop.a : (S.settings.quantize ? this.fb + Math.floor((this.time - this.fb) / this.per + 0.02) * this.per : this.time);
    this.loop = { a: Math.max(0, start), b: Math.max(0, start) + beats * this.per, beats };
    if (this.time > this.loop.b || this.time < this.loop.a) this.seek(this.loop.a);
    this.renderLoop();
  }

  // Seconds from the nearest beat (negative = just before it); 0 when quantize is off.
  beatOffset() {
    if (!this.per || !S.settings.quantize) return 0;
    return this.time - this.quantize(this.time);
  }
  jump(beats) {
    if (!this.per) { toast('Beat jump needs a track with a beatgrid.'); return; }
    const d = beats * this.per;
    if (this.time + d < 0 || this.time + d > this.dur) return; // clamping would break the beat phase
    if (this.loop) { this.loop.a += d; this.loop.b += d; this.renderLoop(); }
    this.seek(this.time + d);
  }

  // Paused navigation like the original browser tool: land exactly on the next/previous grid line.
  stepGrid(beats) {
    if (!this.per) { toast('Stepping needs a track with a beatgrid.'); return; }
    const k = (this.time - this.fb) / this.per;
    const line = beats > 0 ? Math.floor(k + 1e-4) : Math.ceil(k - 1e-4);
    const t = this.fb + (line + beats) * this.per;
    if (t >= 0 && t <= this.dur) this.seek(t);
  }

  /* ----- hot cues ----- */
  padClick(i, e) {
    if (!this.t) return;
    const cues = this.t.cues || (this.t.cues = Array(8).fill(null));
    if (cues[i] && (e.shiftKey || e.type === 'contextmenu')) {
      cues[i] = null; this.saveTrack({ cues }); toast(`Hot cue ${CUE_LETTERS[i]} deleted`);
    } else if (cues[i]) {
      // Quantized jump while playing: land at the same offset to the beat as now, so the deck stays in phase.
      this.seek(cues[i].t + (this.playing ? this.beatOffset() : 0));
      if (!this.playing) { ensureCtx(); this.audio.play().catch(() => {}); }
    } else {
      const t = e.altKey ? this.time : this.quantize(this.time);
      cues[i] = { t: Math.round(t * 1000) / 1000, name: '' };
      this.saveTrack({ cues });
    }
    this.renderPads(); this.dirty = true;
  }
  async padRename(i) {
    const c = this.t && this.t.cues && this.t.cues[i];
    if (!c) return;
    const name = await promptDlg(`Name hot cue ${CUE_LETTERS[i]}`, 'Name (e.g. Drop, Vocal, Break):', c.name || '');
    if (name === null) return;
    c.name = name; this.saveTrack({ cues: this.t.cues }); this.renderPads(); this.dirty = true;
  }

  /* ----- beat grid ----- */
  normFb(fb, per) { const bar = 4 * per; return ((fb % bar) + bar) % bar; }
  setGrid(bpm, fb, save = true) {
    bpm = Math.round(clamp(bpm, 40, 250) * 100) / 100;
    this.t.bpm = bpm; this.t.first_beat = Math.round(this.normFb(fb, 60 / bpm) * 10000) / 10000;
    this.dirty = true; this.render();
    if (this.other && this.other.sync) this.other.followTempo();
    if (this.sync) this.followTempo();
    if (save) this.saveGridSoon();
  }
  anchorBeat() { return Math.round((this.time - this.fb) / this.per); }
  gridShift(sec) { if (this.per) this.setGrid(this.t.bpm, this.fb + sec); }
  gridDownbeat() { if (this.per) this.setGrid(this.t.bpm, this.time); }
  gridBpm(newBpm) {
    if (!this.per) return;
    const k = this.anchorBeat(), anchor = this.fb + k * this.per;
    this.setGrid(newBpm, anchor - k * (60 / newBpm));
  }
  gridTap() {
    const now = performance.now();
    const tapT = this.time;
    if (this.taps.length && now - this.taps[this.taps.length - 1].now > 2000) this.taps = [];
    this.taps.push({ now, t: tapT });
    const btn = this.q('.g-tap'); btn.classList.add('flash'); setTimeout(() => btn.classList.remove('flash'), 90);
    if (this.taps.length < 4) { btn.textContent = `TAP ${this.taps.length}`; return; }
    const iv = (this.taps[this.taps.length - 1].now - this.taps[0].now) / (this.taps.length - 1);
    const bpm = 60000 / iv / (this.playing ? this.rate : 1);
    btn.textContent = `${bpm.toFixed(2)}`;
    const per = 60 / bpm;
    const k = this.per ? Math.round((tapT - this.fb) / this.per) : 0;
    this.setGrid(bpm, tapT - k * per);
  }
  saveGridSoon() {
    clearTimeout(this.gridTimer);
    const t = this.t;
    t._pend = Object.assign(t._pend || {}, { bpm: t.bpm, first_beat: t.first_beat });
    this.gridTimer = setTimeout(() => this.saveTrack({ bpm: t.bpm, first_beat: t.first_beat }, t), 400);
  }
  // Local edits win: fields stay in t._pend until the server confirmed them, so a poll that
  // returns an older row cannot overwrite them.
  async saveTrack(fields, t = this.t) {
    t._pend = Object.assign(t._pend || {}, fields);
    try {
      const nt = await api(`/api/tracks/${t.id}`, { method: 'PATCH', body: fields });
      for (const k of Object.keys(fields)) {
        if (t._pend && JSON.stringify(t._pend[k]) === JSON.stringify(fields[k])) delete t._pend[k];
      }
      t.updated_at = nt.updated_at;
      scheduleLibraryRender();
    } catch (e) { toast('Saving failed: ' + e.message, { error: true }); }
  }
  metronomeTick() {
    if (!this.metro || !this.playing || !this.per || !AU.ctx) { this.lastBeat = null; return; }
    const k = Math.floor((this.time - this.fb) / this.per + 0.001);
    if (this.lastBeat !== null && k !== this.lastBeat) {
      const ctx = AU.ctx, o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = ((k % 4) + 4) % 4 === 0 ? 1760 : 1175;
      g.gain.setValueAtTime(0.35, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);
      o.connect(g).connect(AU.limiter); o.start(); o.stop(ctx.currentTime + 0.06);
    }
    this.lastBeat = k;
  }

  /* ----- gain ----- */
  applyGain() {
    const ag = S.settings.autogain ? trackGain(this.t) : null;
    if (this.trim) {
      this.trim.gain.value = ag == null ? 1 : dbToGain(ag);
      this.gain.gain.value = this.fader * xfGains()[this.id];
    }
    const out = $(`.ch[data-ch="${this.id}"] .gain-out`);
    if (out) out.textContent = ag == null ? '±0.0 dB' : fmtDb(ag);
    this.renderLoud();
  }

  /* ----- UI ----- */
  buildPads() {
    const box = this.q('.pads');
    for (let i = 0; i < 8; i++) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'pad'; b.style.setProperty('--pc', PAD_COLORS[i]);
      b.innerHTML = `<span class="n">${CUE_LETTERS[i]}</span><span class="nm"></span>`;
      b.addEventListener('click', (e) => this.padClick(i, e));
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); this.padClick(i, e); });
      b.addEventListener('dblclick', () => this.padRename(i));
      b.setAttribute('aria-label', `Hot cue ${CUE_LETTERS[i]}`);
      b.title = 'Empty: set cue · Set: play · Shift/right-click: delete · Double-click: rename';
      box.appendChild(b);
    }
  }

  bind() {
    const q = this.q;
    this.root.addEventListener('pointerdown', () => { S.focus = this.id; });
    q('.play').addEventListener('click', () => this.toggle());
    q('.cue-btn').addEventListener('click', () => this.cue());
    q('.k-down').addEventListener('click', () => this.setVariant(this.pending ? this.pending.stem : this.stem, (this.pending ? this.pending.shift : this.shift) - 1));
    q('.k-up').addEventListener('click', () => this.setVariant(this.pending ? this.pending.stem : this.stem, (this.pending ? this.pending.shift : this.shift) + 1));
    q('.tempo').addEventListener('input', (e) => { this.sync = false; this.setTempo(parseFloat(e.target.value)); this.renderTransport(); });
    q('.tempo').addEventListener('dblclick', () => this.setTempo(0));
    q('.tempo-reset').addEventListener('click', () => { this.sync = false; this.setTempo(0); this.renderTransport(); });
    q('.tempo-range').addEventListener('change', (e) => { this.range = parseInt(e.target.value, 10); this.setTempo(this.pct); });
    q('.sync').addEventListener('click', () => this.setSync(!this.sync));
    q('.keylock').addEventListener('click', () => { this.keylock = !this.keylock; this.audio.preservesPitch = this.keylock; this.renderTransport(); });
    q('.grid-tog').addEventListener('click', () => this.toggleGrid());
    $$('.loops button', this.root).forEach((b) => b.addEventListener('click', () => this.setLoop(parseInt(b.dataset.beats, 10))));
    q('.loop-off').addEventListener('click', () => { this.loop = null; this.renderLoop(); });
    $$('.jumps button', this.root).forEach((b) => b.addEventListener('click', () => this.jump(parseInt(b.dataset.jump, 10))));
    $$('.stems button', this.root).forEach((b) => b.addEventListener('click', () => this.setVariant(b.dataset.stem, this.pending ? this.pending.shift : this.shift)));
    q('.stem-exp').addEventListener('click', () => this.exportStem());
    q('.z-in').addEventListener('click', () => { this.zoomSec = clamp(this.zoomSec / 1.5, 1, 64); this.dirty = true; });
    q('.z-out').addEventListener('click', () => { this.zoomSec = clamp(this.zoomSec * 1.5, 1, 64); this.dirty = true; });
    // grid bar
    q('.g-left').addEventListener('click', (e) => this.gridShift(e.shiftKey ? -0.001 : -0.005));
    q('.g-right').addEventListener('click', (e) => this.gridShift(e.shiftKey ? 0.001 : 0.005));
    q('.g-down').addEventListener('click', () => this.gridDownbeat());
    q('.g-bm').addEventListener('click', (e) => this.t && this.gridBpm(this.t.bpm - (e.shiftKey ? 0.1 : 0.01)));
    q('.g-bp').addEventListener('click', (e) => this.t && this.gridBpm(this.t.bpm + (e.shiftKey ? 0.1 : 0.01)));
    q('.g-bpm-in').addEventListener('change', (e) => { const v = parseFloat(e.target.value); if (v > 0) this.gridBpm(v); });
    q('.g-half').addEventListener('click', () => this.t && this.t.bpm && this.setGrid(this.t.bpm / 2, this.fb));
    q('.g-dbl').addEventListener('click', () => this.t && this.t.bpm && this.setGrid(this.t.bpm * 2, this.fb));
    q('.g-tap').addEventListener('click', () => this.t && this.gridTap());
    q('.g-metro').addEventListener('click', () => { this.metro = !this.metro; ensureCtx(); q('.g-metro').setAttribute('aria-pressed', String(this.metro)); });
    q('.g-reset').addEventListener('click', async () => {
      if (!this.t || !this.t.bpm_detected) { toast('No detected grid available yet.'); return; }
      if (await confirmDlg('Reset grid?', `<p>Resets BPM and bar start to Key Master's analysis (${this.t.bpm_detected.toFixed(2)} BPM).</p>`, 'Reset')) {
        this.setGrid(this.t.bpm_detected, this.t.first_beat_detected || 0);
      }
    });
    // waveform: drag scrubs, or moves the grid in grid mode; wheel zooms
    const zw = q('.zoom-wrap');
    let drag = null;
    zw.addEventListener('pointerdown', (e) => {
      if (!this.t || e.target.closest('.zoom-ctl')) return;
      zw.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, t: this.time, fb: this.fb, playing: this.playing, moved: false };
      if (!this.grid && drag.playing) this.audio.pause();
    });
    zw.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const spp = this.zoomSec / zw.clientWidth, dx = e.clientX - drag.x;
      if (Math.abs(dx) > 2) drag.moved = true;
      if (this.grid) this.setGrid(this.t.bpm, drag.fb + dx * spp, false);
      else this.seek(drag.t - dx * spp);
    });
    const end = () => {
      if (!drag) return;
      if (this.grid && drag.moved) this.saveGridSoon();
      if (!this.grid && drag.playing) this.audio.play().catch(() => {});
      drag = null;
    };
    zw.addEventListener('pointerup', end); zw.addEventListener('pointercancel', end);
    zw.addEventListener('wheel', (e) => {
      if (!this.t) return;
      e.preventDefault();
      if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) this.zoomSec = clamp(this.zoomSec * (e.deltaY > 0 ? 1.15 : 1 / 1.15), 1, 64);
      else this.seek(this.time + e.deltaX * this.zoomSec / zw.clientWidth);
      this.dirty = true;
    }, { passive: false });
    q('.ov-wrap').addEventListener('pointerdown', (e) => {
      if (!this.dur) return;
      const r = e.currentTarget.getBoundingClientRect();
      this.seek((e.clientX - r.left) / r.width * this.dur);
    });
    // drop target
    this.root.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/km-track') || e.dataTransfer.types.includes('text/km-path')) { e.preventDefault(); this.root.classList.add('drop'); } });
    this.root.addEventListener('dragleave', () => this.root.classList.remove('drop'));
    this.root.addEventListener('drop', (e) => {
      e.preventDefault(); this.root.classList.remove('drop');
      const path = e.dataTransfer.getData('text/km-path');
      if (path) { loadPath(path, this.id); return; }
      const id = parseInt(e.dataTransfer.getData('text/km-track'), 10);
      if (S.tracks.has(id)) this.load(S.tracks.get(id));
    });
  }

  toggleGrid(force) {
    this.grid = force !== undefined ? force : !this.grid;
    this.q('.grid-bar').hidden = !this.grid;
    this.q('.zoom-wrap').classList.toggle('grid-mode', this.grid);
    this.q('.grid-tog').setAttribute('aria-pressed', String(this.grid));
    if (this.grid && this.t) this.q('.g-bpm-in').value = (this.t.bpm || 0).toFixed(2);
    if (!this.grid) { this.metro = false; this.q('.g-metro').setAttribute('aria-pressed', 'false'); }
  }

  async exportStem() {
    if (!this.t) return;
    try {
      const r = await api('/api/stems/export', { body: { track_id: this.t.id, stem: this.stem, shift: this.shift } });
      toast(`Exported: ${esc(r.path.split('/').pop())} <button class="mini-btn" onclick="revealPath('${esc(r.path).replace(/'/g, "\\'")}')">Show in Finder</button>`, { ms: 6000 });
    } catch (e) { toast(e.message, { error: true }); }
  }

  render() {
    const t = this.t, q = this.q;
    q('.track-name').textContent = t ? (t.title || '–') : 'Empty';
    q('.track-meta').innerHTML = t ? esc([t.artist, t.genre].filter(Boolean).join(' · ') || t.path.split('/').pop())
      : `Drag a track here from the library or click <b>${this.id}</b>`;
    const ready = !!(t && t.status === 'ready');
    q('.wave-msg').textContent = !t ? 'No track loaded' : (this.wave ? '' : (t.status === 'missing' ? 'File not found' : (t.status === 'error' ? 'Analysis failed' : 'Analyzing …')));
    q('.wave-msg').hidden = !!this.wave;
    ['.play', '.cue-btn'].forEach((s) => { q(s).disabled = !t; });
    $$('.pad', this.root).forEach((p) => { p.disabled = !t; });
    q('.k-down').disabled = q('.k-up').disabled = !(t && t.key);
    $$('.stems button', this.root).forEach((b) => { b.disabled = !t || (b.dataset.stem !== 'mix' && !S.stems); if (!S.stems && b.dataset.stem !== 'mix') b.title = 'Stem separation not installed (pip install demucs)'; });
    if (this.grid && t) q('.g-bpm-in').value = (t.bpm || 0).toFixed(2);
    this.renderKey(); this.renderTempo(); this.renderTransport(); this.renderPads(); this.renderLoop(); this.renderVariant(); this.renderLoud();
    this.dirty = true;
    void ready;
  }
  renderKey() {
    const t = this.t, chip = this.q('.key-chip');
    const shown = this.pending ? (t && t.key ? shiftKey(t.key, this.pending.shift) : null) : this.key;
    chip.textContent = shown || '–';
    chip.style.setProperty('--kc', keyColor(shown));
    const sh = this.pending ? this.pending.shift : this.shift;
    this.q('.k-sub').textContent = t && t.key ? (sh ? `${sh > 0 ? '+' : ''}${sh} st · orig. ${t.key}` : (CLASSIC[t.key] || '')) : '\u00a0';
  }
  renderTempo() {
    const q = this.q;
    const tempo = q('.tempo');
    tempo.min = -this.range; tempo.max = this.range; tempo.value = this.pct;
    q('.tempo-range').value = String(this.range);
    q('.tempo-out').textContent = (this.pct > 0 ? '+' : this.pct < 0 ? '−' : '±') + Math.abs(this.pct).toFixed(2) + ' %';
    q('.bpm').textContent = this.bpm ? this.bpm.toFixed(2) : '–';
    q('.bpm-sub').textContent = this.t && this.t.bpm ? (this.pct ? `orig. ${this.t.bpm.toFixed(2)}` : (this.t.bpm_detected && Math.abs(this.t.bpm_detected - this.t.bpm) > 0.005 ? 'Grid edited' : '\u00a0')) : '\u00a0';
  }
  renderTransport() {
    const q = this.q;
    q('.play').classList.toggle('on', this.playing);
    q('.play').setAttribute('aria-label', this.playing ? 'Pause' : 'Play');
    q('.sync').setAttribute('aria-pressed', String(this.sync));
    q('.keylock').setAttribute('aria-pressed', String(this.keylock));
  }
  renderPads() {
    const cues = (this.t && this.t.cues) || [];
    $$('.pad', this.root).forEach((p, i) => {
      const c = cues[i];
      p.classList.toggle('set', !!c);
      $('.nm', p).textContent = c ? (c.name || fmtTime(c.t)) : '';
    });
  }
  renderLoop() {
    $$('.loops button', this.root).forEach((b) => b.setAttribute('aria-pressed', String(!!this.loop && this.loop.beats === parseInt(b.dataset.beats, 10))));
    this.q('.loop-off').disabled = !this.loop;
    this.dirty = true;
  }
  renderVariant() {
    const target = this.pending || { stem: this.stem, shift: this.shift };
    $$('.stems button', this.root).forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.stem === target.stem));
      b.classList.toggle('busy', !!this.pending && b.dataset.stem === this.pending.stem);
    });
    this.q('.stem-exp').disabled = !this.t || !!this.pending || (this.stem === 'mix' && this.shift === 0);
    this.renderKey();
    const msg = this.q('.wave-msg');
    if (this.pending && this.wave) {
      msg.hidden = false;
      msg.textContent = this.pending.stem !== 'mix' ? 'Separating stems … (about 1 minute the first time)' : 'Shifting key …';
    } else if (this.wave) msg.hidden = true;
  }
  renderLoud() {
    const t = this.t, q = this.q;
    q('.lufs').textContent = t && t.lufs != null ? t.lufs.toFixed(1) : '–';
    const b = q('.ag-badge'), g = trackGain(t);
    b.hidden = !(S.settings.autogain && g != null);
    if (!b.hidden) { b.textContent = fmtDb(g); b.classList.toggle('cut', g < 0); }
  }

  /* ----- drawing ----- */
  frame() {
    const t = this.time;
    if (this.loop && this.playing && t >= this.loop.b) this.seek(this.loop.a + (t - this.loop.b));
    if (this.audio.ended && this.loop) { this.seek(this.loop.a); this.audio.play().catch(() => {}); }
    this.metronomeTick();
    if (++this.syncTick % 10 === 0) this.syncCorrect();
    this.q('.t-now').textContent = fmtTime(t);
    this.q('.t-rem').textContent = '−' + fmtTime(Math.max(0, this.dur - t));
    if (this.an) {
      this.an.getFloatTimeDomainData(this.buf);
      let pk = 0; for (let i = 0; i < this.buf.length; i += 4) { const v = Math.abs(this.buf[i]); if (v > pk) pk = v; }
      const lvl = clamp(1 + 20 * Math.log10(pk + 1e-6) / 48, 0, 1);
      const bar = $(`.ch[data-ch="${this.id}"] .vu i`);
      bar.style.height = (lvl * 100) + '%'; bar.parentElement.style.setProperty('--lvl', (lvl * 100) + '%');
    }
    if (this.playing || this.dirty) { this.drawZoom(); this.drawOverview(); this.dirty = false; }
  }

  fitCanvas(cv) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; return true; }
    return false;
  }

  drawZoom() {
    const cv = this.q('.zoom-cv'), g = cv.getContext('2d');
    this.fitCanvas(cv);
    const W = cv.width, H = cv.height, mid = H / 2, dpr = window.devicePixelRatio || 1;
    g.clearRect(0, 0, W, H);
    if (!this.t) return;
    const now = this.time, spp = this.zoomSec / W, t0 = now - W / 2 * spp;
    // loop region
    if (this.loop) {
      const xa = (this.loop.a - t0) / spp, xb = (this.loop.b - t0) / spp;
      g.fillStyle = 'rgba(255,181,71,0.14)'; g.fillRect(xa, 0, xb - xa, H);
    }
    // waveform: low (blue), mid (amber), high (white) mirrored around the centre
    if (this.wave) {
      const w = this.wave, n = w.length / 3, wr = this.waveRate;
      const bands = [[0, 'rgba(61,123,255,0.95)', 1], [1, 'rgba(255,181,71,0.9)', 0.78], [2, 'rgba(243,245,250,0.85)', 0.5]];
      for (const [b, col, sc] of bands) {
        g.fillStyle = col;
        for (let x = 0; x < W; x += dpr) {
          const ta = t0 + x * spp, ia = Math.floor(ta * wr), ib = Math.max(ia + 1, Math.floor((ta + spp * dpr) * wr));
          if (ib <= 0 || ia >= n) continue;
          let v = 0;
          for (let i = Math.max(0, ia); i < Math.min(n, ib); i++) { const s = w[i * 3 + b]; if (s > v) v = s; }
          const hh = v / 255 * mid * 0.95 * sc;
          g.fillRect(x, mid - hh, dpr, hh * 2);
        }
      }
    }
    // beat grid
    if (this.per) {
      const per = this.per, k0 = Math.ceil((t0 - this.fb) / per), k1 = Math.floor((t0 + W * spp - this.fb) / per);
      const showBeats = per / spp > 6 * dpr;
      for (let k = k0; k <= k1; k++) {
        const x = Math.round((this.fb + k * per - t0) / spp);
        const down = ((k % 4) + 4) % 4 === 0;
        if (!down && !showBeats) continue;
        g.fillStyle = down ? (this.grid ? 'rgba(255,181,71,0.95)' : 'rgba(255,93,115,0.85)') : 'rgba(255,255,255,0.28)';
        g.fillRect(x, 0, down ? 2 * dpr : dpr, down ? H : H * 0.12);
        if (!down) g.fillRect(x, H * 0.88, dpr, H * 0.12);
        if (down && this.grid) {
          g.font = `${10 * dpr}px IBM Plex Mono, monospace`; g.fillStyle = 'rgba(255,181,71,0.95)';
          g.fillText(String(Math.floor(k / 4) + 1), x + 3 * dpr, H - 4 * dpr);
        }
      }
    }
    // hot cues
    const cues = this.t.cues || [];
    g.font = `600 ${10 * dpr}px IBM Plex Mono, monospace`;
    cues.forEach((c, i) => {
      if (!c) return;
      const x = (c.t - t0) / spp;
      if (x < -20 * dpr || x > W) return;
      g.fillStyle = PAD_COLORS[i]; g.fillRect(x, 0, 1.5 * dpr, H);
      g.fillRect(x, 0, 14 * dpr, 14 * dpr);
      g.fillStyle = '#0d1015'; g.fillText(CUE_LETTERS[i], x + 3.5 * dpr, 11 * dpr);
    });
    (this.t.memory || []).forEach((m) => {
      const x = (m - t0) / spp; if (x < 0 || x > W) return;
      g.fillStyle = '#ff6b6b'; g.beginPath(); g.moveTo(x - 5 * dpr, H); g.lineTo(x + 5 * dpr, H); g.lineTo(x, H - 7 * dpr); g.fill();
    });
    // playhead
    g.fillStyle = '#fff'; g.fillRect(W / 2 - dpr, 0, 2 * dpr, H);
  }

  buildOverview(W, H) {
    const off = document.createElement('canvas'); off.width = W; off.height = H;
    const g = off.getContext('2d'), w = this.wave, n = w.length / 3, mid = H / 2;
    const cols = [['rgba(61,123,255,0.9)', 0, 1], ['rgba(255,181,71,0.85)', 1, 0.75], ['rgba(243,245,250,0.8)', 2, 0.5]];
    for (const [col, b, sc] of cols) {
      g.fillStyle = col;
      for (let x = 0; x < W; x++) {
        const ia = Math.floor(x / W * n), ib = Math.max(ia + 1, Math.floor((x + 1) / W * n));
        let v = 0; for (let i = ia; i < ib; i++) { const s = w[i * 3 + b]; if (s > v) v = s; }
        const hh = v / 255 * mid * 0.95 * sc; g.fillRect(x, mid - hh, 1, hh * 2);
      }
    }
    return off;
  }

  drawOverview() {
    const cv = this.q('.ov-cv'), g = cv.getContext('2d');
    if (this.fitCanvas(cv)) this.ovCache = null;
    const W = cv.width, H = cv.height, dpr = window.devicePixelRatio || 1;
    g.clearRect(0, 0, W, H);
    if (!this.t || !this.dur) return;
    if (this.wave) { if (!this.ovCache) this.ovCache = this.buildOverview(W, H); g.drawImage(this.ovCache, 0, 0); }
    const px = this.time / this.dur * W;
    g.fillStyle = 'rgba(13,16,21,0.55)'; g.fillRect(0, 0, px, H);
    if (this.loop) { g.fillStyle = 'rgba(255,181,71,0.35)'; g.fillRect(this.loop.a / this.dur * W, 0, Math.max(2, (this.loop.b - this.loop.a) / this.dur * W), H); }
    (this.t.cues || []).forEach((c, i) => { if (c) { g.fillStyle = PAD_COLORS[i]; g.fillRect(c.t / this.dur * W, 0, 2 * dpr, H); } });
    g.fillStyle = '#fff'; g.fillRect(px - dpr / 2, 0, dpr * 1.5, H);
  }
}

const DECKS = { A: new Deck('A'), B: new Deck('B') };
DECKS.A.other = DECKS.B; DECKS.B.other = DECKS.A;
const focused = () => DECKS[S.focus] || DECKS.A;
window.revealPath = (p) => api('/api/reveal', { body: { path: p } }).catch((e) => toast(e.message, { error: true }));

function loop() {
  DECKS.A.frame(); DECKS.B.frame();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
window.addEventListener('resize', () => { Object.values(DECKS).forEach((d) => { d.ovCache = null; d.dirty = true; }); });

/* ---------- mixer ---------- */
$$('.ch').forEach((ch) => {
  const d = DECKS[ch.dataset.ch];
  $('.vfader', ch).addEventListener('input', (e) => { d.fader = parseFloat(e.target.value); d.applyGain(); });
});
$('#xfader').addEventListener('input', (e) => { AU.xf = parseFloat(e.target.value); Object.values(DECKS).forEach((d) => d.applyGain()); });
$('#quantBtn').addEventListener('click', () => saveSettings({ quantize: !S.settings.quantize }));
$('#xfCenter').addEventListener('click', () => { AU.xf = 0; $('#xfader').value = 0; Object.values(DECKS).forEach((d) => d.applyGain()); });

/* ---------- loudness controls ---------- */
function renderLoudCtl() {
  const on = !!S.settings.autogain;
  $('#agSwitch').setAttribute('aria-checked', String(on));
  $('#loudCtl').classList.toggle('off', !on);
  const sel = $('#presetSel');
  sel.innerHTML = Object.values(S.presets).map((p) => `<option value="${p.key}">${esc(p.name)} · ${p.lufs} LUFS</option>`).join('');
  sel.value = S.settings.preset;
  $('#presetCards').innerHTML = Object.values(S.presets).map((p) => `
    <button type="button" class="preset-card" role="radio" aria-checked="${p.key === S.settings.preset}" data-preset="${p.key}">
      <b>${esc(p.name)}</b><span class="lv">${p.lufs}</span><small>${esc(p.description)} Limiter ${p.ceiling_db} dBTP.</small>
    </button>`).join('');
  $$('#presetCards .preset-card').forEach((b) => b.addEventListener('click', () => saveSettings({ preset: b.dataset.preset })));
  $('#optRepair').checked = !!S.settings.repair;
  $('#optContrast').checked = !!S.settings.contrast;
  $$('input[name="outMode"]').forEach((r) => { r.checked = r.value === S.settings.out_mode; });
  $('#outFolder').value = S.settings.out_folder || '';
  $('#quantBtn').setAttribute('aria-pressed', String(!!S.settings.quantize));
}
async function saveSettings(patch) {
  Object.assign(S.settings, patch);
  renderLoudCtl();
  Object.values(DECKS).forEach((d) => d.applyGain());
  scheduleLibraryRender(); renderLoudStats();
  try { S.settings = await api('/api/settings', { method: 'PATCH', body: patch }); } catch (e) { toast(e.message, { error: true }); }
}
$('#agSwitch').addEventListener('click', () => {
  saveSettings({ autogain: !S.settings.autogain });
  toast(S.settings.autogain ? `Leveling volume to ${targetLufs()} LUFS` : 'Volume leveling off');
});
$('#presetSel').addEventListener('change', (e) => saveSettings({ preset: e.target.value }));
$('#loudInfo').addEventListener('click', () => selectTab('loud'));
$('#optRepair').addEventListener('change', (e) => saveSettings({ repair: e.target.checked }));
$('#optContrast').addEventListener('change', (e) => saveSettings({ contrast: e.target.checked }));
$$('input[name="outMode"]').forEach((r) => r.addEventListener('change', () => saveSettings({ out_mode: r.value })));
$('#outFolder').addEventListener('change', (e) => saveSettings({ out_folder: e.target.value.trim(), out_mode: 'folder' }));

/* ---------- library ---------- */
function filteredTracks() {
  let list = [...S.tracks.values()];
  if (typeof S.plFilter === 'string' && S.plFilter.startsWith('f:')) {
    const prefix = S.plFilter.slice(2).replace(/\/$/, '') + '/';
    list = list.filter((t) => t.path.startsWith(prefix));
  } else if (S.plFilter !== 'all') {
    const pl = S.playlists.find((p) => p.id === S.plFilter);
    const ids = pl && pl._ids ? pl._ids : [];
    const order = new Map(ids.map((id, i) => [id, i]));
    list = list.filter((t) => order.has(t.id));
    if (S.sort.key === 'pos') list.sort((a, b) => order.get(a.id) - order.get(b.id));
  }
  const q = S.search.trim().toLowerCase();
  if (q) {
    const keyQ = /^\d{1,2}[ab]$/.test(q) ? q.toUpperCase() : null;
    const num = /^\d{2,3}(\.\d+)?$/.test(q) ? parseFloat(q) : null;
    list = list.filter((t) => {
      if (keyQ) return t.key === keyQ;
      if (num) return t.bpm && Math.abs(t.bpm - num) <= 1;
      return `${t.title} ${t.artist} ${t.genre || ''}`.toLowerCase().includes(q);
    });
  }
  if (S.sort.key !== 'pos') {
    const k = S.sort.key, dir = S.sort.dir;
    const val = (t) => {
      if (k === 'gain') return trackGain(t) ?? -999;
      if (k === 'key') { const p = camParts(t.key); return p ? p[0] * 2 + (p[1] === 'B' ? 1 : 0) : 999; }
      if (k === 'title') return `${t.artist || ''} ${t.title || ''}`.toLowerCase();
      return t[k] ?? (typeof t[k] === 'string' ? '' : -999);
    };
    list.sort((a, b) => { const va = val(a), vb = val(b); return (va < vb ? -1 : va > vb ? 1 : 0) * dir; });
  }
  return list;
}

const STATUS = { new: 'queued', analyzing: 'analyzing …', ready: '', missing: 'file missing', error: 'error' };
let libTimer;
function scheduleLibraryRender() { clearTimeout(libTimer); libTimer = setTimeout(renderLibrary, 120); }
function renderLibrary() {
  const list = filteredTracks();
  S.visible = list;
  const ag = S.settings.autogain;
  const rows = list.map((t) => {
    const g = trackGain(t);
    const st = STATUS[t.status] ?? t.status;
    const edited = t.key_detected && t.key && t.key_detected !== t.key;
    return `<tr data-id="${t.id}" draggable="true" class="${S.sel.has(t.id) ? 'sel' : ''}">
      <td class="c-sel"><input type="checkbox" ${S.sel.has(t.id) ? 'checked' : ''} aria-label="Select"></td>
      <td class="c-load"><span class="load-btns"><button type="button" data-to="A" title="Load into deck A">A</button><button type="button" data-to="B" title="Load into deck B">B</button></span></td>
      <td class="t-title"><b>${esc(t.title)}</b>${t.artist ? ` <span>· ${esc(t.artist)}</span>` : ''}</td>
      <td class="c-key">${t.key ? `<span class="kc${edited ? ' edited' : ''}" style="--kc:${keyColor(t.key)}" title="${edited ? 'Edited by hand, detected: ' + t.key_detected : CLASSIC[t.key] || ''}">${t.key}</span>` : '–'}</td>
      <td class="c-num">${t.bpm ? t.bpm.toFixed(2) : '–'}</td>
      <td class="c-num">${t.energy ?? '–'}</td>
      <td class="c-num">${t.lufs != null ? t.lufs.toFixed(1) : '–'}</td>
      <td class="c-num ${g == null ? '' : g >= 0 ? 'gain-pos' : 'gain-neg'}" style="${ag ? '' : 'opacity:.45'}">${g == null ? '–' : fmtDb(g)}</td>
      <td class="c-num">${t.duration ? fmtTime(t.duration, false) : '–'}</td>
      <td><span class="st ${t.status === 'error' || t.status === 'missing' ? 'err' : t.status === 'analyzing' ? 'run' : ''}" title="${esc(t.error || '')}">${st}${t.processed_path ? ' · processed' : ''}</span></td>
    </tr>`;
  });
  $('#libBody').innerHTML = rows.join('');
  $('#libEmpty').hidden = S.tracks.size > 0;
  $$('#libTable th[data-sort]').forEach((th) => th.toggleAttribute('aria-sort', th.dataset.sort === S.sort.key));
  renderLibraryMarks();
  renderSelInfo();
}
function renderLibraryMarks() {
  const a = DECKS.A.t && DECKS.A.t.id, b = DECKS.B.t && DECKS.B.t.id;
  $$('#libBody tr').forEach((tr) => {
    const id = parseInt(tr.dataset.id, 10);
    tr.classList.toggle('loaded-A', id === a); tr.classList.toggle('loaded-B', id === b);
  });
}
function renderSelInfo() {
  const n = S.sel.size;
  $('#selInfo').textContent = n ? `${n} selected` : `${(S.visible || []).length} tracks`;
  $('#selActions').classList.toggle('off', !n);
  $('#selAll').checked = n > 0 && (S.visible || []).every((t) => S.sel.has(t.id));
}
$('#libBody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr'); if (!tr) return;
  const id = parseInt(tr.dataset.id, 10), t = S.tracks.get(id);
  const to = e.target.closest('[data-to]');
  if (to) { DECKS[to.dataset.to].load(t); return; }
  if (e.target.matches('input[type="checkbox"]')) {
    if (e.target.checked) S.sel.add(id); else S.sel.delete(id);
    tr.classList.toggle('sel', e.target.checked); renderSelInfo(); return;
  }
});
$('#libBody').addEventListener('dblclick', (e) => {
  const tr = e.target.closest('tr'); if (!tr || e.target.closest('button, input')) return;
  const t = S.tracks.get(parseInt(tr.dataset.id, 10));
  const target = !DECKS.A.t ? DECKS.A : !DECKS.B.t ? DECKS.B : (DECKS.A.playing && !DECKS.B.playing ? DECKS.B : DECKS.A.playing ? DECKS.B : DECKS.A);
  target.load(t);
});
$('#libBody').addEventListener('dragstart', (e) => {
  const tr = e.target.closest('tr'); if (!tr) return;
  e.dataTransfer.setData('text/km-track', tr.dataset.id); e.dataTransfer.effectAllowed = 'copy';
});
$('#selAll').addEventListener('change', (e) => {
  (S.visible || []).forEach((t) => (e.target.checked ? S.sel.add(t.id) : S.sel.delete(t.id)));
  renderLibrary();
});
$$('#libTable th[data-sort]').forEach((th) => th.addEventListener('click', () => {
  const k = th.dataset.sort;
  S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : (['bpm', 'energy', 'lufs', 'gain', 'duration'].includes(k) ? -1 : 1) };
  renderLibrary();
}));
$('#search').addEventListener('input', (e) => { S.search = e.target.value; scheduleLibraryRender(); });

function renderPlaylists() {
  const rbs = S.playlists.filter((p) => p.source === 'rekordbox'), locs = S.playlists.filter((p) => p.source !== 'rekordbox');
  const item = (p) => `<li><button type="button" data-pl="${p.id}" aria-current="${S.plFilter === p.id}"><span>${esc(p.name)}</span><small>${p.n}</small></button></li>`;
  const folders = S.settings.folders || [];
  const fcount = (f) => { const pre = f.replace(/\/$/, '') + '/'; let n = 0; S.tracks.forEach((t) => { if (t.path.startsWith(pre)) n++; }); return n; };
  const fitem = (f) => `<li class="row"><button type="button" data-pl="f:${esc(f)}" aria-current="${S.plFilter === 'f:' + f}" title="${esc(f)}"><span>${FOLDER_ICON}${esc(f.split('/').filter(Boolean).pop() || f)}</span><small>${fcount(f)}</small></button><button type="button" class="x" data-rmfolder="${esc(f)}" aria-label="Remove folder ${esc(f)} from library">✕</button></li>`;
  $('#plList').innerHTML = `<li><button type="button" data-pl="all" aria-current="${S.plFilter === 'all'}"><span>All tracks</span><small>${S.tracks.size}</small></button></li>`
    + (folders.length ? `<li class="label sep">Folders</li>${folders.map(fitem).join('')}` : '')
    + (locs.length ? `<li class="label sep">Key Master</li>${locs.map(item).join('')}` : '')
    + (rbs.length ? `<li class="label sep">Rekordbox</li>${rbs.map(item).join('')}` : '');
  const opts = `<option value="">Whole library</option>` + S.playlists.map((p) => `<option value="${p.id}">${esc(p.name)} (${p.n})</option>`).join('')
    + [...new Set([...S.tracks.values()].map((t) => t.genre).filter(Boolean))].sort().map((g) => `<option value="g:${esc(g)}">Genre: ${esc(g)}</option>`).join('');
  ['#mashPool', '#mixPool'].forEach((s) => { const el = $(s), v = el.value; el.innerHTML = opts; el.value = v; });
  const ss = $('#setSource'), sv = ss.value;
  ss.innerHTML = `<option value="sel">Selection in the library</option>` + S.playlists.map((p) => `<option value="${p.id}">${esc(p.name)} (${p.n})</option>`).join('');
  ss.value = sv || 'sel';
}
$('#plList').addEventListener('click', async (e) => {
  const rm = e.target.closest('[data-rmfolder]');
  if (rm) {
    const f = rm.dataset.rmfolder;
    if (!(await confirmDlg('Remove folder?', `<p>Removes <code>${esc(f)}</code> and its tracks from the Key Master library. The files on disk stay untouched.</p>`, 'Remove'))) return;
    const r = await api(`/api/folders?path=${encodeURIComponent(f)}`, { method: 'DELETE' });
    if (S.plFilter === 'f:' + f) S.plFilter = 'all';
    toast(`Removed ${r.removed} tracks from the library`);
    await loadState(); return;
  }
  const b = e.target.closest('[data-pl]'); if (!b) return;
  const v = b.dataset.pl;
  if (v.startsWith('f:')) {
    S.plFilter = v; if (S.sort.key === 'pos') S.sort = { key: 'title', dir: 1 };
    renderPlaylists(); renderLibrary(); return;
  }
  S.plFilter = v === 'all' ? 'all' : parseInt(v, 10);
  if (S.plFilter !== 'all') {
    const pl = S.playlists.find((p) => p.id === S.plFilter);
    if (pl && !pl._ids) pl._ids = (await api(`/api/playlists/${pl.id}`)).track_ids;
    S.sort = { key: 'pos', dir: 1 };
  } else if (S.sort.key === 'pos') S.sort = { key: 'title', dir: 1 };
  renderPlaylists(); renderLibrary();
});

/* selection actions */
$('#selActions').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-sel]'); if (!b) return;
  const ids = [...S.sel];
  if (!ids.length) return;
  const act = b.dataset.sel;
  if (act === 'process') processTracks(ids);
  if (act === 'tags') {
    if (!(await confirmDlg('Write tags?', `<p>Writes key, BPM and "Key - Energy" as a comment into the file tags of <b>${ids.length}</b> files. Other tags stay unchanged.</p>`, 'Write tags'))) return;
    const r = await api('/api/tags', { body: { track_ids: ids } });
    toast(`${r.written} files tagged${r.failed.length ? `, ${r.failed.length} failed` : ''}`, { error: r.failed.length > 0 });
  }
  if (act === 'playlist') {
    const name = await promptDlg('New playlist', `Save ${ids.length} tracks as a Key Master playlist:`, 'New playlist');
    if (!name) return;
    const r = await api('/api/playlists', { body: { name, track_ids: ids } });
    S.playlists = r.playlists; renderPlaylists(); toast(`Playlist "${esc(name)}" saved`);
  }
  if (act === 'set') { $('#setSource').value = 'sel'; selectTab('set'); runSet(); }
  if (act === 'reanalyze') {
    for (const id of ids) await api(`/api/tracks/${id}/analyze`, { body: {} });
    toast(`Re-analyzing ${ids.length} tracks`);
  }
});

/* ---------- tabs ---------- */
function selectTab(name) {
  $$('.tabs [role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  $$('.tabpane').forEach((p) => { p.hidden = p.dataset.pane !== name; });
  S.tab = name;
  if (name === 'mashup' || name === 'mixout') refreshSuggestions();
  if (name === 'loud') renderLoudStats();
  if (name === 'saved') renderSaved();
  if (name === 'files') fsInit();
}
$$('.tabs [role="tab"]').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));

/* ---------- suggestions ---------- */
function poolParams(sel) {
  const v = $(sel).value;
  if (!v) return '';
  return v.startsWith('g:') ? `&genre=${encodeURIComponent(v.slice(2))}` : `&playlist=${v}`;
}
function suggRow(m, base, intoDeck, opts) {
  const t = S.tracks.get(m.id); if (!t) return '';
  const keyAfter = m.key_after || t.key;
  const shiftTxt = m.shift ? `<b>${m.shift > 0 ? '+' : ''}${m.shift} st</b> → ` : '';
  const tempo = `Tempo ${m.pitch_pct > 0 ? '+' : ''}${m.pitch_pct.toFixed(1)} %${m.ratio !== 1 ? (m.ratio === 2 ? ' (double time)' : ' (half time)') : ''}`;
  const en = m.energy_delta !== undefined ? ` · Energy ${m.energy_delta > 0 ? '↑' + m.energy_delta : m.energy_delta < 0 ? '↓' + (-m.energy_delta) : '→'}` : '';
  return `<div class="sugg">
    <div class="score" title="Match"><i style="width:${clamp(m.score, 0, 1) * 100}%"></i></div>
    <div class="t-title"><b>${esc(t.title)}</b>${t.artist ? ` <span>· ${esc(t.artist)}</span>` : ''}</div>
    <span class="kc" style="--kc:${keyColor(keyAfter)}">${keyAfter}</span>
    <span class="why">${shiftTxt}${esc(m.label)} · ${tempo}${en}</span>
    <span class="c-num">${t.bpm ? t.bpm.toFixed(1) : ''}</span>
    <button class="btn small" type="button" data-load="${m.id}" data-shift="${m.shift || 0}" data-deck="${intoDeck}">Load into ${intoDeck}${opts.sync ? ' + sync' : ''}</button>
  </div>`;
}
let suggTimer;
function refreshSuggestions() { clearTimeout(suggTimer); suggTimer = setTimeout(doRefreshSuggestions, 150); }
async function doRefreshSuggestions() {
  if (S.tab === 'mashup') {
    const base = DECKS.A.t ? DECKS.A : DECKS.B.t ? DECKS.B : null;
    if (!base || !base.t.key) { $('#mashFor').innerHTML = 'Load a track with a key into deck A. Tracks that work on top of it will appear here.'; $('#mashList').innerHTML = ''; return; }
    const into = base.id === 'A' ? 'B' : 'A';
    $('#mashFor').innerHTML = `Matches <b>${esc(base.t.title)}</b> (Deck ${base.id}, <span class="kc" style="--kc:${keyColor(base.key)}">${base.key}</span>, ${base.t.bpm ? base.t.bpm.toFixed(1) : '–'} BPM) <button class="btn small" id="saveMash" type="button" ${DECKS.A.t && DECKS.B.t ? '' : 'disabled'}>Save current pair</button>`;
    $('#saveMash').addEventListener('click', saveCurrentMashup);
    const list = await api(`/api/suggest/${base.t.id}?mode=mashup&max_shift=${$('#mashShift').value}&shift=${base.shift}${poolParams('#mashPool')}`);
    $('#mashList').innerHTML = list.length ? list.map((m) => suggRow(m, base, into, { sync: true })).join('') : '<p class="sugg-empty">No matching tracks found. Widen the key shift or the selection.</p>';
  }
  if (S.tab === 'mixout') {
    const base = focused().t ? focused() : (DECKS.A.t ? DECKS.A : DECKS.B.t ? DECKS.B : null);
    if (!base || !base.t.key) { $('#mixFor').innerHTML = 'Load a track into a deck. Good next tracks for the transition will appear here.'; $('#mixList').innerHTML = ''; return; }
    const into = base.id === 'A' ? 'B' : 'A';
    $('#mixFor').innerHTML = `After <b>${esc(base.t.title)}</b> (Deck ${base.id}, <span class="kc" style="--kc:${keyColor(base.t.key)}">${base.t.key}</span>, energy ${base.t.energy ?? '–'})`;
    const list = await api(`/api/suggest/${base.t.id}?mode=mixout${poolParams('#mixPool')}`);
    $('#mixList').innerHTML = list.length ? list.map((m) => suggRow(m, base, into, { sync: false })).join('') : '<p class="sugg-empty">No matching tracks found.</p>';
  }
}
['#mashPool', '#mashShift', '#mixPool'].forEach((s) => $(s).addEventListener('change', refreshSuggestions));
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-load]'); if (!b) return;
  const t = S.tracks.get(parseInt(b.dataset.load, 10));
  const d = DECKS[b.dataset.deck];
  d.load(t, { shift: parseInt(b.dataset.shift || '0', 10), sync: b.closest('#mashList') !== null });
});

async function saveCurrentMashup() {
  const a = DECKS.A, b = DECKS.B;
  if (!a.t || !b.t) return;
  const r = await api('/api/mashups', { body: { a_id: a.t.id, b_id: b.t.id, a_shift: a.shift, b_shift: b.shift, a_stem: a.stem, b_stem: b.stem } });
  S.mashups = r.mashups; renderSaved(); toast('Mashup saved. Rate it under "Saved mashups".');
}
function renderSaved() {
  $('#savedCount').textContent = S.mashups.length || '';
  if (!S.mashups.length) { $('#savedList').innerHTML = '<p class="sugg-empty">No mashups yet. Load two tracks and save the pair under "Mashup ideas".</p>'; return; }
  const stemTxt = { mix: '', vocals: ' · Vocals', instrumental: ' · Instr.' };
  $('#savedList').innerHTML = S.mashups.map((m) => {
    const a = S.tracks.get(m.a_id), b = S.tracks.get(m.b_id);
    if (!a || !b) return '';
    const side = (t, sh, st) => `<b>${esc(t.title)}</b> <span class="kc" style="--kc:${keyColor(shiftKey(t.key, sh))}">${shiftKey(t.key, sh) || '–'}</span><span class="why">${sh ? ` ${sh > 0 ? '+' : ''}${sh} st` : ''}${stemTxt[st || 'mix'] || ''}</span>`;
    return `<div class="sugg" data-mid="${m.id}" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto auto auto">
      <div class="t-title">A: ${side(a, m.a_shift, m.a_stem)}</div>
      <div class="t-title">B: ${side(b, m.b_shift, m.b_stem)}</div>
      <span class="stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-rate="${n}" class="${n <= (m.rating || 0) ? 'on' : ''}" aria-label="${n} stars">★</button>`).join('')}</span>
      <button class="btn small" type="button" data-mload="${m.id}">Load</button>
      <button class="mini-btn" type="button" data-mdel="${m.id}" aria-label="Delete">✕</button>
    </div>`;
  }).join('');
}
$('#savedList').addEventListener('click', async (e) => {
  const row = e.target.closest('[data-mid]'); if (!row) return;
  const mid = parseInt(row.dataset.mid, 10), m = S.mashups.find((x) => x.id === mid);
  const rate = e.target.closest('[data-rate]');
  if (rate) { S.mashups = (await api(`/api/mashups/${mid}`, { method: 'PATCH', body: { rating: parseInt(rate.dataset.rate, 10) } })).mashups; renderSaved(); }
  if (e.target.closest('[data-mload]')) {
    await DECKS.A.load(S.tracks.get(m.a_id), { shift: m.a_shift, stem: m.a_stem });
    await DECKS.B.load(S.tracks.get(m.b_id), { shift: m.b_shift, stem: m.b_stem, sync: true });
  }
  if (e.target.closest('[data-mdel]')) { S.mashups = (await api(`/api/mashups/${mid}`, { method: 'DELETE' })).mashups; renderSaved(); }
});

/* ---------- set builder ---------- */
async function runSet() {
  const src = $('#setSource').value;
  let ids;
  if (src === 'sel') ids = [...S.sel];
  else ids = (await api(`/api/playlists/${src}`)).track_ids;
  if (ids.length < 2) { toast('Select at least two tracks (library) or a playlist.'); return; }
  const r = await api('/api/set/order', { body: { track_ids: ids, curve: $('#setCurve').value } });
  S.setOrder = r.order;
  renderSet();
}
function renderSet() {
  const order = S.setOrder || [];
  $('#setSave').disabled = order.length < 2;
  $('#setList').innerHTML = order.map((id, i) => {
    const t = S.tracks.get(id); if (!t) return '';
    const prev = i ? S.tracks.get(order[i - 1]) : null;
    let trans = '';
    if (prev) {
      const rel = relation(prev.key, t.key) || ['?', ''];
      const pct = prev.bpm && t.bpm ? ((t.bpm / prev.bpm - 1) * 100) : 0;
      trans = `<span class="trans ${rel[1]}">${rel[0]} · ${pct >= 0 ? '+' : ''}${pct.toFixed(1)} %</span>`;
    }
    return `<li><span class="kc" style="--kc:${keyColor(t.key)}">${t.key || '–'}</span>
      <div class="t-title"><b>${esc(t.title)}</b>${t.artist ? ` <span>· ${esc(t.artist)}</span>` : ''} <span class="why">E${t.energy ?? '–'} · ${t.bpm ? t.bpm.toFixed(1) : '–'} BPM</span></div>
      ${trans || '<span></span>'}
      <span class="load-btns"><button type="button" data-to2="A" data-id="${id}">A</button><button type="button" data-to2="B" data-id="${id}">B</button></span></li>`;
  }).join('');
}
$('#setList').addEventListener('click', (e) => { const b = e.target.closest('[data-to2]'); if (b) DECKS[b.dataset.to2].load(S.tracks.get(parseInt(b.dataset.id, 10))); });
$('#setRun').addEventListener('click', runSet);
$('#setSave').addEventListener('click', async () => {
  const name = await promptDlg('Save set', 'Playlist name:', `Set ${new Date().toLocaleDateString('en-GB')}`);
  if (!name) return;
  const r = await api('/api/playlists', { body: { name, track_ids: S.setOrder } });
  S.playlists = r.playlists; renderPlaylists(); toast(`"${esc(name)}" saved. Use "Export to Rekordbox" to send it over.`);
});

/* ---------- loudness stats + processing ---------- */
function renderLoudStats() {
  const ts = [...S.tracks.values()].filter((t) => t.lufs != null && t.lufs > -40);
  const tgt = targetLufs();
  const lo = -20, hi = -3, bins = Array(hi - lo).fill(0);
  ts.forEach((t) => { bins[clamp(Math.floor(t.lufs) - lo, 0, bins.length - 1)]++; });
  const max = Math.max(1, ...bins);
  $('#loudHist').innerHTML = bins.map((n, i) => `<i class="${Math.abs(lo + i + 0.5 - tgt) <= 2 ? 'in' : ''}" style="height:${n / max * 100}%" title="${lo + i} to ${lo + i + 1} LUFS: ${n} tracks"></i>`).join('')
    + `<span class="tgt" style="left:${(tgt - lo) / (hi - lo) * 100}%" title="Target ${tgt} LUFS"></span>`;
  let axis = $('#loudHist').nextElementSibling;
  if (!axis || !axis.classList.contains('hist-axis')) { axis = document.createElement('div'); axis.className = 'hist-axis'; $('#loudHist').after(axis); }
  axis.innerHTML = `<span>${lo} LUFS</span><span>Target ${tgt}</span><span>${hi} LUFS</span>`;
  const off = ts.filter((t) => Math.abs(t.lufs - tgt) > 2);
  const clip = ts.filter((t) => (t.clipped || 0) > 0);
  const avg = ts.length ? ts.reduce((s, t) => s + t.lufs, 0) / ts.length : 0;
  $('#loudSummary').innerHTML = ts.length
    ? `${ts.length} tracks measured · avg ${avg.toFixed(1)} LUFS · <b>${off.length}</b> are more than 2 dB off target · <b>${clip.length}</b> with clipping.`
    : 'No measurements yet. Loudness is measured during analysis.';
  $('#procOff').textContent = `Process all outside ±2 dB (${off.length})`;
  $('#procOff').disabled = !off.length;
  $('#procSel').textContent = `Process selected (${S.sel.size})`;
  $('#procSel').disabled = !S.sel.size;
  renderProcList();
}
async function processTracks(ids) {
  const p = S.presets[S.settings.preset];
  const where = S.settings.out_mode === 'folder' ? `in <code>${esc(S.settings.out_folder)}</code>` : 'next to the original with <code>_KM</code> in the name';
  const ok = await confirmDlg(`Process ${ids.length} tracks?`,
    `<p>Target <b>${p.lufs} LUFS</b> (${esc(p.name)}), limiter ${p.ceiling_db} dBTP${S.settings.repair ? ', clipping repair' : ''}${S.settings.contrast ? ', contrast' : ''}.</p>
     <p>The copies are saved ${where}. Originals stay unchanged. Takes about ${Math.max(1, Math.round(ids.length * 12 / 60))} min.</p>`, 'Process');
  if (!ok) return;
  const r = await api('/api/process', { body: { track_ids: ids } });
  r.jobs.forEach((j) => S.procJobs.set(j, null));
  selectTab('loud');
  toast(`${ids.length} tracks queued`);
}
$('#procSel').addEventListener('click', () => processTracks([...S.sel]));
$('#procOff').addEventListener('click', () => {
  const tgt = targetLufs();
  processTracks([...S.tracks.values()].filter((t) => t.lufs != null && Math.abs(t.lufs - tgt) > 2).map((t) => t.id));
});
function renderProcList() {
  const items = [...S.procJobs.entries()].map(([id, j]) => j || { id, label: 'Queued …', state: 'queued' });
  $('#procList').innerHTML = items.slice(-200).reverse().map((j) => {
    let res = j.state === 'queued' ? 'queued' : j.state === 'running' ? `${Math.round(j.progress * 100)} %` : j.state === 'error' ? `Error: ${esc(j.error)}` : '';
    if (j.state === 'done' && j.result) {
      const r = j.result;
      res = `${r.before.lufs.toFixed(1)} → ${r.after.lufs.toFixed(1)} LUFS${r.peaks_fixed ? ` · ${r.peaks_fixed} peaks repaired` : ''} <button class="mini-btn" type="button" onclick="revealPath('${esc(r.path).replace(/'/g, "\\'")}')">Show</button>`;
    }
    return `<li><span>${esc((j.label || '').replace(/^[^:]+: /, ''))}</span><span class="res">${res}</span></li>`;
  }).join('');
}

/* ---------- file browser (USB sticks, drives, folders) ---------- */
const FOLDER_ICON = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.5a1 1 0 0 1 1-1h3.6l1.5 1.6h5.9a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>';
const DRIVE_ICON = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="5" width="13" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="11.5" cy="8.25" r="1" fill="currentColor"/></svg>';
const NOTE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 12.5V3.5l7-1.5v9" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="4.5" cy="12.5" r="1.8" fill="currentColor"/><circle cx="11.5" cy="11" r="1.8" fill="currentColor"/></svg>';
S.fs = null;
async function fsInit() {
  try {
    const { roots } = await api('/api/fs/roots');
    S.fsRoots = roots;
    renderFsRoots();
    if (!S.fs) {
      const start = roots.find((r) => r.kind === 'drive') || roots[0];
      if (start) await fsOpen(start.path);
    }
  } catch (e) { toast(e.message, { error: true }); }
}
function renderFsRoots() {
  const cur = S.fs ? S.fs.path : '';
  const item = (r) => `<li><button type="button" data-fsroot="${esc(r.path)}" aria-current="${cur === r.path || cur.startsWith(r.path + '/')}" title="${esc(r.path)}"><span>${r.kind === 'drive' ? DRIVE_ICON : FOLDER_ICON}${esc(r.name)}</span></button></li>`;
  const drives = S.fsRoots.filter((r) => r.kind === 'drive'), folders = S.fsRoots.filter((r) => r.kind !== 'drive');
  $('#fsRoots').innerHTML = (drives.length ? `<li class="label sep">Drives &amp; USB</li>${drives.map(item).join('')}` : '')
    + `<li class="label sep">On this Mac</li>${folders.map(item).join('')}`
    + `<li><button type="button" id="fsRefresh"><span class="muted">Refresh drives</span></button></li>`;
}
async function fsOpen(path) {
  try { S.fs = await api(`/api/fs/list?path=${encodeURIComponent(path)}`); }
  catch (e) { toast(e.message, { error: true }); return; }
  renderFs(); if (S.fsRoots) renderFsRoots();
}
function renderFs() {
  const fs = S.fs; if (!fs) return;
  const parts = fs.path.split('/').filter(Boolean);
  $('#fsCrumbs').innerHTML = parts.map((p, i) => `<button type="button" data-fsgo="${esc('/' + parts.slice(0, i + 1).join('/'))}">${esc(p)}</button>`).join('<span>/</span>');
  $('#fsUp').disabled = !fs.parent;
  const dirs = fs.dirs.map((d) => `<tr class="fs-dir" data-fsgo="${esc(d.path)}"><td></td><td class="t-title" colspan="6">${FOLDER_ICON.replace('class="ic"', '')}<b>${esc(d.name)}</b></td></tr>`);
  const files = fs.files.map((f) => {
    const t = f.track_id ? S.tracks.get(f.track_id) : null;
    const st = t ? (STATUS[t.status] ?? t.status) || 'in library' : '';
    return `<tr class="fs-file" draggable="true" data-path="${esc(f.path)}">
      <td class="c-load"><span class="load-btns"><button type="button" data-fsload="A" title="Load into deck A">A</button><button type="button" data-fsload="B" title="Load into deck B">B</button></span></td>
      <td class="t-title">${NOTE_ICON}${esc(f.name)}</td>
      <td class="c-key">${t && t.key ? `<span class="kc" style="--kc:${keyColor(t.key)}">${t.key}</span>` : ''}</td>
      <td class="c-num">${t && t.bpm ? t.bpm.toFixed(2) : ''}</td>
      <td class="c-num">${t && t.energy != null ? t.energy : ''}</td>
      <td><span class="st">${esc(st)}</span></td>
      <td>${t ? '' : '<button class="mini-btn" type="button" data-fsaddfile title="Add this file to the library">Add</button>'}</td>
    </tr>`;
  });
  $('#fsBody').innerHTML = dirs.join('') + files.join('');
  const empty = !fs.dirs.length && !fs.files.length;
  $('#fsEmpty').hidden = !empty;
  $('#fsEmpty').textContent = empty ? 'This folder has no subfolders or audio files.' : '';
  const n = fs.files.length;
  $('#fsAdd').textContent = n || fs.dirs.length ? `Add this folder to library` : 'Add this folder to library';
}
async function loadPath(path, deckId) {
  try {
    const t = await api('/api/fs/track', { body: { path } });
    const old = S.tracks.get(t.id);
    S.tracks.set(t.id, old ? Object.assign(old, t) : t);
    await DECKS[deckId].load(S.tracks.get(t.id));
    scheduleLibraryRender(); renderPlaylists();
    if (S.tab === 'files' && S.fs) { const f = S.fs.files.find((x) => x.path === path); if (f) { f.track_id = t.id; renderFs(); } }
  } catch (e) { toast(e.message, { error: true }); }
}
$('#fsRoots').addEventListener('click', async (e) => {
  if (e.target.closest('#fsRefresh')) { await fsInit(); toast('Drives refreshed'); return; }
  const b = e.target.closest('[data-fsroot]'); if (b) fsOpen(b.dataset.fsroot);
});
$('#fsCrumbs').addEventListener('click', (e) => { const b = e.target.closest('[data-fsgo]'); if (b) fsOpen(b.dataset.fsgo); });
$('#fsUp').addEventListener('click', () => { if (S.fs && S.fs.parent) fsOpen(S.fs.parent); });
$('#fsBody').addEventListener('click', async (e) => {
  const dir = e.target.closest('tr[data-fsgo]'); if (dir) { fsOpen(dir.dataset.fsgo); return; }
  const row = e.target.closest('tr[data-path]'); if (!row) return;
  const ld = e.target.closest('[data-fsload]');
  if (ld) { loadPath(row.dataset.path, ld.dataset.fsload); return; }
  if (e.target.closest('[data-fsaddfile]')) {
    try {
      const t = await api('/api/fs/track', { body: { path: row.dataset.path } });
      S.tracks.set(t.id, t); const f = S.fs.files.find((x) => x.path === row.dataset.path); if (f) f.track_id = t.id;
      renderFs(); scheduleLibraryRender(); renderPlaylists(); toast('Added to library. Analysis runs in the background.');
    } catch (err) { toast(err.message, { error: true }); }
  }
});
$('#fsBody').addEventListener('dblclick', (e) => {
  const row = e.target.closest('tr[data-path]'); if (!row || e.target.closest('button')) return;
  loadPath(row.dataset.path, !DECKS.A.t ? 'A' : !DECKS.B.t ? 'B' : (DECKS.A.playing ? 'B' : 'A'));
});
$('#fsBody').addEventListener('dragstart', (e) => {
  const row = e.target.closest('tr[data-path]'); if (!row) return;
  e.dataTransfer.setData('text/km-path', row.dataset.path); e.dataTransfer.effectAllowed = 'copy';
});
$('#fsAdd').addEventListener('click', async () => {
  if (!S.fs) return;
  try {
    const r = await api('/api/folders', { body: { path: S.fs.path, recursive: $('#fsRec').checked } });
    S.settings.folders = r.folders;
    toast(`Added ${r.added} tracks from ${esc(r.path.split('/').pop())}. Analysis runs in the background.`);
    await loadState(); await fsOpen(S.fs.path);
  } catch (e) { toast(e.message, { error: true }); }
});

/* ---------- header actions ---------- */
$('#addFolder').addEventListener('click', async () => {
  toast('Choose a folder in the Finder dialog …');
  try {
    const r = await api('/api/folders', { body: {} });
    if (r.cancelled) { $('#toast').hidden = true; return; }
    toast(`Added ${r.added} tracks from ${esc(r.path)}. Analysis runs in the background.`);
    S.settings.folders = r.folders;
    await loadState();
  } catch (e) { toast(e.message, { error: true }); }
});
$('#rbImport').addEventListener('click', async () => {
  try { await api('/api/rekordbox/import', { body: {} }); toast('Loading Rekordbox collection …'); S.waitImport = true; }
  catch (e) { toast(e.message, { error: true }); }
});
const exportBtn = $('#exportBtn'), exportMenu = $('#exportMenu');
exportBtn.addEventListener('click', () => { exportMenu.hidden = !exportMenu.hidden; exportBtn.setAttribute('aria-expanded', String(!exportMenu.hidden)); });
document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) { exportMenu.hidden = true; exportBtn.setAttribute('aria-expanded', 'false'); } });
exportMenu.addEventListener('click', (e) => { const b = e.target.closest('[data-export]'); if (b) { exportMenu.hidden = true; exportDialog(b.dataset.export); } });

async function exportDialog(kind) {
  const sel = S.sel.size;
  const nProc = [...S.tracks.values()].filter((t) => t.processed_path).length;
  const plOpts = S.playlists.map((p) => `<option value="${p.id}">${esc(p.name)} (${p.n})</option>`).join('');
  const db = kind === 'db';
  const html = `
    <label class="radio"><input type="radio" name="exWhat" value="sel" ${sel ? 'checked' : 'disabled'}> Selected tracks (${sel})</label>
    <label class="radio"><input type="radio" name="exWhat" value="pl" ${!sel && S.playlists.length ? 'checked' : ''} ${S.playlists.length ? '' : 'disabled'}> Playlist <select id="exPl">${plOpts}</select></label>
    <label class="radio"><input type="radio" name="exWhat" value="all" ${!sel && !S.playlists.length ? 'checked' : ''}> Whole library (${S.tracks.size})</label>
    <label class="radio">Key notation <select id="exNot"><option value="camelot">Camelot (8A)</option><option value="classic">Classic (Am)</option></select></label>
    <label class="check"><input type="checkbox" id="exProc" ${nProc ? '' : 'disabled'}> <span>${db ? 'Swap in processed files in Rekordbox' : 'Use processed files'} (${nProc} available)<br><small>${db ? 'Replaces the file path; cues and grid are kept.' : 'The XML points to the _KM copies.'}</small></span></label>
    <p>${db ? 'Writes keys, hot cues, memory cues and playlists straight into the Rekordbox database. A backup is made first. <b>Rekordbox must be closed.</b> Rekordbox only takes the beatgrid via XML.'
      : 'Contains keys, beatgrid, cues, energy comment and playlists. In Rekordbox: Preferences → Advanced → Database → set rekordbox xml to this file, then import the tracks from "rekordbox xml" in the sidebar.'}</p>`;
  const ok = await dialog({ title: db ? 'Write directly to Rekordbox' : 'Create rekordbox.xml', html,
    actions: [{ label: 'Cancel', value: null }, { label: db ? 'Write' : 'Create XML', primary: true, value: () => ({
      what: ($('input[name="exWhat"]:checked') || {}).value, pl: parseInt($('#exPl') && $('#exPl').value, 10),
      notation: $('#exNot').value, proc: $('#exProc').checked }) }] });
  if (!ok || !ok.what) return;
  const body = { notation: ok.notation };
  if (ok.what === 'sel') body.track_ids = [...S.sel];
  if (ok.what === 'pl') { body.playlist_ids = [ok.pl]; body.track_ids = []; }
  if (ok.what === 'all') { body.all = true; body.track_ids = [...S.tracks.keys()]; }
  try {
    if (db) {
      const r = await api('/api/rekordbox/write', { body: { ...body, swap_processed: ok.proc } });
      toast(`Written to Rekordbox: ${r.keys} keys, ${r.cues} cues in ${r.tracks} tracks${r.swapped ? `, ${r.swapped} files swapped` : ''}${r.missing ? `. ${r.missing} tracks not found in Rekordbox` : ''}.`, { ms: 7000 });
    } else {
      const r = await api('/api/export/xml', { body: { ...body, use_processed: ok.proc } });
      toast(`XML with ${r.tracks} tracks saved <button class="mini-btn" type="button" onclick="revealPath('${esc(r.path).replace(/'/g, "\\'")}')">Show in Finder</button>`, { ms: 8000 });
    }
  } catch (e) { toast(e.message, { error: true, ms: 7000 }); }
}

/* ---------- keyboard ---------- */
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea') || !$('#dlgBack').hidden || e.metaKey || e.ctrlKey) return;
  const d = focused();
  const arrow = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
  if (e.code === 'Space') { e.preventDefault(); d.toggle(); }
  else if (/^Digit[1-8]$/.test(e.code)) d.padClick(parseInt(e.code.slice(5), 10) - 1, e);
  else if (e.key === 'g' || e.key === 'G') d.toggleGrid();
  else if (arrow && e.altKey && d.grid) { e.preventDefault(); d.gridShift(arrow * (e.shiftKey ? 0.001 : 0.005)); }
  // Arrows walk the grid (Shift = 4 beats): paused they land on the grid lines, playing they jump and keep the phase.
  else if (arrow) { e.preventDefault(); const n = arrow * (e.shiftKey ? 4 : 1); if (d.playing) d.jump(n); else d.stepGrid(n); }
  else if (e.key === 'Home') { e.preventDefault(); d.seek(0); }
  else if (e.key === 'Tab' && e.altKey) { e.preventDefault(); S.focus = S.focus === 'A' ? 'B' : 'A'; }
});

/* ---------- polling ---------- */
async function pollJobs() {
  try {
    const { jobs, counts } = await api('/api/jobs');
    const active = jobs.filter((j) => j.state === 'running' || j.state === 'queued');
    const ind = $('#jobsInd');
    ind.hidden = !active.length;
    if (active.length) {
      const running = jobs.filter((j) => j.state === 'running');
      const an = active.filter((j) => j.kind === 'analyze').length;
      const other = running.find((j) => j.kind !== 'analyze');
      $('#jobsTxt').textContent = other ? `${other.label} ${Math.round(other.progress * 100)} %` + (an ? ` · ${an} analyses` : '')
        : `${an} analyses pending`;
    }
    for (const j of jobs) {
      if (S.procJobs.has(j.id)) S.procJobs.set(j.id, j);
      if (j.kind === 'rbimport' && j.state === 'done' && S.waitImport) {
        S.waitImport = false; await loadState();
        toast(`Rekordbox loaded: ${j.result.tracks} tracks, ${j.result.playlists} playlists`);
      }
      if (j.kind === 'rbimport' && j.state === 'error' && S.waitImport) { S.waitImport = false; toast('Loading Rekordbox failed: ' + esc(j.error), { error: true, ms: 8000 }); }
    }
    if (S.tab === 'loud') renderProcList();
    Object.values(DECKS).forEach((d) => d.pollPending());
    void counts;
  } catch (e) { /* server restarting */ }
  setTimeout(pollJobs, 1000);
}
async function pollChanges() {
  try {
    const r = await api(`/api/changes?since=${S.since}`);
    S.since = r.now;
    if (r.tracks.length) {
      r.tracks.forEach((t) => {
        const old = S.tracks.get(t.id);
        if (old) { Object.assign(old, t); if (old._pend) Object.assign(old, old._pend); }
        else S.tracks.set(t.id, t);
        Object.values(DECKS).forEach((d) => { if (d.t && d.t.id === t.id) d.trackUpdated(S.tracks.get(t.id)); });
      });
      scheduleLibraryRender();
      if (S.tab === 'loud') renderLoudStats();
      if (S.tab === 'files') renderFs();
    }
  } catch (e) { /* ignore */ }
  setTimeout(pollChanges, 2000);
}

async function loadState() {
  const st = await api('/api/state');
  S.tracks = new Map(st.tracks.map((t) => [t.id, t]));
  S.playlists = st.playlists; S.settings = st.settings; S.presets = st.presets; S.stems = st.stems; S.mashups = st.mashups;
  S.since = Date.now() / 1000;
  renderLoudCtl(); renderPlaylists(); renderLibrary(); renderSaved();
  if (!S.tracks.size && S.tab === 'library') selectTab('files');
  Object.values(DECKS).forEach((d) => { if (d.t && S.tracks.has(d.t.id)) d.trackUpdated(S.tracks.get(d.t.id)); else d.render(); });
}

S.tab = 'library';
loadState().then(() => { pollJobs(); pollChanges(); }).catch((e) => toast('Server not reachable: ' + e.message, { error: true, ms: 10000 }));
