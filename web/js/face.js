// Scrubgnome-Face (web) - photo metadata scrubber.
// JavaScript twin of core/ImageScrubber.java (and desktop hmd/face.py): same rules,
// byte-for-byte the same output. Runs entirely in the browser; nothing is uploaded.
// Author: kultrshok. MIT License.

export class UnsupportedFormatError extends Error {}

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');
const utf16 = new TextDecoder('utf-16le');
const enc = s => Uint8Array.from(s, c => c.charCodeAt(0) & 0xff);

const u8 = (d, i) => d[i];
const be16 = (d, i) => (d[i] << 8) | d[i + 1];
const be32 = (d, i) => ((d[i] << 24) >>> 0) + ((d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]);
const le16 = (d, i) => d[i] | (d[i + 1] << 8);
const le32 = (d, i) => (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16)) + d[i + 3] * 0x1000000;
const ascii = (d, o, n) => (o < 0 || o + n > d.length) ? '' : latin1.decode(d.subarray(o, o + n));
const startsWith = (d, o, p) => { if (o + p.length > d.length) return false; for (let i = 0; i < p.length; i++) if (d[o + i] !== p[i]) return false; return true; };
const slice = (d, a, b) => { a = Math.max(0, Math.min(a, d.length)); b = Math.max(a, Math.min(b, d.length)); return d.slice(a, b); };
const allZero = (d, a, b) => { for (let i = a; i < b && i < d.length; i++) if (d[i]) return false; return true; };
const shorten = v => { v = String(v).replace(/\u0000/g, '').trim(); return v.length <= 90 ? v : v.slice(0, 89) + '…'; };
const commas = n => n.toLocaleString('en-US');

class Bytes {   // tiny growable byte buffer
  constructor(n = 1024) { this.b = new Uint8Array(n); this.n = 0; }
  need(k) { if (this.n + k > this.b.length) { const nb = new Uint8Array(Math.max(this.b.length * 2, this.n + k)); nb.set(this.b.subarray(0, this.n)); this.b = nb; } }
  push(...xs) { this.need(xs.length); for (const x of xs) this.b[this.n++] = x & 0xff; }
  write(arr, a = 0, b = arr.length) { this.need(b - a); this.b.set(arr.subarray(a, b), this.n); this.n += b - a; }
  done() { return this.b.slice(0, this.n); }
}

const F = (cat, where, key, value) => ({ cat, where, key, value });

// ------------------------------------------------------------------ public API

export function sniff(d) {
  if (d.length >= 3 && d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff) return 'jpeg';
  if (d.length >= 8 && startsWith(d, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (d.length >= 12 && ascii(d, 0, 4) === 'RIFF' && ascii(d, 8, 4) === 'WEBP') return 'webp';
  if (d.length >= 6 && /^GIF8[79]a$/.test(ascii(d, 0, 6))) return 'gif';
  if (d.length >= 12 && ascii(d, 4, 4) === 'ftyp') {
    const b = ascii(d, 8, 4);
    if (b === 'avif' || b === 'avis') return 'avif';
    if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(b)) return 'heic';
  }
  return null;
}

const CAT_ORDER = ['location', 'time', 'identity', 'device', 'other'];
export function categories(findings) { return CAT_ORDER.filter(c => findings.some(f => f.cat === c)); }
export function score(findings) {
  const c = new Set(categories(findings));
  return Math.min(100, (c.has('location') ? 50 : 0) + (c.has('time') ? 35 : 0) + (c.has('identity') ? 30 : 0) + (c.has('device') ? 15 : 0));
}

export function scan(d) {
  const format = sniff(d);
  if (!format) throw new UnsupportedFormatError("That's not a photo format I know.");
  let findings;
  try {
    findings = { jpeg: jpegReport, png: pngReport, webp: webpReport, gif: gifReport }[format]?.(d) ?? heifReport(d);
  } catch (e) {
    throw new UnsupportedFormatError(`This ${format.toUpperCase()} looks damaged (${e.message}).`);
  }
  return { format, findings };
}

export function scrub(d) {
  const before = scan(d);
  let clean;
  try {
    clean = { jpeg: jpegStrip, png: pngStrip, webp: webpStrip, gif: gifStrip }[before.format]?.(d) ?? heifStrip(d);
  } catch (e) {
    throw new UnsupportedFormatError(`Couldn't take this ${before.format} apart safely (${e.message}).`);
  }
  return { clean, before };
}

const STAMP = /(?<!\d)(19|20)\d{2}[-_.]?[01]\d[-_.]?[0-3]\d(?:[ _T.-]*(?:at[ _])?[0-2]\d[-_.:]?[0-5]\d(?:[-_.:]?[0-5]\d)?)?/;
export const dateInName = name => (name || '').match(STAMP)?.[0] ?? null;
export const extensionFor = fmt => fmt === 'jpeg' ? '.jpg' : '.' + fmt;
export const mimeFor = fmt => 'image/' + fmt;

// ------------------------------------------------------------------ EXIF / TIFF

const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];
const TIME = { 0x0132: 'DateTime', 0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized', 0x9010: 'OffsetTime',
  0x9011: 'OffsetTimeOriginal', 0x9012: 'OffsetTimeDigitized', 0x9290: 'SubSecTime', 0x9291: 'SubSecTimeOriginal', 0x9292: 'SubSecTimeDigitized' };
const DEVICE = { 0x010F: 'Make', 0x0110: 'Model', 0x0131: 'Software', 0x013C: 'HostComputer', 0xA433: 'LensMake', 0xA434: 'LensModel', 0x927C: 'MakerNote' };
const IDENTITY = { 0x013B: 'Artist', 0x8298: 'Copyright', 0xA430: 'CameraOwnerName', 0xA431: 'BodySerialNumber',
  0xA435: 'LensSerialNumber', 0xA420: 'ImageUniqueID', 0x9C9D: 'XPAuthor' };
const OTHER = { 0x010E: 'ImageDescription', 0x9286: 'UserComment', 0x9C9C: 'XPComment', 0x9C9B: 'XPTitle', 0x9C9E: 'XPKeywords', 0x9C9F: 'XPSubject' };

// value kinds: {s: string} | {b: Uint8Array} | {n: number[]}
function parseTiff(t) {
  const out = [];
  if (t.length < 8) return out;
  let le;
  if (t[0] === 0x49 && t[1] === 0x49) le = true; else if (t[0] === 0x4d && t[1] === 0x4d) le = false; else return out;
  const r16 = o => le ? le16(t, o) : be16(t, o), r32 = o => le ? le32(t, o) : be32(t, o);
  const seen = new Set();
  const value = (type, cnt, rawOff) => {
    const unit = type >= 1 && type < TYPE_SIZE.length ? TYPE_SIZE[type] : 1;
    const size = unit * cnt;
    if (cnt > 1e6) return null;
    const off = size <= 4 ? rawOff : r32(rawOff);
    if (off < 0 || off + size > t.length) return null;
    switch (type) {
      case 2: { let e = off; while (e < off + size && t[e] !== 0) e++; return { s: latin1.decode(t.subarray(off, e)) }; }
      case 3: case 8: { const r = []; for (let i = 0; i < cnt; i++) { const v = r16(off + 2 * i); r.push(type === 8 ? (v << 16) >> 16 : v); } return { n: r }; }
      case 4: case 9: case 13: { const r = []; for (let i = 0; i < cnt; i++) { const v = r32(off + 4 * i); r.push(type === 9 ? v | 0 : v); } return { n: r }; }
      case 5: case 10: {
        const r = [];
        for (let i = 0; i < cnt; i++) {
          let n = r32(off + 8 * i), d = r32(off + 8 * i + 4);
          if (type === 10) { n |= 0; d |= 0; }
          r.push(d === 0 ? 0 : n / d);
        }
        return { n: r, rational: true };
      }
      default: return { b: slice(t, off, off + size) };
    }
  };
  const walk = (off, name, depth) => {
    if (depth > 4 || off < 8 || off + 2 > t.length || seen.has(off)) return 0;
    seen.add(off);
    const n = r16(off);
    if (n > 1000 || off + 2 + 12 * n + 4 > t.length) return 0;
    for (let k = 0; k < n; k++) {
      const e = off + 2 + 12 * k;
      const tag = r16(e), type = r16(e + 2), cnt = r32(e + 4);
      const v = value(type, cnt, e + 8);
      out.push({ ifd: name, tag, type, value: v });
      if ((tag === 0x8769 || tag === 0x8825) && v?.n && v.n.length === 1 && !v.rational)
        walk(v.n[0], tag === 0x8769 ? 'Exif' : 'GPS', depth + 1);
    }
    return r32(off + 2 + 12 * n);
  };
  try {
    const next = walk(r32(4), 'IFD0', 0);
    if (next > 0) walk(next, 'IFD1', 0);
  } catch { /* truncated EXIF: keep what we have */ }
  return out;
}

const fmtNum = x => Number.isInteger(x) ? String(x) : x.toFixed(4);
function show(v) {
  if (!v) return '';
  if ('s' in v) return v.s;
  if ('n' in v) return v.n.length === 1 ? fmtNum(v.n[0]) : '[' + v.n.map(fmtNum).join(', ') + ']';
  return `${v.b.length} bytes`;
}
const xp = v => v?.b ? utf16.decode(v.b).replace(/\u0000/g, '') : show(v);
function dms(v, ref) {
  if (!v?.n || v.n.length !== 3) return null;
  const x = v.n[0] + v.n[1] / 60 + v.n[2] / 3600;
  const r = ref?.s ?? '';
  return (r === 'S' || r === 'W') ? -x : x;
}

function exifFindings(tiff, where) {
  const f = [], gps = new Map();
  let settings = 0;
  for (const e of parseTiff(tiff)) {
    if (e.ifd === 'GPS') { gps.set(e.tag, e.value); continue; }
    if (e.ifd === 'IFD1') { if (e.tag === 0x0201) f.push(F('other', where, 'embedded thumbnail', 'preview image - can still show the uncropped original')); continue; }
    const tag = e.tag;
    if ([0x8769, 0x8825, 0xA005, 0x0112].includes(tag)) continue;
    if (TIME[tag]) f.push(F('time', where, TIME[tag], shorten(show(e.value))));
    else if (DEVICE[tag]) {
      f.push(F('device', where, DEVICE[tag], tag === 0x927C && e.value?.b
        ? `vendor data blob (${e.value.b.length} bytes) - can hold serial numbers` : shorten(show(e.value))));
    } else if (IDENTITY[tag]) f.push(F('identity', where, IDENTITY[tag], shorten(tag === 0x9C9D ? xp(e.value) : show(e.value))));
    else if (OTHER[tag]) {
      let val;
      if (tag >= 0x9C9B) val = xp(e.value);
      else if (e.value?.b) { const b = e.value.b; val = tag === 0x9286 ? latin1.decode(b.subarray(Math.min(8, b.length))) : latin1.decode(b); }
      else val = show(e.value);
      if (val.replace(/\u0000/g, '').trim()) f.push(F('other', where, OTHER[tag], shorten(val)));
    } else if (e.ifd === 'Exif') settings++;
  }
  if (gps.size) {
    const lat = dms(gps.get(2), gps.get(1)), lon = dms(gps.get(4), gps.get(3));
    if (lat !== null && lon !== null) {
      let pos;
      if (lat === 0 && lon === 0) pos = 'present (coordinates zeroed or hidden by the phone)';
      else {
        pos = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
        const alt = gps.get(6);
        if (alt?.n && alt.n.length === 1) pos += ` (alt ${alt.n[0].toFixed(0)} m)`;
      }
      f.push(F('location', where, 'GPS position', pos));
    } else if ([1, 2, 3, 4].some(k => gps.has(k))) f.push(F('location', where, 'GPS position', 'present'));
    if (gps.has(29) || gps.has(7)) {
      const d = gps.has(29) ? show(gps.get(29)) : '', t = gps.has(7) ? show(gps.get(7)) : '';
      f.push(F('time', where, 'GPS date/time', shorten(`${d} ${t}`.trim())));
    }
    const extra = [...gps.keys()].filter(k => k > 7 && k !== 29).length;
    if (extra) f.push(F('location', where, 'GPS extras', `${extra} more GPS fields (speed, direction, method...)`));
  }
  if (settings) f.push(F('other', where, 'camera settings', `${settings} technical tags (exposure, ISO, focal length...)`));
  return f;
}

function exifOrientation(tiff) {
  for (const e of parseTiff(tiff))
    if (e.ifd === 'IFD0' && e.tag === 0x0112 && e.value?.n?.length === 1 && e.value.n[0] >= 1 && e.value.n[0] <= 8) return e.value.n[0];
  return 1;
}
const minimalExif = o => Uint8Array.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0]);

// ------------------------------------------------------------------ XMP / IPTC

const XMP_SKIP = new Set(['xmlns', 'rdf', 'x', 'xml', 'stEvt', 'stRef']);
function xmpCat(p, n) {
  const k = `${p}:${n}`.toLowerCase();
  if (/gps|latitude|longitude|altitude|location|city|state|country|sublocation|province/.test(k)) return 'location';
  if (/creator\b|author|owner|by-?line|rights|copyright|serial|usage|credit|marked/.test(k)) return 'identity';
  if (/date|time|when/.test(k)) return 'time';
  if (/make|model|lens|creatortool|software|agent|camera/.test(k)) return 'device';
  return 'other';
}
function xmpFindings(x, where) {
  const f = [], seen = new Set();
  const hist = (x.match(/stEvt:action/g) || []).length;
  for (const rx of [/\b([A-Za-z][\w.-]*):([A-Za-z][\w.-]*)="([^"]*)"/g, /<([A-Za-z][\w.-]*):([A-Za-z][\w.-]*)>([^<]+)<\/\1:\2>/g]) {
    for (const m of x.matchAll(rx)) {
      const [, p, n] = m, v = m[3].trim(), key = `${p}:${n}`;
      if (XMP_SKIP.has(p) || !v || seen.has(key)) continue;
      seen.add(key);
      if ((p === 'GCamera' || p === 'Camera') && /MotionPhoto|MicroVideo/.test(n)) { f.push(F('other', where, key, 'motion photo (hidden video attached)')); continue; }
      f.push(F(xmpCat(p, n), where, key, shorten(v)));
    }
  }
  for (const m of x.matchAll(/<([A-Za-z][\w.-]*):([A-Za-z][\w.-]*)>\s*<rdf:(?:Seq|Bag|Alt)>([\s\S]*?)<\/rdf:/g)) {
    const [, p, n] = m, key = `${p}:${n}`;
    const vals = [...m[3].matchAll(/<rdf:li[^>]*>([^<]*)<\/rdf:li>/g)].map(v => v[1]);
    if (vals.length && !XMP_SKIP.has(p) && !seen.has(key)) { seen.add(key); f.push(F(xmpCat(p, n), where, key, shorten(vals.join('; ')))); }
  }
  if (hist) f.push(F('time', where, 'edit history', `${hist} saved edit steps (with timestamps + app names)`));
  return f;
}

const IPTC = { 5: ['other', 'ObjectName'], 25: ['other', 'Keywords'], 55: ['time', 'DateCreated'], 60: ['time', 'TimeCreated'],
  62: ['time', 'DigitalCreationDate'], 63: ['time', 'DigitalCreationTime'], 80: ['identity', 'By-line'], 85: ['identity', 'By-lineTitle'],
  90: ['location', 'City'], 92: ['location', 'Sublocation'], 95: ['location', 'Province-State'], 100: ['location', 'CountryCode'],
  101: ['location', 'Country'], 110: ['identity', 'Credit'], 115: ['identity', 'Source'], 116: ['identity', 'Copyright'],
  118: ['identity', 'Contact'], 120: ['other', 'Caption'], 122: ['identity', 'Writer-Editor'] };
function iptcFindings(p) {
  const f = [];
  let i = -1;
  for (let k = 0; k + 1 < p.length; k++) if (p[k] === 0x1c && p[k + 1] === 0x02) { i = k; break; }
  while (i >= 0 && i + 5 <= p.length && p[i] === 0x1c) {
    const rec = p[i + 1], ds = p[i + 2], ln = be16(p, i + 3);
    if (rec === 2 && IPTC[ds]) f.push(F(IPTC[ds][0], 'IPTC', IPTC[ds][1], shorten(utf8.decode(p.subarray(i + 5, Math.min(p.length, i + 5 + ln))))));
    i += 5 + ln;
  }
  if (!f.length && latin1.decode(p).includes('8BIM')) f.push(F('other', 'IPTC', 'Photoshop resources', 'editor data block'));
  return f;
}

// ------------------------------------------------------------------ JPEG

function jpegSegments(b) {
  if (b.length < 2 || b[0] !== 0xff || b[1] !== 0xd8) throw new Error('not a JPEG');
  const segs = [{ marker: 0xd8, start: 0, end: 2, payload: new Uint8Array(0) }];
  let i = 2; const n = b.length;
  while (i < n) {
    if (b[i] !== 0xff) throw new Error(`corrupt JPEG at byte ${i}`);
    while (i < n && b[i] === 0xff) i++;
    if (i >= n) break;
    const m = b[i], start = i - 1;
    i++;
    if (m === 0xd9) {
      segs.push({ marker: 0xd9, start, end: i, payload: new Uint8Array(0) });
      if (i < n) segs.push({ marker: -1, start: i, end: n, payload: b.subarray(i, n), trail: true });
      return segs;
    }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { segs.push({ marker: m, start, end: i, payload: new Uint8Array(0) }); continue; }
    if (i + 2 > n) throw new Error('truncated JPEG');
    const ln = be16(b, i);
    let end = i + ln;
    if (end > n) throw new Error('truncated JPEG segment');
    const payload = b.subarray(i + 2, end);
    if (m === 0xda) {
      let j = end;
      for (;;) {
        while (j < n && b[j] !== 0xff) j++;
        if (j + 1 >= n) { j = n; break; }
        const nx = b[j + 1];
        if (nx === 0x00 || (nx >= 0xd0 && nx <= 0xd7)) { j += 2; continue; }
        if (nx === 0xff) { j += 1; continue; }
        break;
      }
      end = j;
    }
    segs.push({ marker: m, start, end, payload });
    i = end;
  }
  return segs;
}

const SIG = { jfif: enc('JFIF\0'), jfxx: enc('JFXX\0'), exif: enc('Exif\0\0'), xmp: enc('http://ns.adobe.com/xap/1.0/\0'),
  xmpext: enc('http://ns.adobe.com/xmp/extension/'), icc: enc('ICC_PROFILE\0'), mpf: enc('MPF\0'), adobe: enc('Adobe') };
function appKind(m, p) {
  if (m === 0xe0 && startsWith(p, 0, SIG.jfif)) return 'jfif';
  if (m === 0xe0 && startsWith(p, 0, SIG.jfxx)) return 'jfxx';
  if (m === 0xe1 && startsWith(p, 0, SIG.exif)) return 'exif';
  if (m === 0xe1 && startsWith(p, 0, SIG.xmp)) return 'xmp';
  if (m === 0xe1 && startsWith(p, 0, SIG.xmpext)) return 'xmpext';
  if (m === 0xe2 && startsWith(p, 0, SIG.icc)) return 'icc';
  if (m === 0xe2 && startsWith(p, 0, SIG.mpf)) return 'mpf';
  if (m === 0xed) return 'iptc';
  if (m === 0xeb) return 'jumbf';
  if (m === 0xee && startsWith(p, 0, SIG.adobe)) return 'adobe';
  if (m === 0xfe) return 'comment';
  if (m >= 0xe0 && m <= 0xef) return 'app' + (m - 0xe0);
  return null;
}

function jpegReport(b) {
  const f = [];
  for (const s of jpegSegments(b)) {
    if (s.trail) {
      if (allZero(s.payload, 0, s.payload.length)) continue;
      const head = ascii(s.payload, 0, Math.min(64, s.payload.length));
      const what = head.includes('ftyp') ? 'hidden video (motion photo)'
        : (s.payload.length > 1 && s.payload[0] === 0xff && s.payload[1] === 0xd8) ? 'extra image (HDR gain map / depth)' : 'unknown data';
      f.push(F('other', 'after image end', 'trailing data', `${commas(s.payload.length)} bytes - ${what}`));
      continue;
    }
    const k = appKind(s.marker, s.payload);
    if (!k) continue;
    if (k === 'exif') f.push(...exifFindings(s.payload.subarray(6), 'EXIF'));
    else if (k === 'xmp' || k === 'xmpext') f.push(...xmpFindings(utf8.decode(s.payload), 'XMP'));
    else if (k === 'iptc') f.push(...iptcFindings(s.payload));
    else if (k === 'mpf') f.push(F('other', 'MPF', 'multi-picture index', 'points at extra images stored in the file'));
    else if (k === 'jumbf') f.push(F('device', 'C2PA/JUMBF', 'content credentials', 'signed capture/edit record (device, app, sometimes time)'));
    else if (k === 'comment') f.push(F('other', 'JPEG comment', 'comment', shorten(latin1.decode(s.payload))));
    else if (k === 'jfxx') f.push(F('other', 'JFXX', 'embedded thumbnail', 'preview image'));
    else if (k.startsWith('app') && k !== 'app0') f.push(F('other', k.toUpperCase(), 'vendor block', `${s.payload.length} bytes`));
  }
  return f;
}

function jpegStrip(b) {
  const segs = jpegSegments(b);
  let orient = 1;
  for (const s of segs) if (!s.trail && appKind(s.marker, s.payload) === 'exif') { orient = exifOrientation(s.payload.subarray(6)); break; }
  const out = new Bytes(b.length);
  out.push(0xff, 0xd8);
  let exifDone = orient === 1;
  for (const s of segs) {
    if (s.marker === 0xd8 || s.trail) continue;
    const k = appKind(s.marker, s.payload);
    if (k === 'jfif') { out.write(b, s.start, s.end); continue; }
    if (!exifDone && k === null) {
      const tiff = minimalExif(orient), len = tiff.length + 8;
      out.push(0xff, 0xe1, len >> 8, len & 0xff);
      out.write(SIG.exif); out.write(tiff);
      exifDone = true;
    }
    if (k === 'icc' || k === 'adobe' || k === null) out.write(b, s.start, s.end);
    if (s.marker === 0xd9) break;
  }
  return out.done();
}

// ------------------------------------------------------------------ PNG

function pngChunks(b) {
  const r = [];
  let i = 8;
  while (i + 8 <= b.length) {
    const ln = be32(b, i), t = ascii(b, i + 4, 4);
    if (i + 12 + ln > b.length) throw new Error(`truncated PNG chunk ${t}`);
    r.push({ type: t, data: b.subarray(i + 8, i + 8 + ln), start: i, end: i + 12 + ln });
    i += 12 + ln;
    if (t === 'IEND') {
      if (i < b.length && !allZero(b, i, b.length)) r.push({ type: 'TRAIL', data: b.subarray(i), start: i, end: b.length });
      break;
    }
  }
  return r;
}
const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME', 'caBX', 'dSIG']);

// zTXt / compressed iTXt need inflate; only used for the REPORT, never for the scrub.
let inflateSync = null;
export function setInflate(fn) { inflateSync = fn; }   // node self-test plugs in zlib.inflateSync
function pngText(type, d) {
  try {
    const z = d.indexOf(0);
    const key = latin1.decode(d.subarray(0, z));
    if (type === 'tEXt') return [key, latin1.decode(d.subarray(z + 1))];
    if (type === 'zTXt') return [key, inflateSync ? latin1.decode(inflateSync(d.subarray(z + 2))) : '(compressed text)'];
    const comp = d[z + 1];
    const lz = d.indexOf(0, z + 3), tz = d.indexOf(0, lz + 1);
    if (lz < 0 || tz < 0) throw new Error('bad iTXt');
    let txt = d.subarray(tz + 1);
    if (comp) { if (!inflateSync) return [key, '(compressed text)']; txt = inflateSync(txt); }
    return [key, utf8.decode(txt)];
  } catch { return ['?', '']; }
}

function pngReport(b) {
  const f = [];
  for (const c of pngChunks(b)) {
    if (c.type === 'tEXt' || c.type === 'zTXt' || c.type === 'iTXt') {
      const [k, v] = pngText(c.type, c.data), kl = k.toLowerCase();
      if (k === 'XML:com.adobe.xmp') f.push(...xmpFindings(v, 'XMP'));
      else if (kl.startsWith('raw profile type exif')) f.push(F('other', 'PNG text', k, 'hex-encoded EXIF block (ImageMagick)'));
      else {
        const cat = ['author', 'copyright', 'disclaimer', 'source'].includes(kl) ? 'identity'
          : (kl.includes('time') || kl.includes('date')) ? 'time' : kl === 'software' ? 'device' : 'other';
        f.push(F(cat, 'PNG text', k, shorten(v)));
      }
    } else if (c.type === 'eXIf') f.push(...exifFindings(c.data, 'EXIF'));
    else if (c.type === 'tIME' && c.data.length >= 7) {
      const p = x => String(x).padStart(2, '0');
      f.push(F('time', 'PNG', 'tIME (last modified)', `${String(be16(c.data, 0)).padStart(4, '0')}-${p(c.data[2])}-${p(c.data[3])} ${p(c.data[4])}:${p(c.data[5])}:${p(c.data[6])}`));
    } else if (c.type === 'caBX') f.push(F('device', 'C2PA', 'content credentials', 'signed capture/edit record'));
    else if (c.type === 'TRAIL') f.push(F('other', 'after image end', 'trailing data', `${commas(c.data.length)} bytes`));
  }
  return f;
}

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (...parts) => { let c = 0xffffffff; for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function pngChunk(type, data) {
  const o = new Bytes(data.length + 12), t = enc(type), n = data.length, c = crc32(t, data);
  o.push(n >>> 24, n >>> 16, n >>> 8, n); o.write(t); o.write(data); o.push(c >>> 24, c >>> 16, c >>> 8, c);
  return o.done();
}

function pngStrip(b) {
  const cs = pngChunks(b);
  let orient = 1;
  for (const c of cs) if (c.type === 'eXIf') orient = exifOrientation(c.data);
  const out = new Bytes(b.length);
  out.write(b, 0, 8);
  for (const c of cs) {
    if (c.type === 'TRAIL' || PNG_DROP.has(c.type)) continue;
    if (c.type === 'IDAT' && orient !== 1) { out.write(pngChunk('eXIf', minimalExif(orient))); orient = 1; }
    out.write(b, c.start, c.end);
  }
  return out.done();
}

// ------------------------------------------------------------------ WebP

function riffChunks(b) {
  const r = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const cc = ascii(b, i, 4), ln = le32(b, i + 4), pad = ln & 1;
    if (i + 8 + ln > b.length) throw new Error(`truncated WebP chunk ${cc}`);
    const end = Math.min(b.length, i + 8 + ln + pad);
    r.push({ type: cc, data: b.subarray(i + 8, i + 8 + ln), start: i, end });
    i = end;
  }
  return r;
}
const exifPayload = d => startsWith(d, 0, SIG.exif) ? d.subarray(6) : d;

function webpReport(b) {
  const f = [];
  for (const c of riffChunks(b)) {
    if (c.type === 'EXIF') f.push(...exifFindings(exifPayload(c.data), 'EXIF'));
    else if (c.type === 'XMP ') f.push(...xmpFindings(utf8.decode(c.data), 'XMP'));
  }
  return f;
}

function webpStrip(b) {
  const cs = riffChunks(b);
  let orient = 1, vp8x = false;
  for (const c of cs) { if (c.type === 'EXIF') orient = exifOrientation(exifPayload(c.data)); if (c.type === 'VP8X') vp8x = true; }
  const keepExif = orient !== 1 && vp8x;
  const body = new Bytes(b.length);
  for (const c of cs) {
    if (c.type === 'EXIF' || c.type === 'XMP ') continue;
    if (c.type === 'VP8X' && c.data.length >= 1) {
      const raw = slice(b, c.start, c.end);
      let flags = c.data[0] & ~0x0c;
      if (keepExif) flags |= 0x08;
      raw[8] = flags;
      body.write(raw);
    } else body.write(b, c.start, c.end);
  }
  if (keepExif) {
    const ex = minimalExif(orient), n = ex.length;
    body.write(enc('EXIF')); body.push(n, n >>> 8, n >>> 16, n >>> 24); body.write(ex);
    if (n & 1) body.push(0);
  }
  const payload = body.done(), total = payload.length + 4;
  const out = new Bytes(total + 8);
  out.write(enc('RIFF')); out.push(total, total >>> 8, total >>> 16, total >>> 24); out.write(enc('WEBP')); out.write(payload);
  return out.done();
}

// ------------------------------------------------------------------ GIF

function gifBlocks(b) {
  const r = [];
  const flags = b[10];
  let i = 13 + ((flags & 0x80) ? 3 * (2 << (flags & 7)) : 0);
  r.push({ kind: 'header', start: 0, end: i });
  const n = b.length;
  while (i < n) {
    const t = b[i], start = i;
    if (t === 0x3b) {
      r.push({ kind: 'trailer', start: i, end: i + 1 });
      if (i + 1 < n && !allZero(b, i + 1, n)) r.push({ kind: 'trail', start: i + 1, end: n });
      return r;
    }
    if (t === 0x21) {
      const label = b[i + 1];
      i += 2;
      let app = '';
      if (label === 0xff && i < n) app = ascii(b, i + 1, Math.min(11, b[i]));
      while (i < n && b[i] !== 0) i += 1 + b[i];
      i += 1;
      r.push({ kind: `ext:${label.toString(16).toUpperCase().padStart(2, '0')}:${app}`, start, end: Math.min(i, n) });
    } else if (t === 0x2c) {
      const fl = b[i + 9];
      i += 10 + ((fl & 0x80) ? 3 * (2 << (fl & 7)) : 0);
      i += 1;
      while (i < n && b[i] !== 0) i += 1 + b[i];
      i += 1;
      r.push({ kind: 'image', start, end: Math.min(i, n) });
    } else throw new Error(`corrupt GIF at byte ${i}`);
  }
  return r;
}
const gifKeepApp = app => ['NETSCAPE2.0', 'ANIMEXTS1.0', 'ICCRGBG1012'].some(k => app.startsWith(k));

function gifReport(b) {
  const f = [];
  for (const k of gifBlocks(b)) {
    if (k.kind.startsWith('ext:FE')) {
      let s = '', i = k.start + 2;
      while (i < k.end && b[i] !== 0) { const l = b[i]; s += ascii(b, i + 1, Math.min(l, k.end - i - 1)); i += 1 + l; }
      f.push(F('other', 'GIF', 'comment', shorten(s)));
    } else if (k.kind.startsWith('ext:FF')) {
      const app = k.kind.slice(7);
      if (app.startsWith('XMP DataXMP')) f.push(...xmpFindings(utf8.decode(b.subarray(k.start, k.end)), 'XMP'));
      else if (!gifKeepApp(app)) f.push(F('other', 'GIF', 'application block', app.trim()));
    } else if (k.kind === 'trail') f.push(F('other', 'after image end', 'trailing data', `${commas(k.end - k.start)} bytes`));
  }
  return f;
}

function gifStrip(b) {
  const out = new Bytes(b.length);
  for (const k of gifBlocks(b)) {
    if (k.kind === 'trail' || k.kind.startsWith('ext:FE')) continue;
    if (k.kind.startsWith('ext:FF') && !gifKeepApp(k.kind.slice(7))) continue;
    out.write(b, k.start, k.end);
  }
  return out.done();
}

// ------------------------------------------------------------------ HEIF / AVIF

const readN = (d, off, size) => { let v = 0; for (let i = 0; i < size; i++) v = v * 256 + d[off + i]; return v; };

function heifItems(d) {
  let meta = -1, metaEnd = -1, i = 0;
  while (i + 8 <= d.length) {
    let size = be32(d, i), hdr = 8;
    const t = ascii(d, i + 4, 4);
    if (size === 1) { size = readN(d, i + 8, 8); hdr = 16; } else if (size === 0) size = d.length - i;
    if (size < hdr || i + size > d.length) break;
    if (t === 'meta') { meta = i + hdr + 4; metaEnd = i + size; break; }
    i += size;
  }
  const byId = new Map();
  if (meta < 0) return [];
  let ilocAt = -1, ilocEnd = -1, idatAt = -1, j = meta;
  while (j + 8 <= metaEnd) {
    const size = be32(d, j), t = ascii(d, j + 4, 4);
    if (size < 8 || j + size > metaEnd) break;
    const body = j + 8, end = j + size;
    if (t === 'iinf') {
      const v = d[body];
      let p = body + 4;
      const cnt = v === 0 ? be16(d, p) : be32(d, p);
      p += v === 0 ? 2 : 4;
      for (let k = 0; k < cnt && p + 8 <= end; k++) {
        const isz = be32(d, p);
        if (isz < 8 || p + isz > end || ascii(d, p + 4, 4) !== 'infe') break;
        const iv = d[p + 8];
        let q = p + 12;
        if (iv >= 2) {
          const id = iv === 2 ? be16(d, q) : be32(d, q);
          q += (iv === 2 ? 2 : 4) + 2;
          const type = ascii(d, q, 4);
          q += 4;
          let nz = q; while (nz < p + isz && d[nz] !== 0) nz++;
          q = nz + 1;
          let ct = null;
          if (type === 'mime' && q < p + isz) { let cz = q; while (cz < p + isz && d[cz] !== 0) cz++; ct = ascii(d, q, cz - q).toLowerCase(); }
          byId.set(id, { id, type, ct, extents: [] });
        }
        p += isz;
      }
    } else if (t === 'iloc') { ilocAt = body; ilocEnd = end; } else if (t === 'idat') idatAt = body;
    j = end;
  }
  if (ilocAt < 0) return [];
  const v = d[ilocAt];
  let p = ilocAt + 4;
  const offSize = d[p] >> 4, lenSize = d[p] & 15, baseSize = d[p + 1] >> 4, idxSize = (v === 1 || v === 2) ? (d[p + 1] & 15) : 0;
  p += 2;
  const count = v < 2 ? be16(d, p) : be32(d, p);
  p += v < 2 ? 2 : 4;
  for (let k = 0; k < count && p < ilocEnd; k++) {
    const id = v < 2 ? be16(d, p) : be32(d, p);
    p += v < 2 ? 2 : 4;
    let method = 0;
    if (v === 1 || v === 2) { method = be16(d, p) & 15; p += 2; }
    p += 2;
    const base = readN(d, p, baseSize); p += baseSize;
    const ext = be16(d, p); p += 2;
    const it = byId.get(id);
    for (let e = 0; e < ext; e++) {
      p += idxSize;
      const eo = readN(d, p, offSize); p += offSize;
      let el = readN(d, p, lenSize); p += lenSize;
      if (!it) continue;
      let abs;
      if (method === 0) abs = base + eo; else if (method === 1 && idatAt >= 0) abs = idatAt + base + eo; else continue;
      if (el === 0) el = d.length - abs;
      if (abs >= 0 && abs + el <= d.length) it.extents.push([abs, el]);
    }
  }
  const isExif = it => it.type === 'Exif';
  const isXmp = it => it.type === 'mime' && it.ct && (it.ct.includes('rdf+xml') || it.ct.includes('xmp'));
  return [...byId.values()].filter(it => (isExif(it) || isXmp(it)) && it.extents.length)
    .map(it => ({ ...it, exif: isExif(it) })).sort((a, b) => a.id - b.id);
}

function gather(d, it) {
  const o = new Bytes();
  for (const [a, l] of it.extents) o.write(d, a, a + l);
  return o.done();
}

function heifTiff(item) {
  if (item.length < 4) return new Uint8Array(0);
  const isTiff = k => (item[k] === 0x49 && item[k + 1] === 0x49 && item[k + 2] === 0x2a) || (item[k] === 0x4d && item[k + 1] === 0x4d && item[k + 3] === 0x2a);
  const s = Math.min(item.length, 4 + be32(item, 0));
  for (let k = s; k + 4 <= item.length && k < s + 16; k++) if (isTiff(k)) return item.subarray(k);
  for (let k = 0; k + 4 <= item.length && k < 64; k++) if (isTiff(k)) return item.subarray(k);
  return new Uint8Array(0);
}

function heifReport(d) {
  const f = [];
  for (const it of heifItems(d)) {
    const data = gather(d, it);
    if (it.exif) f.push(...exifFindings(heifTiff(data), 'EXIF'));
    else f.push(...xmpFindings(utf8.decode(data), 'XMP'));
  }
  return f;
}

const EMPTY_TIFF = Uint8Array.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0]);
const EMPTY_XMP = enc('<x:xmpmeta xmlns:x="adobe:ns:meta/"/>');

function heifStrip(d) {
  const out = d.slice();
  for (const it of heifItems(d)) {
    const total = it.extents.reduce((s, [, l]) => s + l, 0);
    const repl = new Uint8Array(total);
    if (it.exif && total >= 4 + EMPTY_TIFF.length) repl.set(EMPTY_TIFF, 4);
    else if (!it.exif) { repl.fill(0x20); if (total >= EMPTY_XMP.length) repl.set(EMPTY_XMP, 0); }
    let p = 0;
    for (const [a, l] of it.extents) { out.set(repl.subarray(p, p + l), a); p += l; }
  }
  return out;
}
