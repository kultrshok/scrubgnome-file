// mp4.js - copied verbatim from Scrubgnome Away from Home (web/js/scrubber.js); used for M4A/M4B audio.
// Scrubgnome Away from Home (web) - lossless MP4/MOV/3GP metadata scrubber.
// Port of core/Mp4Scrubber.java. Works on a Blob/File WITHOUT loading it into memory:
// it reads only box headers, collects small patches, then builds the clean copy as a
// Blob stitched from untouched slices of the original + the patches. A 2 GB video
// costs a few kilobytes of RAM, which keeps iPhone Safari happy.
// Author: kultrshok. MIT License.

export const CAT = {
  LOCATION: 'Location (GPS)',
  DEVICE: 'Device make & model',
  SOFTWARE: 'Software / OS version',
  DATES: 'Recording date & time',
  CAMERA: 'Camera settings',
  XMP: 'Embedded XMP document',
  TRACK: 'Hidden data track',
  TRAILER: 'Vendor data tacked on the end',
  HANDLER: 'Handler / encoder names',
  OTHER: 'Other tags',
};

const TOP_KEEP = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'moof', 'mfra', 'sidx', 'styp', 'ssix', 'emsg', 'prft', 'pdin']);
const MOOV_KEEP = new Set(['mvhd', 'trak', 'mvex', 'iods']);
const TRAK_KEEP = new Set(['tkhd', 'edts', 'tref', 'mdia', 'tapt', 'txas', 'load', 'imap', 'clip', 'matt', 'kmat']);
const MDIA_KEEP = new Set(['mdhd', 'hdlr', 'minf', 'elng']);
const AV_HANDLERS = new Set(['vide', 'soun']);
const FIRST_OK = new Set(['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip']);

const MARKERS = [
  ['©xyz', CAT.LOCATION], ['iso6709', CAT.LOCATION], ['location', CAT.LOCATION],
  ['gpslatitude', CAT.LOCATION], ['gpslongitude', CAT.LOCATION], ['gpscoordinates', CAT.LOCATION],
  ['©mak', CAT.DEVICE], ['©mod', CAT.DEVICE], ['com.android.model', CAT.DEVICE],
  ['com.android.manufacturer', CAT.DEVICE], ['quicktime.make', CAT.DEVICE], ['quicktime.model', CAT.DEVICE],
  ['tiff:model', CAT.DEVICE], ['tiff:make', CAT.DEVICE],
  ['©swr', CAT.SOFTWARE], ['©too', CAT.SOFTWARE], ['com.android.version', CAT.SOFTWARE],
  ['quicktime.software', CAT.SOFTWARE], ['creatortool', CAT.SOFTWARE],
  ['©day', CAT.DATES], ['creationdate', CAT.DATES], ['createdate', CAT.DATES],
  ['datetimeoriginal', CAT.DATES], ['modifydate', CAT.DATES],
  ['capture.fps', CAT.CAMERA], ['lensmodel', CAT.CAMERA], ['focallength', CAT.CAMERA],
  ['x:xmpmeta', CAT.XMP], ['<?xpacket', CAT.XMP],
].map(([s, c]) => [Uint8Array.from(s, ch => ch.charCodeAt(0)), c]);

const MAC_EPOCH_OFFSET = 2082844800; // 1904 -> 1970
const SCAN_CAP = 8 * 1024 * 1024;

export class UnsupportedFormatError extends Error {}

export function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

const be32 = (d, o) => ((d[o] << 24) >>> 0) + (d[o + 1] << 16) + (d[o + 2] << 8) + d[o + 3];
const fourcc = (d, o) => String.fromCharCode(d[o], d[o + 1], d[o + 2], d[o + 3]);
const allZero = d => d.every(b => b === 0);

function indexOf(hay, needle) {
  outer: for (let i = 0; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Reads byte ranges from a Blob lazily. */
class Reader {
  constructor(blob) { this.blob = blob; this.size = blob.size; }
  async read(pos, len) { return new Uint8Array(await this.blob.slice(pos, pos + len).arrayBuffer()); }
  async u32(pos) { return be32(await this.read(pos, 4), 0); }
}

/**
 * Walks the file and returns { report, patches, end }.
 * report: what hidden data it carries. patches: [{pos, data}] to apply. end: new file length.
 */
export async function analyze(blob, onProgress) {
  const r = new Reader(blob);
  const report = { categories: new Set(), details: [], recordedUtc: null, boxesFreed: 0, tracksRemoved: 0, bytesZeroed: 0, trailerRemoved: false };
  const patches = [];
  let end = r.size;
  let trackNo = 0;

  const zero = (pos, len) => {
    if (len <= 0) return;
    report.bytesZeroed += len;
    // chunk very large zero regions so we never allocate a giant buffer
    for (let off = 0; off < len; off += 1 << 20) patches.push({ pos: pos + off, data: new Uint8Array(Math.min(1 << 20, len - off)) });
  };

  const readBox = async (pos, limit) => {
    if (pos + 8 > limit) return null;
    const h = await r.read(pos, 8);
    for (let i = 4; i < 8; i++) { const c = h[i]; if (!((c >= 0x20 && c <= 0x7e) || c === 0xa9)) return null; }
    let size = be32(h, 0), hdr = 8;
    const type = fourcc(h, 4);
    if (size === 1) {
      if (pos + 16 > limit) return null;
      const l = await r.read(pos + 8, 8);
      size = be32(l, 0) * 4294967296 + be32(l, 4);
      hdr = 16;
    } else if (size === 0) {
      size = limit - pos;
    }
    if (size < hdr || pos + size > limit) return null;
    return { pos, size, hdr, type, payload: pos + hdr, end: pos + size };
  };

  const children = async box => {
    const out = [];
    let pos = box.payload;
    while (pos + 8 <= box.end) {
      const b = await readBox(pos, box.end);
      if (!b) break;
      out.push(b);
      pos = b.end;
    }
    return out;
  };

  const scanMarkers = async (pos, len, forced) => {
    if (forced) report.categories.add(forced);
    const n = Math.min(len, SCAN_CAP);
    if (n <= 0) return false;
    const d = await r.read(pos, n);
    for (let i = 0; i < d.length; i++) if (d[i] >= 65 && d[i] <= 90) d[i] += 32;
    let hit = false;
    for (const [m, cat] of MARKERS) if (indexOf(d, m) >= 0) { report.categories.add(cat); hit = true; }
    return hit;
  };

  const neutralize = async (b, label, forced) => {
    const hit = await scanMarkers(b.payload, b.size - b.hdr, forced);
    if (!hit && !forced) report.categories.add(CAT.OTHER);
    report.boxesFreed++;
    report.details.push(`${label} (${human(b.size)}) removed`);
    patches.push({ pos: b.pos + 4, data: Uint8Array.from([0x66, 0x72, 0x65, 0x65]) }); // 'free'
    zero(b.payload, b.size - b.hdr);
  };

  const isRegionZero = async (pos, len) => {
    for (let off = 0; off < len; off += 1 << 20) {
      if (!allZero(await r.read(pos + off, Math.min(1 << 20, len - off)))) return false;
    }
    return true;
  };

  const wipeFiller = async (b, label) => {
    const len = b.size - b.hdr;
    if (len <= 0 || await isRegionZero(b.payload, len)) return;
    if (await scanMarkers(b.payload, len, null)) report.details.push(`${label} padding held leftover metadata, wiped`);
    zero(b.payload, len);
  };

  const zeroTimes = async (b, label) => {
    const version = (await r.read(b.payload, 1))[0];
    const len = version === 1 ? 16 : 8;
    if (b.size < b.hdr + 4 + len) return;
    const t = await r.read(b.payload + 4, len);
    if (allZero(t)) return;
    const created = version === 1 ? be32(t, 0) * 4294967296 + be32(t, 4) : be32(t, 0);
    if (!report.recordedUtc && created > MAC_EPOCH_OFFSET) {
      report.recordedUtc = new Date((created - MAC_EPOCH_OFFSET) * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
    }
    report.categories.add(CAT.DATES);
    report.details.push(`${label} timestamps zeroed`);
    zero(b.payload + 4, len);
  };

  const processHdlr = async h => {
    if (h.size < h.hdr + 12) return null;
    const handler = fourcc(await r.read(h.payload + 8, 4), 0);
    const nameStart = h.payload + 24;
    if (nameStart < h.end) {
      const name = await r.read(nameStart, Math.min(256, h.end - nameStart));
      if (!allZero(name)) {
        report.categories.add(CAT.HANDLER);
        const n = Array.from(name).filter(c => c >= 0x20 && c < 0x7f).map(c => String.fromCharCode(c)).join('').trim();
        report.details.push(`Track ${trackNo} handler name '${n}' blanked`);
        zero(nameStart, h.end - nameStart);
      }
    }
    return handler;
  };

  const wipeSamples = async stbl => {
    const ranges = await sampleRanges(r, await children(stbl));
    let total = 0;
    for (const [off, len] of ranges) {
      if (off >= 0 && len > 0 && off + len <= r.size) {
        if (total < SCAN_CAP) await scanMarkers(off, len, null);
        zero(off, len);
        total += len;
      }
    }
    return total;
  };

  const processTrak = async trak => {
    trackNo++;
    let handler = null, stbl = null;
    for (const c of await children(trak)) {
      if (c.type === 'tkhd') await zeroTimes(c, `track ${trackNo} header`);
      else if (c.type === 'mdia') {
        for (const m of await children(c)) {
          if (m.type === 'mdhd') await zeroTimes(m, `track ${trackNo} media header`);
          else if (m.type === 'hdlr') handler = await processHdlr(m);
          else if (m.type === 'minf') { for (const mi of await children(m)) if (mi.type === 'stbl') stbl = mi; }
          else if (!MDIA_KEEP.has(m.type)) await neutralize(m, `trak${trackNo}/mdia/${m.type}`);
        }
      } else if (!TRAK_KEEP.has(c.type)) await neutralize(c, `trak${trackNo}/${c.type}`);
    }
    if (handler && !AV_HANDLERS.has(handler)) {
      const zeroed = stbl ? await wipeSamples(stbl) : 0;
      report.categories.add(CAT.TRACK);
      report.tracksRemoved++;
      report.details.push(`Track ${trackNo} (handler '${handler}'): ${human(zeroed)} of sample data zeroed, track removed`);
      await neutralize(trak, `trak${trackNo}`, CAT.TRACK);
    }
  };

  const processMoov = async moov => {
    for (const c of await children(moov)) {
      if (c.type === 'mvhd') await zeroTimes(c, 'movie header');
      else if (c.type === 'trak') await processTrak(c);
      else if (c.type === 'free' || c.type === 'skip') await wipeFiller(c, `moov/${c.type}`);
      else if (!MOOV_KEEP.has(c.type)) await neutralize(c, `moov/${c.type}`);
    }
  };

  // ---- top level ----
  if (r.size < 16) throw new UnsupportedFormatError('File is too small to be a video.');
  const first = await readBox(0, r.size);
  if (!first || !FIRST_OK.has(first.type)) throw new UnsupportedFormatError('Not an MP4/MOV/3GP video.');
  let seenMoov = false, seenMdat = false, pos = 0;
  while (pos < r.size) {
    const b = r.size - pos >= 8 ? await readBox(pos, r.size) : null;
    if (!b) {
      if (seenMoov && seenMdat) {
        await scanMarkers(pos, r.size - pos, null);
        report.categories.add(CAT.TRAILER);
        report.trailerRemoved = true;
        report.details.push(`${human(r.size - pos)} of unstructured vendor data after the video removed`);
        end = pos;
        break;
      }
      throw new UnsupportedFormatError('Video structure is damaged or unsupported.');
    }
    if (b.type === 'moov') { seenMoov = true; await processMoov(b); }
    else if (b.type === 'mdat') seenMdat = true;
    else if (b.type === 'free' || b.type === 'skip') await wipeFiller(b, `top-level ${b.type}`);
    else if (b.type === 'cmov') throw new UnsupportedFormatError('Compressed movie headers are not supported.');
    else if (!TOP_KEEP.has(b.type)) await neutralize(b, `top-level '${b.type}'`);
    if (onProgress) onProgress(Math.min(1, b.end / r.size));
    pos = b.end;
  }
  if (!seenMoov) throw new UnsupportedFormatError('No movie header found.');
  return { report, patches, end };
}

/** Returns [[offset, size], ...] for every sample described by an stbl's children. */
export async function sampleRanges(r, kids) {
  let sizes = null, offsets = null, stsc = null;
  for (const c of kids) {
    const p = c.payload;
    if (c.type === 'stsz') {
      const fixed = await r.u32(p + 4), count = await r.u32(p + 8);
      if (fixed !== 0) sizes = new Array(count).fill(fixed);
      else { const d = await r.read(p + 12, count * 4); sizes = Array.from({ length: count }, (_, i) => be32(d, i * 4)); }
    } else if (c.type === 'stz2') {
      const field = (await r.read(p + 7, 1))[0], count = await r.u32(p + 8);
      const d = await r.read(p + 12, Math.ceil(count * field / 8));
      sizes = Array.from({ length: count }, (_, i) => field === 4 ? (i % 2 === 0 ? d[i >> 1] >> 4 : d[i >> 1] & 15)
        : field === 8 ? d[i] : (d[i * 2] << 8) | d[i * 2 + 1]);
    } else if (c.type === 'stco') {
      const count = await r.u32(p + 4), d = await r.read(p + 8, count * 4);
      offsets = Array.from({ length: count }, (_, i) => be32(d, i * 4));
    } else if (c.type === 'co64') {
      const count = await r.u32(p + 4), d = await r.read(p + 8, count * 8);
      offsets = Array.from({ length: count }, (_, i) => be32(d, i * 8) * 4294967296 + be32(d, i * 8 + 4));
    } else if (c.type === 'stsc') {
      const count = await r.u32(p + 4), d = await r.read(p + 8, count * 12);
      stsc = Array.from({ length: count }, (_, i) => [be32(d, i * 12), be32(d, i * 12 + 4)]);
    }
  }
  if (!sizes || !offsets || !stsc || !stsc.length) return [];
  const out = [];
  let sample = 0, e = 0;
  for (let chunk = 1; chunk <= offsets.length && sample < sizes.length; chunk++) {
    while (e + 1 < stsc.length && stsc[e + 1][0] <= chunk) e++;
    let off = offsets[chunk - 1];
    for (let s = 0; s < stsc[e][1] && sample < sizes.length; s++, sample++) {
      out.push([off, sizes[sample]]);
      off += sizes[sample];
    }
  }
  return out;
}

/** Builds the clean file as a Blob: original slices + patches, cut at `end`. */
export function buildClean(blob, { patches, end }, type) {
  const sorted = patches.map((p, i) => ({ ...p, i })).sort((a, b) => a.pos - b.pos || a.i - b.i);
  // merge overlapping patches into flat regions (later patch wins where they overlap)
  const regions = [];
  for (const p of sorted) {
    const pEnd = p.pos + p.data.length;
    const last = regions.at(-1);
    if (last && p.pos < last.end) {
      if (pEnd > last.end) {
        const grown = new Uint8Array(pEnd - last.pos);
        grown.set(last.data);
        last.data = grown;
        last.end = pEnd;
      }
      last.data.set(p.data, p.pos - last.pos);
    } else {
      regions.push({ pos: p.pos, end: pEnd, data: p.data.slice() });
    }
  }
  const parts = [];
  let cur = 0;
  for (const g of regions) {
    if (g.pos >= end) break;
    if (g.pos > cur) parts.push(blob.slice(cur, g.pos));
    parts.push(g.end > end ? g.data.subarray(0, end - g.pos) : g.data);
    cur = Math.min(g.end, end);
  }
  if (cur < end) parts.push(blob.slice(cur, end));
  return new Blob(parts, { type: type || blob.type || 'video/mp4' });
}

/** One call: analyze, build, verify. Throws if anything survives. */
export async function scrub(blob, onProgress) {
  const a = await analyze(blob, f => onProgress && onProgress(f * 0.5));
  const clean = buildClean(blob, a);
  const verify = await analyze(clean, f => onProgress && onProgress(0.5 + f * 0.5));
  if (verify.report.categories.size) {
    throw new Error(`Something survived the scrub: ${[...verify.report.categories].join(', ')}`);
  }
  return { clean, report: a.report };
}
