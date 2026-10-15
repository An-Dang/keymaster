const RB = (() => {
  const RB_KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const KIND = { mp3: 'MP3 File', wav: 'WAV File', m4a: 'M4A File', aac: 'M4A File', flac: 'FLAC File', aif: 'AIFF File', aiff: 'AIFF File', ogg: 'OGG File', opus: 'OPUS File' };

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function toLocation(base, rel) {
    const b = (base || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
    const r = String(rel).replace(/\\/g, '/').replace(/^\/+/, '');
    const full = b ? b + '/' + r : r;
    const enc = full.split('/').map((s, i) => (i === 0 && /^[A-Za-z]:$/.test(s)) ? s : encodeURIComponent(s)).join('/');
    return 'file://localhost' + (enc.startsWith('/') ? enc : '/' + enc);
  }

  function rbKey(key, notation) {
    if (notation === 'camelot') return key.code;
    return RB_KEYS[key.pc] + (key.mode === 'minor' ? 'm' : '');
  }

  function splitName(name) {
    const i = name.indexOf(' - ');
    return i > 0 ? { artist: name.slice(0, i).trim(), title: name.slice(i + 3).trim() } : { artist: '', title: name };
  }

  const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

  /**
   * tracks: [{name, relPath, size, duration, sampleRate, bpm, firstBeat, key, energy, cues:[{t,name}|null x8]}]
   * o: {base, notation, hotCues, memoryCues, grid, comments, playlist, colors}
   */
  function buildXml(tracks, o) {
    const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<DJ_PLAYLISTS Version="1.0.0">',
      '  <PRODUCT Name="Key Master" Version="1.0" Company=""/>',
      `  <COLLECTION Entries="${tracks.length}">`];
    tracks.forEach((t, i) => {
      const { artist, title } = splitName(t.name);
      const ext = (t.relPath.split('.').pop() || '').toLowerCase();
      const a = {
        TrackID: i + 1, Name: title, Artist: artist, Kind: KIND[ext] || (ext.toUpperCase() + ' File'),
        Size: t.size || 0, TotalTime: Math.round(t.duration), SampleRate: t.sampleRate || 44100,
        AverageBpm: t.bpm.toFixed(2), Tonality: rbKey(t.key, o.notation),
      };
      if (o.comments) a.Comments = `${t.key.code} - Energy ${t.energy}`;
      a.Location = toLocation(o.base, t.relPath);
      const attrs = Object.entries(a).map(([k, v]) => `${k}="${esc(v)}"`).join(' ');
      const kids = [];
      if (o.grid) kids.push(`      <TEMPO Inizio="${t.firstBeat.toFixed(3)}" Bpm="${t.bpm.toFixed(2)}" Metro="4/4" Battito="1"/>`);
      const cues = t.cues.map((c, n) => c && { ...c, n }).filter(Boolean);
      if (o.memoryCues) {
        [...cues].sort((x, y) => x.t - y.t).forEach((c) =>
          kids.push(`      <POSITION_MARK Name="${esc(c.name || '')}" Type="0" Start="${c.t.toFixed(3)}" Num="-1"/>`));
      }
      if (o.hotCues) {
        cues.forEach((c) => {
          const [r, g, b] = rgb(o.colors[c.n]);
          kids.push(`      <POSITION_MARK Name="${esc(c.name || '')}" Type="0" Start="${c.t.toFixed(3)}" Num="${c.n}" Red="${r}" Green="${g}" Blue="${b}"/>`);
        });
      }
      out.push(kids.length ? `    <TRACK ${attrs}>\n${kids.join('\n')}\n    </TRACK>` : `    <TRACK ${attrs}/>`);
    });
    out.push('  </COLLECTION>');
    if (o.playlist) {
      out.push('  <PLAYLISTS>', '    <NODE Type="0" Name="ROOT" Count="1">',
        `      <NODE Name="${esc(o.playlist)}" Type="1" KeyType="0" Entries="${tracks.length}">`);
      tracks.forEach((t, i) => out.push(`        <TRACK Key="${i + 1}"/>`));
      out.push('      </NODE>', '    </NODE>', '  </PLAYLISTS>');
    }
    out.push('</DJ_PLAYLISTS>');
    return out.join('\n') + '\n';
  }

  let CRC;
  function crc32(buf) {
    if (!CRC) {
      CRC = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; }
    }
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /** Single-file ZIP (stored, no compression). Returns Uint8Array. */
  function zipOne(filename, text) {
    const te = new TextEncoder(), data = te.encode(text), name = te.encode(filename), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true); lh.setUint16(10, 0, true); lh.setUint16(12, 33, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true); cd.setUint16(12, 0, true); cd.setUint16(14, 33, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
    cd.setUint16(28, name.length, true);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, 1, true); end.setUint16(10, 1, true);
    end.setUint32(12, 46 + name.length, true); end.setUint32(16, 30 + name.length + data.length, true);
    const parts = [new Uint8Array(lh.buffer), name, data, new Uint8Array(cd.buffer), name, new Uint8Array(end.buffer)];
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  return { buildXml, zipOne, toLocation, rbKey };
})();
if (typeof module !== 'undefined') module.exports = RB;
