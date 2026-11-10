// zip.js - tiny ZIP reader/writer for Scrubgnome-File (no libraries).
// Reads stored + deflated members; writes a fresh archive with neutral metadata:
// every entry dated 1980-01-01 00:00, no extra fields (no OS owner IDs or precise
// file times), no comments. Uses the browser's built-in (De)CompressionStream,
// which Safari 16.4+, Android WebView and Node 22 all have.
// Author: kultrshok. MIT License.

export class ZipError extends Error {}

const le16 = (d, i) => d[i] | (d[i + 1] << 8);
const le32 = (d, i) => (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16)) + d[i + 3] * 0x1000000;
const utf8 = new TextDecoder('utf-8');
const cp437 = new TextDecoder('latin1');   // close enough for the ASCII names zips really use
const enc = new TextEncoder();

async function pipe(bytes, stream) {
  const s = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(s).arrayBuffer());
}
export const inflateRaw = d => pipe(d, new DecompressionStream('deflate-raw'));
export const deflateRaw = d => pipe(d, new CompressionStream('deflate-raw'));

let CRC_TABLE;
export function crc32(d) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) c = CRC_TABLE[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function isZip(d) {
  return d.length >= 4 && d[0] === 0x50 && d[1] === 0x4b && d[2] === 0x03 && d[3] === 0x04;
}

/**
 * Read every member. Returns { entries: [{name, data, dir, date, extra, method}], comment }.
 * Throws ZipError for encrypted, ZIP64 or unsupported compression.
 */
export async function readZip(d) {
  let eocd = -1;
  for (let i = d.length - 22; i >= Math.max(0, d.length - 22 - 65535); i--) {
    if (d[i] === 0x50 && d[i + 1] === 0x4b && d[i + 2] === 0x05 && d[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('not a complete zip (no central directory)');
  const count = le16(d, eocd + 10), cdOff = le32(d, eocd + 16), commentLen = le16(d, eocd + 20);
  if (count === 0xffff || cdOff === 0xffffffff) throw new ZipError('ZIP64 archives are not supported here');
  const comment = d.subarray(eocd + 22, eocd + 22 + commentLen);
  const entries = [];
  let p = cdOff;
  for (let k = 0; k < count; k++) {
    if (le32(d, p) !== 0x02014b50) throw new ZipError('damaged central directory');
    const flags = le16(d, p + 8), method = le16(d, p + 10), time = le16(d, p + 12), date = le16(d, p + 14);
    const csize = le32(d, p + 20), nlen = le16(d, p + 28), elen = le16(d, p + 30), clen = le16(d, p + 32);
    const lho = le32(d, p + 42);
    const rawName = d.subarray(p + 46, p + 46 + nlen);
    const name = (flags & 0x800 ? utf8 : cp437).decode(rawName);
    const cExtra = elen > 0;
    p += 46 + nlen + elen + clen;
    if (flags & 1) throw new ZipError('password-protected zip: can\'t look inside it');
    if (le32(d, lho) !== 0x04034b50) throw new ZipError('damaged local header');
    const lnlen = le16(d, lho + 26), lelen = le16(d, lho + 28);
    const start = lho + 30 + lnlen + lelen;
    const raw = d.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await inflateRaw(raw);
    else throw new ZipError(`unsupported compression (method ${method}) in ${name}`);
    entries.push({ name, data, dir: name.endsWith('/'), date: (date << 16) | time, extra: cExtra || lelen > 0, method });
  }
  return { entries, comment };
}

const DOS_1980 = 0x0021;   // 1980-01-01, time 00:00:00

/**
 * Write a zip. entries: [{name, data, store?}]. Members are deflated unless `store`
 * is set or deflating doesn't help. Dates are fixed, extras and comments omitted.
 */
export async function writeZip(entries) {
  const parts = [], central = [];
  let off = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const ascii = name.every(b => b < 0x80);
    const crc = crc32(e.data);
    let method = 0, body = e.data;
    if (!e.store && e.data.length > 0) {
      const z = await deflateRaw(e.data);
      if (z.length < e.data.length) { method = 8; body = z; }
    }
    const flags = ascii ? 0 : 0x800;
    const lh = new Uint8Array(30 + name.length);
    const v = new DataView(lh.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, flags, true);
    v.setUint16(8, method, true); v.setUint16(10, 0, true); v.setUint16(12, DOS_1980, true);
    v.setUint32(14, crc, true); v.setUint32(18, body.length, true); v.setUint32(22, e.data.length, true);
    v.setUint16(26, name.length, true); v.setUint16(28, 0, true);
    lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length);
    const c = new DataView(ch.buffer);
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
    c.setUint16(8, flags, true); c.setUint16(10, method, true); c.setUint16(12, 0, true);
    c.setUint16(14, DOS_1980, true); c.setUint32(16, crc, true); c.setUint32(20, body.length, true);
    c.setUint32(24, e.data.length, true); c.setUint16(28, name.length, true);
    c.setUint32(42, off, true);
    ch.set(name, 46);
    parts.push(lh, body);
    central.push(ch);
    off += lh.length + body.length;
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, off, true);
  const all = new Uint8Array(off + cdSize + 22);
  let p = 0;
  for (const x of [...parts, ...central, end]) { all.set(x, p); p += x.length; }
  return all;
}

/** "1980-01-01 .. 2026-11-07" style range of non-neutral member dates, or null. */
export function dateRange(entries) {
  const ds = entries.map(e => e.date).filter(x => (x >>> 16) !== DOS_1980 || (x & 0xffff) !== 0).sort((a, b) => a - b);
  if (!ds.length) return null;
  const f = x => { const d = x >>> 16; return `${1980 + (d >> 9)}-${String((d >> 5) & 15).padStart(2, '0')}-${String(d & 31).padStart(2, '0')}`; };
  return `${f(ds[0])} .. ${f(ds[ds.length - 1])}`;
}
