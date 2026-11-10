// Scrubgnome-File - document, archive and audio metadata scrubber.
// One JavaScript core shared by the iPhone web app and the Android app (which runs it
// in a WebView with no internet permission). Rules mirror desktop Scrubgnome's
// hmd/files.py. Pictures inside documents go through face.js (Scrubgnome-Face), M4A
// audio through mp4.js (Scrubgnome Away from Home). Runs locally; nothing is uploaded.
// Author: kultrshok. MIT License.

import * as face from './face.js';
import * as mp4 from './mp4.js';
import { readZip, writeZip, isZip, dateRange, inflateRaw, ZipError } from './zip.js';

export class UnsupportedFileError extends Error {}

export const ANON = 'Author', ANON_INITIALS = 'A', FIXED_DATE = '2000-01-01T00:00:00Z';

const utf8 = new TextDecoder('utf-8');
const latin1 = new TextDecoder('latin1');
const enc = new TextEncoder();
const fromLatin1 = s => { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff; return a; };
const shorten = v => { v = String(v).replace(/\u0000/g, '').trim(); return v.length <= 90 ? v : v.slice(0, 89) + '…'; };
const unxml = t => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const ascii = (d, o, n) => (o < 0 || o + n > d.length) ? '' : latin1.decode(d.subarray(o, o + n));

/** A finding. `info: true` = for your information only (kept on purpose, not a leak). */
const F = (cat, where, key, value, info = false) => ({ cat, where, key, value: info ? String(value) : shorten(value), ...(info ? { info: true } : {}) });

const CAT_ORDER = ['location', 'time', 'identity', 'device', 'other'];
const leaks = fs => fs.filter(f => !f.info);
export function categories(findings) { return CAT_ORDER.filter(c => leaks(findings).some(f => f.cat === c)); }
export function score(findings) {
  const c = new Set(categories(findings));
  return Math.min(100, (c.has('location') ? 50 : 0) + (c.has('time') ? 35 : 0) + (c.has('identity') ? 30 : 0) + (c.has('device') ? 15 : 0));
}
export const isClean = findings => leaks(findings).length === 0;

// ------------------------------------------------------------------ what is it?

const OOXML = ['docx', 'docm', 'dotx', 'dotm', 'xlsx', 'xlsm', 'xltx', 'xltm', 'pptx', 'pptm', 'potx', 'potm', 'ppsx', 'ppsm', 'vsdx'];
const ODF = ['odt', 'ods', 'odp', 'odg', 'ott', 'ots', 'otp', 'otg', 'odf'];
const VIDEO = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', '3gp'];
const NOT_YET = { ogg: 'OGG', oga: 'OGG', opus: 'Opus', wma: 'WMA' };
const extOf = name => ((name || '').toLowerCase().match(/\.([a-z0-9]+)$/) || [, ''])[1];

export function kindOf(name, d) {
  const ext = extOf(name);
  if (face.sniff(d)) return 'image';
  if (ascii(d, 0, 5) === '%PDF-' || ext === 'pdf') return 'pdf';
  if (ascii(d, 0, 4) === 'fLaC' || ext === 'flac') return 'flac';
  if (ascii(d, 0, 4) === 'RIFF' && ascii(d, 8, 4) === 'WAVE' || ascii(d, 0, 4) === 'RF64') return 'wav';
  if (ascii(d, 0, 4) === 'FORM' && /^AIF[FC]$/.test(ascii(d, 8, 4))) return 'aiff';
  if (ascii(d, 4, 4) === 'ftyp') return VIDEO.includes(ext) ? 'video' : 'm4a';
  if (ext === 'mp3' || ascii(d, 0, 3) === 'ID3' || (d[0] === 0xff && (d[1] & 0xe0) === 0xe0 && ext !== 'aac')) return 'mp3';
  if (ext === 'aac') return 'mp3';              // ADTS: only ever carries ID3 tags
  if (ascii(d, 0, 5) === '{\\rtf' || ext === 'rtf') return 'rtf';
  if (ext === 'svg') return 'svg';
  if (isZip(d)) {
    if (OOXML.includes(ext)) return 'ooxml';
    if (ODF.includes(ext)) return 'odf';
    if (ext === 'epub') return 'epub';
    return 'zip';
  }
  if (NOT_YET[ext]) return 'notyet';
  if (VIDEO.includes(ext)) return 'video';
  return null;
}

export const LABELS = {
  image: 'Photo', pdf: 'PDF', ooxml: 'Office document', odf: 'OpenDocument', epub: 'E-book (EPUB)',
  zip: 'ZIP archive', rtf: 'RTF document', svg: 'SVG drawing', mp3: 'MP3 audio', flac: 'FLAC audio',
  wav: 'WAV audio', aiff: 'AIFF audio', m4a: 'M4A audio',
};

// ------------------------------------------------------------------ public API

/** What does this file leak? -> { kind, label, findings } */
export async function scan(name, d) {
  const kind = kindOf(name, d);
  check(kind, name);
  const findings = await HANDLERS[kind](d, false, 0, name);
  return { kind, label: LABELS[kind], findings: findings.f.concat(nameFindings(name)) };
}

/**
 * Clean copy + re-scan. -> { clean, before, after }. Throws UnsupportedFileError if the
 * file can't be cleaned safely here, or Error if anything survived (never hand that out).
 */
export async function scrub(name, d) {
  const kind = kindOf(name, d);
  check(kind, name);
  const r = await HANDLERS[kind](d, true, 0, name);
  if (r.refuse) throw new UnsupportedFileError(r.refuse);
  const before = { kind, label: LABELS[kind], findings: r.f.concat(nameFindings(name)) };
  const re = await HANDLERS[kind](r.out, false, 0, name);
  const after = { kind, label: LABELS[kind], findings: re.f };
  if (!isClean(after.findings)) throw new Error('Something survived the scrub: ' + categories(after.findings).join(', '));
  return { clean: r.out, before, after };
}

function check(kind, name) {
  if (kind === 'video') throw new UnsupportedFileError('Videos are Scrubgnome Away from Home\'s job (the video app), not mine.');
  if (kind === 'notyet') throw new UnsupportedFileError(`${NOT_YET[extOf(name)]} audio isn't supported on the phone yet. Desktop Scrubgnome handles it.`);
  if (!kind) throw new UnsupportedFileError('I don\'t know this file type. I do PDF, Office, OpenDocument, EPUB, ZIP, RTF, SVG, MP3, M4A, FLAC, WAV, AIFF and photos.');
}

const STAMP = /(?<!\d)(19|20)\d{2}[-_.]?[01]\d[-_.]?[0-3]\d(?:[ _T.-]*(?:at[ _])?[0-2]\d[-_.:]?[0-5]\d(?:[-_.:]?[0-5]\d)?)?/;
export const dateInName = name => (name || '').match(STAMP)?.[0] ?? null;
function nameFindings(name) {
  const m = dateInName(name);
  return m ? [F('time', 'file name', 'date in name', m, true)] : [];   // the app renames; not inside the file
}

const MIME = {
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation', epub: 'application/epub+zip', zip: 'application/zip',
  rtf: 'application/rtf', svg: 'image/svg+xml', mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4',
  flac: 'audio/flac', wav: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff', aac: 'audio/aac',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif',
};
export const mimeFor = name => MIME[extOf(name)] || 'application/octet-stream';

// ------------------------------------------------------------------ pictures inside files

function memberImage(name, data, f, where, doScrub) {
  if (!face.sniff(data)) return data;
  try {
    const s = face.scan(data);
    const leaky = s.findings.filter(x => x.cat !== 'other' || /thumbnail|motion|trailing|comment/i.test(x.key + x.value));
    if (leaky.length) {
      const cats = [...new Set(leaky.map(x => x.cat))];
      const worst = ['location', 'identity', 'time', 'device', 'other'].find(c => cats.includes(c));
      f.push(F(worst, where, name.split('/').pop(), `picture with its own hidden data (${cats.join(', ')})`));
    }
    return doScrub && s.findings.length ? face.scrub(data).clean : data;
  } catch {
    return data;   // a damaged picture inside a document: leave it as it is
  }
}

// ------------------------------------------------------------------ zip container

function zipFindings(z, where = 'zip container') {
  const f = [];
  const r = dateRange(z.entries);
  if (r) f.push(F('time', where, 'file timestamps', r));
  if (z.entries.some(e => e.extra)) f.push(F('identity', where, 'extra fields', 'OS owner IDs / precise file times'));
  if (z.comment.length) f.push(F('other', where, 'zip comment', latin1.decode(z.comment)));
  return f;
}

async function openZip(d) {
  try { return await readZip(d); } catch (e) {
    if (e instanceof ZipError) throw new UnsupportedFileError(`Can't open this archive: ${e.message}.`);
    throw e;
  }
}

// ------------------------------------------------------------------ Office (OOXML)

const CORE_FIELDS = {
  'dc:creator': 'identity', 'cp:lastModifiedBy': 'identity', 'dcterms:created': 'time', 'dcterms:modified': 'time',
  'cp:lastPrinted': 'time', 'cp:revision': 'other', 'dc:title': 'other', 'dc:subject': 'other', 'cp:keywords': 'other',
  'dc:description': 'other', 'cp:category': 'other', 'cp:contentStatus': 'other', 'dc:identifier': 'other', 'dc:language': 'other',
};
const APP_FIELDS = { Company: 'identity', Manager: 'identity', Application: 'device', AppVersion: 'device', Template: 'identity', TotalTime: 'time', HyperlinkBase: 'identity' };
const PERSON_ATTRS = '(?<![\\w:])(?:w:author|w15:author|w:initials)';
const PEOPLE_FILE = /(people|persons\/person|authors|commentAuthors)\.xml$/i;
const LIST_ATTRS = '(?<![\\w:])(?:w15:author|w15:userId|w15:providerId|userId|providerId|displayName|initials|name)';
const DATE_ATTRS = '(?:w:date|w16du:dateUtc|dT)';
const RSID_ATTRS = 'w:rsid(?:R|RPr|RDefault|P|Del|Sect|Tr)?';
const DROP_PARTS = /^(docProps\/(thumbnail\.\w+|custom\.xml)|(word|xl|ppt)\/printerSettings\/.*|word\/people\.xml|xl\/persons\/person\.xml|ppt\/authors\.xml)$/;

function oxDrop(parts, drop) {
  const base = drop.split('/').pop();
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return parts.filter(p => p.name !== drop).map(p => {
    if (!(p.name.endsWith('.rels') || p.name === '[Content_Types].xml')) return p;
    let t = utf8.decode(p.data);
    t = t.replace(new RegExp(`<Relationship\\b[^>]*Target="[^"]*${esc(base)}"[^>]*/>`, 'g'), '');
    t = t.replace(new RegExp(`<Override\\b[^>]*PartName="/${esc(drop)}"[^>]*/>`, 'g'), '');
    return { ...p, data: enc.encode(t) };
  });
}

async function ooxml(d, doScrub) {
  const z = await openZip(d);
  const f = zipFindings(z);
  const parts = [];
  const authors = new Set();
  let tracked = 0, comments = 0, rsid = 0;
  for (const e of z.entries) {
    const n = e.name, low = n.toLowerCase();
    let data = e.data;
    if (low === 'docprops/core.xml') {
      let t = utf8.decode(data);
      for (const [tag, cat] of Object.entries(CORE_FIELDS)) {
        const m = t.match(new RegExp(`<${tag}\\b[^>]*>([^<]*)</${tag}>`));
        if (m && m[1].trim()) f.push(F(cat, 'document properties', tag.split(':')[1], unxml(m[1])));
      }
      if (doScrub) {
        const root = t.match(/<cp:coreProperties\b[^>]*>/);
        const head = root ? t.slice(0, t.indexOf('<cp:coreProperties')) : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
        data = enc.encode(head + (root ? root[0] : '<cp:coreProperties>') + '</cp:coreProperties>');
      }
    } else if (low === 'docprops/app.xml') {
      let t = utf8.decode(data);
      for (const [tag, cat] of Object.entries(APP_FIELDS)) {
        const m = t.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
        if (m && m[1].trim() && !(tag === 'TotalTime' && m[1] === '0'))
          f.push(F(cat, 'app properties', tag, unxml(m[1]) + (tag === 'TotalTime' ? ' minutes editing' : '')));
      }
      if (doScrub) {
        for (const tag of ['Company', 'Manager', 'Template', 'TotalTime', 'HyperlinkBase', 'Application', 'AppVersion'])
          t = t.replace(new RegExp(`<${tag}>[^<]*</${tag}>|<${tag}/>`, 'g'), '');
        data = enc.encode(t);
      }
    } else if (low.endsWith('.xml') || low.endsWith('.rels')) {
      let t = utf8.decode(data);
      const pat = PEOPLE_FILE.test(n) ? LIST_ATTRS : PERSON_ATTRS;
      for (const m of t.matchAll(new RegExp(pat + '="([^"]+)"', 'g'))) authors.add(m[1]);
      for (const m of t.matchAll(/<(?:x:)?author>([^<]+)<\/(?:x:)?author>/g)) authors.add(m[1]);
      for (const m of t.matchAll(/<p:cmAuthor\b[^>]*\bname="([^"]+)"/g)) authors.add(m[1]);
      for (const m of t.matchAll(/<p188:author\b[^>]*\bname="([^"]+)"/g)) authors.add(m[1]);
      tracked += (t.match(/<w:(?:ins|del|moveFrom|moveTo)\b/g) || []).length;
      comments += (t.match(/<w:comment\b|<comment\b|<p:cm\b|<threadedComment\b/g) || []).length;
      rsid += (t.match(new RegExp(RSID_ATTRS + '="', 'g')) || []).length + (t.match(/<w:rsid\b/g) || []).length;
      for (const m of t.matchAll(/Target="((?:file:\/\/\/)?[^"]*(?:Users|Documents and Settings|home)[/\\][^"]*)"/g))
        f.push(F('identity', n, 'linked file path', unxml(m[1])));
      const ap = t.match(/<x15ac:absPath\b[^>]*url="([^"]*)"/);
      if (ap) f.push(F('identity', n, 'saved-at folder', unxml(ap[1])));
      if (doScrub) {
        t = t.replace(new RegExp('(' + pat + ')="[^"]*"', 'g'), (_, a) => `${a}="${a.includes('initials') ? ANON_INITIALS : ANON}"`);
        t = t.replace(/(<(?:x:)?author>)[^<]*(<\/(?:x:)?author>)/g, `$1${ANON}$2`);
        t = t.replace(/(<p:cmAuthor\b[^>]*\bname=")[^"]*"/g, `$1${ANON}"`);
        t = t.replace(/(<p188:author\b[^>]*\bname=")[^"]*"/g, `$1${ANON}"`);
        t = t.replace(new RegExp('\\s(' + DATE_ATTRS + ')="[^"]*"', 'g'), ` $1="${FIXED_DATE}"`);
        t = t.replace(new RegExp('\\s' + RSID_ATTRS + '="[^"]*"', 'g'), '');
        t = t.replace(/<w:rsids>[\s\S]*?<\/w:rsids>/g, '').replace(/<w:rsid\b[^>]*\/>/g, '');
        t = t.replace(/<w:attachedTemplate\b[^>]*\/>/g, '').replace(/<Relationship\b[^>]*attachedTemplate"[^>]*\/>/g, '');
        t = t.replace(/<x15ac:absPath\b[^>]*\/>/g, '');
        data = enc.encode(t);
      }
    } else if (/^(word|xl|ppt|visio)\/media\//i.test(n)) {
      data = memberImage(n, data, f, 'pasted pictures', doScrub);
    }
    parts.push({ name: n, data });
  }
  [...authors].forEach(a => { if (a === ANON || a === ANON_INITIALS) authors.delete(a); });
  if (authors.size) f.push(F('identity', 'comments / tracked changes', 'people', [...authors].sort().join(', ')));
  if (tracked) f.push(F('other', 'body', 'tracked changes', `${tracked} recorded edits (kept; author + time anonymized)`, true));
  if (comments) f.push(F('other', 'body', 'comments', `${comments} (kept; authors/dates anonymized)`, true));
  if (rsid) f.push(F('other', 'body', 'revision IDs (rsid)', `${rsid} - can link this file to its drafts`));
  const drops = parts.map(p => p.name).filter(n => DROP_PARTS.test(n));
  for (const n of drops) {
    const isList = /people|person|authors/.test(n);
    if (isList) {
      const body = utf8.decode(parts.find(p => p.name === n).data);
      const named = [...body.matchAll(new RegExp(LIST_ATTRS + '="([^"]*)"', 'g'))].some(m => m[1] !== ANON && m[1] !== ANON_INITIALS);
      if (named) f.push(F('identity', n, 'part', 'account list (names, e-mails, IDs)'));
      continue;                                      // anonymized in place, not deleted (comments point at it)
    }
    f.push(F(n.includes('custom') ? 'identity' : 'other', n, 'part',
      n.includes('thumbnail') ? 'preview image' : n.includes('custom') ? 'custom properties' : 'printer settings (printer name)'));
  }
  if (!doScrub) return { f };
  let out = parts;
  for (const n of drops) if (!/people|person|authors/.test(n)) out = oxDrop(out, n);
  out.sort((a, b) => (b.name === '[Content_Types].xml') - (a.name === '[Content_Types].xml'));
  return { f, out: await writeZip(out) };
}

// ------------------------------------------------------------------ OpenDocument

async function odf(d, doScrub) {
  const z = await openZip(d);
  const f = zipFindings(z);
  const out = [], people = new Set();
  for (const e of z.entries) {
    const n = e.name;
    let data = e.data;
    if (n === 'meta.xml') {
      let t = utf8.decode(data);
      for (const [tag, cat] of [['meta:initial-creator', 'identity'], ['dc:creator', 'identity'], ['meta:creation-date', 'time'],
        ['dc:date', 'time'], ['meta:print-date', 'time'], ['meta:printed-by', 'identity'], ['meta:editing-cycles', 'other'],
        ['meta:editing-duration', 'time'], ['meta:generator', 'device'], ['dc:title', 'other'], ['dc:subject', 'other'], ['meta:keyword', 'other']]) {
        const m = t.match(new RegExp(`<${tag}\\b[^>]*>([^<]*)</${tag}>`));
        if (m && m[1].trim()) f.push(F(cat, 'meta.xml', tag.split(':')[1], unxml(m[1])));
      }
      for (const m of t.matchAll(/<meta:user-defined\b[^>]*meta:name="([^"]*)"[^>]*>([^<]*)</g)) f.push(F('other', 'meta.xml', 'custom: ' + m[1], m[2]));
      const tp = t.match(/<meta:template\b[^>]*xlink:href="([^"]+)"/);
      if (tp) f.push(F('identity', 'meta.xml', 'template path', tp[1]));
      if (doScrub) data = enc.encode(t.replace(/<office:meta>[\s\S]*?<\/office:meta>|<office:meta\/>/, '<office:meta/>'));
    } else if (n === 'content.xml' || n === 'styles.xml') {
      let t = utf8.decode(data);
      for (const m of t.matchAll(/<dc:creator>([^<]*)<\/dc:creator>/g)) people.add(m[1]);
      const ch = (t.match(/<text:changed-region\b/g) || []).length, an = (t.match(/<office:annotation\b/g) || []).length;
      if (ch) f.push(F('other', n, 'tracked changes', `${ch} recorded edits (kept; author + time anonymized)`, true));
      if (an) f.push(F('other', n, 'comments', `${an} (kept; authors/dates anonymized)`, true));
      if (/<dc:date>(?!2000-01-01T00:00:00<)/.test(t)) f.push(F('time', n, 'comment/change dates', 'timestamps on notes and edits'));
      if (doScrub) {
        t = t.replace(/<dc:creator>[^<]*<\/dc:creator>/g, `<dc:creator>${ANON}</dc:creator>`)
          .replace(/<dc:date>[^<]*<\/dc:date>/g, '<dc:date>2000-01-01T00:00:00</dc:date>')
          .replace(/<meta:creator-initials>[^<]*<\/meta:creator-initials>/g, `<meta:creator-initials>${ANON_INITIALS}</meta:creator-initials>`);
        data = enc.encode(t);
      }
    } else if (n === 'settings.xml') {
      let t = utf8.decode(data);
      const m = t.match(/config:name="PrinterName"[^>]*>([^<]+)</);
      if (m) f.push(F('device', 'settings.xml', 'printer', m[1]));
      if (/config:name="PrinterSetup"[^>]*>[^<]+</.test(t)) f.push(F('device', 'settings.xml', 'printer setup', 'printer driver settings'));
      if (doScrub) data = enc.encode(t.replace(/(<config:config-item config:name="(?:PrinterName|PrinterSetup)"[^>]*>)[^<]*(<)/g, '$1$2'));
    } else if (n.startsWith('Thumbnails/')) {
      f.push(F('other', n, 'part', 'preview image'));
      if (doScrub) continue;
    } else if (n === 'META-INF/manifest.xml' && doScrub) {
      data = enc.encode(utf8.decode(data).replace(/<manifest:file-entry\b[^>]*manifest:full-path="Thumbnails\/[^"]*"[^>]*\/>/g, ''));
    } else if (n.startsWith('Pictures/') || n.startsWith('media/')) {
      data = memberImage(n, data, f, 'pasted pictures', doScrub);
    }
    out.push({ name: n, data, store: n === 'mimetype' });
  }
  people.delete(ANON);
  if (people.size) f.push(F('identity', 'comments / tracked changes', 'people', [...people].sort().join(', ')));
  if (!doScrub) return { f };
  out.sort((a, b) => (b.name === 'mimetype') - (a.name === 'mimetype'));
  return { f, out: await writeZip(out) };
}

// ------------------------------------------------------------------ EPUB + generic ZIP

async function epub(d, doScrub) {
  const z = await openZip(d);
  const f = zipFindings(z);
  const out = [];
  for (const e of z.entries) {
    const n = e.name;
    let data = e.data;
    if (n.toLowerCase().endsWith('.opf')) {
      let t = utf8.decode(data);
      for (const m of t.matchAll(/<dc:contributor\b[^>]*>([^<]*)<\/dc:contributor>/g)) f.push(F('device', n, 'contributor (tool)', m[1]));
      for (const m of t.matchAll(/<meta\b[^>]*name="calibre:([^"]+)"[^>]*content="([^"]*)"/g)) f.push(F(m[1].includes('timestamp') ? 'time' : 'other', n, 'calibre:' + m[1], m[2]));
      const md = t.match(/<meta\b[^>]*property="dcterms:modified"[^>]*>([^<]*)</);
      if (md && md[1] !== FIXED_DATE) f.push(F('time', n, 'modified', md[1]));
      if (doScrub) {
        t = t.replace(/\s*<dc:contributor\b[^>]*>[^<]*<\/dc:contributor>/g, '')
          .replace(/\s*<meta\b[^>]*name="calibre:[^"]+"[^>]*\/>/g, '')
          .replace(/(<meta\b[^>]*property="dcterms:modified"[^>]*>)[^<]*(<)/, `$1${FIXED_DATE}$2`);
        data = enc.encode(t);
      }
    } else if (face.sniff(data)) {
      data = memberImage(n, data, f, 'pictures', doScrub);
    }
    out.push({ name: n, data, store: n === 'mimetype' });
  }
  f.push(F('other', 'note', 'title/author kept', 'the book\'s own title and author are content, so they stay', true));
  if (!doScrub) return { f };
  out.sort((a, b) => (b.name === 'mimetype') - (a.name === 'mimetype'));
  return { f, out: await writeZip(out) };
}

async function zipAny(d, doScrub, depth) {
  const z = await openZip(d);
  const f = zipFindings(z);
  const out = [];
  for (const e of z.entries) {
    if (e.dir) { out.push({ name: e.name, data: e.data }); continue; }
    let data = e.data;
    const kind = kindOf(e.name, data);
    if (kind && HANDLERS[kind] && depth < 3) {
      try {
        const r = await HANDLERS[kind](data, doScrub, depth + 1, e.name);
        for (const x of r.f) f.push({ ...x, where: `${e.name} › ${x.where}` });
        if (r.refuse) f.push(F('other', e.name, 'can\'t clean inside', r.refuse));
        else if (doScrub && r.out) data = r.out;
      } catch (err) {
        f.push(F('other', e.name, 'skipped', err.message, true));
      }
    }
    out.push({ name: e.name, data });
  }
  if (!doScrub) return { f };
  const refused = f.find(x => x.key === 'can\'t clean inside');
  if (refused) return { f, refuse: `${refused.where}: ${refused.value}` };
  return { f, out: await writeZip(out) };
}

// ------------------------------------------------------------------ RTF + SVG

function rtfGroupEnd(t, i) {
  let depth = 0;
  for (; i < t.length; i++) {
    const c = t[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return t.length;
}

function rtf(d, doScrub) {
  let t = latin1.decode(d);
  const f = [];
  const i = t.indexOf('{\\info');
  if (i >= 0) {
    const j = rtfGroupEnd(t, i), block = t.slice(i, j);
    for (const [k, cat] of [['author', 'identity'], ['operator', 'identity'], ['company', 'identity'], ['manager', 'identity'], ['title', 'other'], ['doccomm', 'other']]) {
      const m = block.match(new RegExp(`\\{\\\\${k}\\s+([^}]*)\\}`));
      if (m) f.push(F(cat, 'info block', k, m[1]));
    }
    for (const k of ['creatim', 'revtim', 'printim']) if (block.includes('\\' + k)) f.push(F('time', 'info block', k, 'date stamp'));
    if (doScrub) t = t.slice(0, i) + t.slice(j);
  }
  if (/\{\\\*\\rsidtbl[^}]*\}/.test(t)) f.push(F('other', 'body', 'revision IDs (rsid)', 'can link this file to its drafts'));
  if (!doScrub) return { f };
  return { f, out: fromLatin1(t.replace(/\{\\\*\\rsidtbl[^}]*\}/g, '')) };
}

function svg(d, doScrub) {
  let t = utf8.decode(d);
  const f = [];
  if (/<metadata\b/.test(t)) f.push(F('identity', '<metadata>', 'RDF block', 'creator / rights / dates'));
  for (const [a, cat] of [['sodipodi:docname', 'other'], ['inkscape:export-filename', 'identity'], ['sodipodi:docbase', 'identity'], ['inkscape:version', 'device']]) {
    const m = t.match(new RegExp(a + '="([^"]*)"'));
    if (m) f.push(F(cat, 'editor data', a, m[1]));
  }
  if (/<!--/.test(t)) f.push(F('other', 'comments', 'XML comments', 'may name the exporting app/user'));
  if (!doScrub) return { f };
  t = t.replace(/<metadata\b[\s\S]*?<\/metadata>|<metadata\b[^>]*\/>/g, '')
    .replace(/\s(?:sodipodi:docname|sodipodi:docbase|inkscape:export-filename|inkscape:export-xdpi|inkscape:export-ydpi|inkscape:version)="[^"]*"/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  return { f, out: enc.encode(t) };
}

// ------------------------------------------------------------------ photos (delegated to Face)

function image(d, doScrub) {
  try {
    const s = face.scan(d);
    const f = s.findings.map(x => F(x.cat, x.where, x.key, x.value));
    return doScrub ? { f, out: s.findings.length ? face.scrub(d).clean : d } : { f };
  } catch (e) {
    throw new UnsupportedFileError(e.message);
  }
}

// ------------------------------------------------------------------ XMP (shared by PDF + audio)

const XMP_SKIP = new Set(['xmlns', 'rdf', 'x', 'xml', 'stEvt', 'stRef']);
function xmpCat(p, n) {
  const k = `${p}:${n}`.toLowerCase();
  if (/gps|latitude|longitude|altitude|location|city|state|country|sublocation|province/.test(k)) return 'location';
  if (/creator\b|author|owner|by-?line|rights|copyright|serial|usage|credit|marked/.test(k)) return 'identity';
  if (/date|time|when/.test(k)) return 'time';
  if (/make|model|lens|creatortool|software|agent|camera|producer/.test(k)) return 'device';
  return 'other';
}
export function xmpFindings(t, where = 'XMP') {
  const f = [], seen = new Set();
  for (const rx of [/\b([A-Za-z][\w.-]*):([A-Za-z][\w.-]*)="([^"]*)"/g, /<([A-Za-z][\w.-]*):([A-Za-z][\w.-]*)(?:\s[^>]*)?>([^<]+)<\/\1:\2>/g]) {
    for (const m of t.matchAll(rx)) {
      const [, p, n, v] = m;
      if (XMP_SKIP.has(p) || !v.trim() || seen.has(p + n)) continue;
      seen.add(p + n);
      f.push(F(xmpCat(p, n), where, `${p}:${n}`, v.trim()));
    }
  }
  for (const m of t.matchAll(/<([A-Za-z][\w.-]*):([A-Za-z][\w.-]*)(?:\s[^>]*)?>\s*<rdf:(?:Seq|Bag|Alt)>([\s\S]*?)<\/rdf:(?:Seq|Bag|Alt)>/g)) {
    const [, p, n, body] = m;
    const vals = [...body.matchAll(/<rdf:li[^>]*>([^<]*)<\/rdf:li>/g)].map(x => x[1]).filter(Boolean);
    if (vals.length && !seen.has(p + n) && !XMP_SKIP.has(p)) { seen.add(p + n); f.push(F(xmpCat(p, n), where, `${p}:${n}`, vals.join('; '))); }
  }
  const hist = (t.match(/stEvt:action/g) || []).length;
  if (hist) f.push(F('time', where, 'edit history', `${hist} saved edit steps`));
  return f;
}
const MIN_XMP = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>';
const XMP_END = '<?xpacket end="w"?>';

// ------------------------------------------------------------------ PDF (cleaned in place)
//
// A PDF is a pile of numbered objects plus a table of their byte offsets. Rewriting it
// properly needs a full PDF engine; instead Twig overwrites every hidden field with a
// blank of EXACTLY the same length, so every offset stays valid and nothing visible
// changes. Covers the Info dictionary in every saved revision, XMP metadata streams,
// document IDs, annotation authors/dates, attached files, and EXIF in embedded JPEGs.

const PDF_WS = new Set([0, 9, 10, 12, 13, 32]);
const PDF_DELIM = new Set([...'()<>[]{}/%'].map(c => c.charCodeAt(0)));
const ANNOT_TYPES = /^\/(Text|FreeText|Line|Square|Circle|Polygon|PolyLine|Highlight|Underline|Squiggly|StrikeOut|Stamp|Caret|Ink|Popup|FileAttachment|Sound|Redact)$/;
const STATIC_ID = '31415926535897932384626433832795';   // qpdf's static ID, same as desktop: links nothing

class PdfText {
  constructor(s) { this.s = s; }
  ws(i) {
    const s = this.s;
    for (;;) {
      while (i < s.length && PDF_WS.has(s.charCodeAt(i))) i++;
      if (s[i] === '%') { while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
      return i;
    }
  }
  stringEnd(i) {                       // s[i] === '('
    const s = this.s;
    let depth = 0;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') { i++; continue; }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) return i + 1;
    }
    throw new Error('unterminated string');
  }
  valueEnd(i) {
    const s = this.s;
    const c = s[i];
    if (c === '(') return this.stringEnd(i);
    if (c === '<' && s[i + 1] === '<') return this.dictEnd(i);
    if (c === '<') { const j = s.indexOf('>', i); if (j < 0) throw new Error('bad hex'); return j + 1; }
    if (c === '[') {
      i = this.ws(i + 1);
      while (s[i] !== ']') { if (i >= s.length) throw new Error('bad array'); i = this.ws(this.valueEnd(i)); }
      return i + 1;
    }
    if (c === '/') { i++; while (i < s.length && !PDF_WS.has(s.charCodeAt(i)) && !PDF_DELIM.has(s.charCodeAt(i))) i++; return i; }
    let j = i;
    while (j < s.length && !PDF_WS.has(s.charCodeAt(j)) && !PDF_DELIM.has(s.charCodeAt(j))) j++;
    if (j === i) throw new Error(`unexpected '${c}'`);
    const m = /^\s+\d+\s+R(?![A-Za-z0-9])/.exec(s.slice(j, j + 24));
    return m ? j + m[0].length : j;
  }
  dictEnd(i) {                         // s[i..] === '<<'
    const s = this.s;
    i = this.ws(i + 2);
    while (!(s[i] === '>' && s[i + 1] === '>')) {
      if (i >= s.length) throw new Error('unterminated dictionary');
      i = this.ws(this.valueEnd(i));   // key
      i = this.ws(this.valueEnd(i));   // value
    }
    return i + 2;
  }
  /** Call fn(entries) for the dict/array value at i and every dict nested inside it. */
  walk(i, fn, depth = 0) {
    const s = this.s;
    if (depth > 40) return;
    if (s[i] === '<' && s[i + 1] === '<') {
      const e = this.entries(i);
      fn(e.list);
      for (const x of e.list) if (s[x.vStart] === '<' && s[x.vStart + 1] === '<' || s[x.vStart] === '[') this.walk(x.vStart, fn, depth + 1);
    } else if (s[i] === '[') {
      let p = this.ws(i + 1);
      while (s[p] !== ']' && p < s.length) {
        if (s[p] === '<' && s[p + 1] === '<' || s[p] === '[') this.walk(p, fn, depth + 1);
        p = this.ws(this.valueEnd(p));
      }
    }
  }
  /** Top-level entries of the dict at i: [{key, kStart, vStart, vEnd}] and its end. */
  entries(i) {
    const s = this.s, out = [];
    let p = this.ws(i + 2);
    while (!(s[p] === '>' && s[p + 1] === '>')) {
      if (p >= s.length || s[p] !== '/') throw new Error('bad dictionary key');
      const kEnd = this.valueEnd(p), key = s.slice(p, kEnd);
      const vStart = this.ws(kEnd), vEnd = this.valueEnd(vStart);
      out.push({ key, kStart: p, vStart, vEnd });
      p = this.ws(vEnd);
    }
    return { list: out, end: p + 2 };
  }
}

function pdfString(raw) {             // raw = '(...)' or '<...>' -> readable text
  let bytes;
  if (raw[0] === '<') {
    const h = raw.slice(1, -1).replace(/\s/g, '');
    bytes = []; for (let i = 0; i < h.length; i += 2) bytes.push(parseInt((h.slice(i, i + 2) + '0').slice(0, 2), 16));
  } else {
    bytes = [];
    const t = raw.slice(1, -1);
    for (let i = 0; i < t.length; i++) {
      let c = t[i];
      if (c !== '\\') { bytes.push(c.charCodeAt(0) & 0xff); continue; }
      c = t[++i];
      const map = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
      if (c in map) bytes.push(map[c]);
      else if (/[0-7]/.test(c)) { let o = c; while (o.length < 3 && /[0-7]/.test(t[i + 1])) o += t[++i]; bytes.push(parseInt(o, 8) & 0xff); }
      else if (c === '\r' && t[i + 1] === '\n') i++;
    }
  }
  const u = Uint8Array.from(bytes);
  if (u[0] === 0xfe && u[1] === 0xff) return new TextDecoder('utf-16be').decode(u.subarray(2));
  if (u[0] === 0xef && u[1] === 0xbb && u[2] === 0xbf) return utf8.decode(u.subarray(3));
  return latin1.decode(u);
}
const isStringTok = v => v[0] === '(' || (v[0] === '<' && v[1] !== '<');

async function inflateZlib(u) {
  const s = new Blob([u]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** Neutralize a JPEG's metadata segments in place (same length). Returns true if any leaked. */
function jpegInPlace(buf, a, b, doScrub) {
  if (!(buf[a] === 0xff && buf[a + 1] === 0xd8)) return false;
  let i = a + 2, leaked = false;
  while (i + 4 <= b && buf[i] === 0xff) {
    const m = buf[i + 1];
    if (m === 0xda || m === 0xd9) break;
    const len = (buf[i + 2] << 8) | buf[i + 3];
    const p0 = i + 4, p1 = i + 2 + len;
    const tag = latin1.decode(buf.subarray(p0, Math.min(p0 + 12, p1)));
    const keep = (m === 0xe0 && tag.startsWith('JFIF')) || (m === 0xe2 && tag.startsWith('ICC_PROFILE')) || (m === 0xee && tag.startsWith('Adobe'));
    if ((m >= 0xe0 && m <= 0xef || m === 0xfe) && !keep) {
      let any = false;
      for (let k = p0; k < p1; k++) if (buf[k]) { any = true; break; }
      if (any) { leaked = true; if (doScrub) { buf[i + 1] = 0xe0; buf.fill(0, p0, p1); } }   // empty APP0: every reader skips it
    }
    i = p1;
  }
  return leaked;
}

async function pdf(d, doScrub) {
  const s = latin1.decode(d);
  const T = new PdfText(s);
  const out = doScrub ? d.slice() : null;
  const blank = (a, b) => { if (out) out.fill(0x20, a, b); };
  const put = (pos, str) => { if (out) out.set(fromLatin1(str), pos); };
  const f = [];
  let refuse = null;

  // every "N G obj" -> its dictionary (and stream, if any)
  const objs = [];
  for (const m of s.matchAll(/(?<![\d.])(\d+)\s+(\d+)\s+obj\b/g)) {
    const at = T.ws(m.index + m[0].length);
    if (s[at] !== '<' || s[at + 1] !== '<') { objs.push({ num: +m[1], at, dict: null }); continue; }
    let e;
    try { e = T.entries(at); } catch { continue; }
    const o = { num: +m[1], at, dict: e.list, end: e.end };
    const after = T.ws(e.end);
    if (s.startsWith('stream', after)) {
      let ds = after + 6;
      if (s[ds] === '\r') ds++;
      if (s[ds] === '\n') ds++;
      const L = o.dict.find(x => x.key === '/Length');
      let len = L ? Number(s.slice(L.vStart, L.vEnd)) : NaN;
      if (!Number.isInteger(len) || s.slice(ds + len, ds + len + 12).trim().indexOf('endstream') !== 0) {
        const j = s.indexOf('endstream', ds);
        len = (j < 0 ? s.length : j) - ds;
        while (len > 0 && (s[ds + len - 1] === '\n' || s[ds + len - 1] === '\r')) len--;
      }
      o.ds = ds; o.de = ds + len;
    }
    objs.push(o);
  }
  const val = (o, key) => { const x = o.dict?.find(e => e.key === key); return x ? s.slice(x.vStart, x.vEnd).trim() : null; };

  // trailers (classic + cross-reference streams)
  const trailers = [];
  for (const m of s.matchAll(/trailer\s*<</g)) { const at = m.index + m[0].length - 2; try { trailers.push({ dict: T.entries(at).list }); } catch { /* damaged */ } }
  for (const o of objs) if (o.dict && val(o, '/Type') === '/XRef') trailers.push(o);
  if (trailers.some(t => t.dict.some(e => e.key === '/Encrypt'))) {
    return { f: [F('other', 'file', 'encrypted', 'password-protected PDF', true)], refuse: 'This PDF is encrypted, so I can\'t read its hidden fields. Remove the password first, or use desktop Scrubgnome.' };
  }
  const infoNums = new Set(), plain = new Set(objs.map(o => o.num));
  let idFound = false;
  for (const t of trailers) {
    for (const e of t.dict) {
      const v = s.slice(e.vStart, e.vEnd);
      if (e.key === '/Info') { const m = /^(\d+)\s+\d+\s+R/.exec(v); if (m) infoNums.add(+m[1]); }
      if (e.key === '/ID') {
        for (const sm of v.matchAll(/<([0-9A-Fa-f\s]*)>|\(/g)) {
          if (sm[0] === '(') {
            const a = e.vStart + sm.index, b = T.stringEnd(a);
            if (/[^0]/.test(s.slice(a + 1, b - 1))) { idFound = true; put(a + 1, '0'.repeat(b - a - 2)); }
          } else {
            const hex = sm[1].replace(/\s/g, '');
            if (hex !== STATIC_ID && /[^0]/.test(hex)) {
              idFound = true;
              const a = e.vStart + sm.index + 1, n = sm[1].length;
              put(a, n === 32 ? STATIC_ID : '0'.repeat(n));
            }
          }
        }
      }
    }
  }
  if (idFound) f.push(F('other', 'trailer', 'document ID', 'fingerprint that links copies of this file'));

  const blankEntry = (e, label, where, cat) => {
    const raw = s.slice(e.vStart, e.vEnd);
    if (!isStringTok(raw)) return;
    const text = pdfString(raw).trim();
    if (!text || text === ANON) return;
    f.push(F(cat, where, label, text));
    blank(e.vStart + 1, e.vEnd - 1);
  };
  const infoCat = k => /^(Author|Company|Manager|SourceModified)$/.test(k) ? 'identity' : /Date/.test(k) ? 'time' : /^(Creator|Producer)$/.test(k) ? 'device' : 'other';

  // Info dictionaries (every saved revision)
  for (const n of infoNums) {
    if (!plain.has(n)) { refuse = 'This PDF keeps its document info in a compressed section I can\'t edit in place. Desktop Scrubgnome can clean it.'; continue; }
    for (const o of objs) if (o.num === n && o.dict) for (const e of o.dict) blankEntry(e, e.key.slice(1), 'document info', infoCat(e.key.slice(1)));
  }

  let attachments = 0, jpegs = 0;
  const filespecs = new Set(objs.filter(o => o.dict && val(o, '/Type') === '/Filespec').map(o => o.num));
  const evs = (list, key) => { const x = list.find(e => e.key === key); return x ? s.slice(x.vStart, x.vEnd).trim() : null; };
  const nameLeaks = new Set();
  const visit = list => {
    const type = evs(list, '/Type'), sub = evs(list, '/Subtype');
    // annotations: author + dates (not form fields: their /T is a field name)
    if ((type === '/Annot' || (sub && ANNOT_TYPES.test(sub))) && sub !== '/Widget') {
      for (const e of list) {
        if (e.key === '/T') blankEntry(e, 'annotation author', 'annotations', 'identity');
        if (e.key === '/M' || e.key === '/CreationDate') blankEntry(e, 'annotation date', 'annotations', 'time');
      }
    }
    // attached-file descriptors: their file names
    if (type === '/Filespec' || list.some(e => e.key === '/EF')) {
      for (const e of list) if (/^\/(F|UF|Desc)$/.test(e.key)) blankEntry(e, 'attached file name', 'attachments', 'other');
    }
    // name tree of attachments: (name) N 0 R pairs
    for (const e of list) if (e.key === '/Names' && s[e.vStart] === '[') {
      const arr = s.slice(e.vStart, e.vEnd);
      for (const m of arr.matchAll(/(\((?:[^()\\]|\\.)*\)|<[0-9A-Fa-f\s]*>)\s*(\d+)\s+\d+\s+R/g)) {
        if (!filespecs.has(+m[2])) continue;
        const a = e.vStart + m.index, raw = m[1], text = pdfString(raw).trim();
        if (text) { nameLeaks.add(text); blank(a + 1, a + raw.length - 1); }
      }
    }
  };
  for (const o of objs) {
    if (!o.dict && s[o.at] !== '[') continue;
    try { T.walk(o.at, visit); } catch { /* damaged object: skip */ }
  }
  if (nameLeaks.size) f.push(F('other', 'attachments', 'attached file names', [...nameLeaks].join(', ')));
  for (const o of objs) {
    if (!o.dict) continue;
    const type = val(o, '/Type'), sub = val(o, '/Subtype');
    // XMP metadata streams (document, pages, images)
    if (type === '/Metadata' && o.ds !== undefined) {
      const filt = val(o, '/Filter');
      let raw = d.subarray(o.ds, o.de), text = '';
      try {
        if (!filt) text = utf8.decode(raw);
        else if (/^\[?\s*\/FlateDecode\s*\]?$/.test(filt)) text = utf8.decode(await inflateZlib(raw));
        else text = '<encoded>';
      } catch { text = '<unreadable>'; }
      const readable = text.startsWith('<') && text !== '<encoded>' && text !== '<unreadable>';
      const xf = readable ? xmpFindings(text) : [F('other', 'XMP', 'metadata stream', 'encoded metadata')];
      // anything beyond an empty packet goes, recognized or not
      const empty = readable && text.replace(/<\?xpacket[^>]*\?>|\s+/g, '').replace(/<x:xmpmeta[^>]*>/, '').replace('</x:xmpmeta>', '') === '';
      if (!xf.length && readable && !empty) xf.push(F('other', 'XMP', 'metadata block', 'XMP data'));
      if (xf.length) {
        f.push(...xf);
        if (out) {
          for (const e of o.dict) if (e.key === '/Filter' || e.key === '/DecodeParms') blank(e.kStart, e.vEnd);
          const n = o.de - o.ds;
          const body = n >= MIN_XMP.length + XMP_END.length ? MIN_XMP + ' '.repeat(n - MIN_XMP.length - XMP_END.length) + XMP_END : ' '.repeat(n);
          put(o.ds, body);
        }
      }
    }
    // photos embedded as JPEG
    if (o.ds !== undefined && /^\[?\s*\/DCTDecode\s*\]?$/.test(val(o, '/Filter') || '')) {
      if (jpegInPlace(out || d, o.ds, o.de, !!out)) jpegs++;
    }
    if (o.dict.some(e => e.key === '/PieceInfo')) {
      f.push(F('device', 'app private data', 'PieceInfo', 'editor (e.g. Illustrator) private data'));
      refuse = refuse || 'This PDF carries an editor\'s private data blob I can\'t remove in place. Desktop Scrubgnome can.';
    }
  }
  if (attachments) f.push(F('other', 'attachments', 'attached files', `${attachments} file(s) hidden inside the PDF (emptied)`));
  if (jpegs) f.push(F('location', 'embedded photos', 'EXIF', `${jpegs} photo(s) carry their own hidden data (GPS/time/camera)`));

  // compressed object streams: look inside; if anything personal lives there, hand off to desktop
  for (const o of objs) {
    if (!o.dict || val(o, '/Type') !== '/ObjStm' || o.ds === undefined) continue;
    let text;
    try { text = latin1.decode(await inflateZlib(d.subarray(o.ds, o.de))); } catch { continue; }
    const first = Number(val(o, '/First')), n = Number(val(o, '/N'));
    const hdr = text.slice(0, first).trim().split(/\s+/).map(Number);
    const ST = new PdfText(text);
    for (let k = 0; k < n; k++) {
      const num = hdr[2 * k], at = ST.ws(first + hdr[2 * k + 1]);
      if (text[at] !== '<' || text[at + 1] !== '<') continue;
      let ents; try { ents = ST.entries(at).list; } catch { continue; }
      const strs = keys => ents.filter(e => keys.test(e.key) && isStringTok(text.slice(e.vStart, e.vEnd)) && pdfString(text.slice(e.vStart, e.vEnd)).trim() && pdfString(text.slice(e.vStart, e.vEnd)).trim() !== ANON);
      let hits = [];
      if (infoNums.has(num)) hits = strs(/./).map(e => F(infoCat(e.key.slice(1)), 'document info (compressed)', e.key.slice(1), pdfString(text.slice(e.vStart, e.vEnd))));
      try {
        ST.walk(at, list => {
          const g = k => { const x = list.find(e => e.key === k); return x ? text.slice(x.vStart, x.vEnd).trim() : null; };
          const sub = g('/Subtype');
          const str = e => { const raw = text.slice(e.vStart, e.vEnd); return isStringTok(raw) ? pdfString(raw).trim() : ''; };
          if ((g('/Type') === '/Annot' || ANNOT_TYPES.test(sub || '')) && sub !== '/Widget')
            for (const e of list) if (/^\/(T|M|CreationDate)$/.test(e.key) && str(e) && str(e) !== ANON)
              hits.push(F(e.key === '/T' ? 'identity' : 'time', 'annotations (compressed)', e.key.slice(1), str(e)));
          if (g('/Type') === '/Filespec')
            for (const e of list) if (/^\/(F|UF|Desc)$/.test(e.key) && str(e)) hits.push(F('other', 'attachments (compressed)', 'attached file name', str(e)));
          if (list.some(e => e.key === '/PieceInfo')) hits.push(F('device', 'app private data (compressed)', 'PieceInfo', 'editor private data'));
        });
      } catch { /* damaged: skip */ }
      if (hits.length) {
        f.push(...hits);
        refuse = refuse || 'Some of this PDF\'s hidden fields live in compressed sections I can\'t edit in place. Desktop Scrubgnome can clean it fully.';
      }
    }
  }

  const revs = (s.match(/%%EOF/g) || []).length;
  if (revs > 1) f.push(F('other', 'file structure', 'saved revisions', `${revs} saved versions inside. Their hidden fields are cleaned too, but older visible text may still be in there. Desktop Scrubgnome rewrites the file to drop them.`, true));
  return out ? { f, out, refuse } : { f, refuse };
}

// ------------------------------------------------------------------ audio

const ID3_CAT = {
  TPE1: 'identity', TPE2: 'identity', TPE3: 'identity', TPE4: 'identity', TCOM: 'identity', TEXT: 'identity', TOLY: 'identity', TOPE: 'identity',
  TCOP: 'identity', TPUB: 'identity', TENC: 'identity', TOWN: 'identity', TP1: 'identity', TP2: 'identity', TCM: 'identity', TCR: 'identity',
  TDRC: 'time', TYER: 'time', TDAT: 'time', TIME: 'time', TDOR: 'time', TORY: 'time', TDRL: 'time', TDEN: 'time', TDTG: 'time', TRDA: 'time', TYE: 'time', TDA: 'time',
  TSSE: 'device', TSS: 'device', TEN: 'identity',
};
const ID3_NAME = { TPE1: 'artist', TPE2: 'album artist', TCOM: 'composer', TENC: 'encoded by', TSSE: 'encoder', TDRC: 'recorded', TYER: 'year', TIT2: 'title', TALB: 'album',
  COMM: 'comment', APIC: 'cover art', PIC: 'cover art', TXXX: 'custom text', PRIV: 'private data', GEOB: 'embedded object', USLT: 'lyrics', TCOP: 'copyright', TP1: 'artist', TT2: 'title', TAL: 'album', TYE: 'year', COM: 'comment' };

function id3Text(b) {
  if (!b.length) return '';
  const e = b[0], t = b.subarray(1);
  const s = e === 1 ? new TextDecoder(t[0] === 0xfe ? 'utf-16be' : 'utf-16le').decode(t) : e === 2 ? new TextDecoder('utf-16be').decode(t) : e === 3 ? utf8.decode(t) : latin1.decode(t);
  return s.replace(/\u0000/g, ' ').replace(/^﻿/, '').trim();
}
function id3v2(d, off, f) {           // returns end offset of the tag
  const ver = d[off + 3], flags = d[off + 5];
  const size = ((d[off + 6] & 0x7f) << 21) | ((d[off + 7] & 0x7f) << 14) | ((d[off + 8] & 0x7f) << 7) | (d[off + 9] & 0x7f);
  const end = off + 10 + size + (flags & 0x10 ? 10 : 0);
  let p = off + 10;
  if (ver >= 3 && flags & 0x40) p += ver === 4 ? ((d[p] & 0x7f) << 21 | (d[p + 1] & 0x7f) << 14 | (d[p + 2] & 0x7f) << 7 | (d[p + 3] & 0x7f)) : 4 + ((d[p] << 24) | (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3]);
  const idLen = ver === 2 ? 3 : 4, hdr = ver === 2 ? 6 : 10;
  while (p + hdr <= off + 10 + size) {
    const id = ascii(d, p, idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const sz = ver === 2 ? (d[p + 3] << 16) | (d[p + 4] << 8) | d[p + 5]
      : ver === 4 ? ((d[p + 4] & 0x7f) << 21) | ((d[p + 5] & 0x7f) << 14) | ((d[p + 6] & 0x7f) << 7) | (d[p + 7] & 0x7f)
        : ((d[p + 4] << 24) >>> 0) + ((d[p + 5] << 16) | (d[p + 6] << 8) | d[p + 7]);
    const body = d.subarray(p + hdr, p + hdr + sz);
    const name = ID3_NAME[id] || id;
    const v = id[0] === 'T' ? id3Text(body) : id === 'APIC' || id === 'PIC' ? `picture (${body.length.toLocaleString('en-US')} bytes)` : `${body.length} bytes`;
    if (v) f.push(F(ID3_CAT[id] || 'other', `ID3v2.${ver}`, name, v));
    p += hdr + sz;
  }
  return Math.min(end, d.length);
}

function mp3(d, doScrub) {
  const f = [];
  let a = 0, b = d.length;
  while (ascii(d, a, 3) === 'ID3' && a + 10 <= b) a = id3v2(d, a, f);
  for (let guard = 0; guard < 4; guard++) {
    if (b - 128 >= a && ascii(d, b - 128, 3) === 'TAG') {
      const tv = (o, n) => latin1.decode(d.subarray(b - 128 + o, b - 128 + o + n)).replace(/\u0000/g, '').trim();
      [['title', 3, 30, 'other'], ['artist', 33, 30, 'identity'], ['album', 63, 30, 'other'], ['year', 93, 4, 'time'], ['comment', 97, 28, 'other']]
        .forEach(([k, o, n, c]) => { const v = tv(o, n); if (v) f.push(F(c, 'ID3v1', k, v)); });
      if (!f.some(x => x.where === 'ID3v1')) f.push(F('other', 'ID3v1', 'tag block', 'empty tag'));
      b -= 128;
      if (b - 227 >= a && ascii(d, b - 227, 4) === 'TAG+') b -= 227;
      continue;
    }
    if (b - 32 >= a && ascii(d, b - 32, 8) === 'APETAGEX') {
      const size = d[b - 20] | (d[b - 19] << 8) | (d[b - 18] << 16) | (d[b - 17] << 24);
      const hasHdr = d[b - 9] & 0x80;
      f.push(F('other', 'APEv2', 'tag block', `${size} bytes of tags`));
      b = Math.max(a, b - size - (hasHdr ? 32 : 0));
      continue;
    }
    if (b - 15 >= a && ascii(d, b - 9, 9) === 'LYRICS200') {
      const size = Number(ascii(d, b - 15, 6));
      f.push(F('other', 'Lyrics3', 'lyrics block', `${size} bytes`));
      b = Math.max(a, b - 15 - size);
      continue;
    }
    break;
  }
  return doScrub ? { f, out: d.slice(a, b) } : { f };
}

const VC_CAT = k => /^(ARTIST|ALBUMARTIST|AUTHOR|COMPOSER|PERFORMER|CONDUCTOR|LYRICIST|ORGANIZATION|COPYRIGHT|ENCODED[-_ ]?BY|CONTACT|LICENSE)$/.test(k) ? 'identity'
  : /DATE|YEAR|TIME/.test(k) ? 'time' : /LOCATION|GEO/.test(k) ? 'location' : /ENCODER|SOFTWARE/.test(k) ? 'device' : 'other';
function vorbisComments(b, f, where) {
  const le = o => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
  let p = 0;
  const vl = le(p); const vendor = utf8.decode(b.subarray(4, 4 + vl)); p = 4 + vl;
  if (vendor.trim()) f.push(F('device', where, 'vendor/encoder', vendor));
  const n = le(p); p += 4;
  for (let k = 0; k < n && p + 4 <= b.length; k++) {
    const l = le(p); const kv = utf8.decode(b.subarray(p + 4, p + 4 + l)); p += 4 + l;
    const i = kv.indexOf('='), key = kv.slice(0, i).toUpperCase(), v = kv.slice(i + 1);
    if (v.trim()) f.push(F(VC_CAT(key), where, key.toLowerCase(), v));
  }
}

function flac(d, doScrub) {
  const f = [];
  let a = 0;
  while (ascii(d, a, 3) === 'ID3') a = id3v2(d, a, f);
  if (ascii(d, a, 4) !== 'fLaC') throw new UnsupportedFileError('This FLAC looks damaged.');
  const keep = [];
  let p = a + 4, last = false;
  while (!last && p + 4 <= d.length) {
    last = !!(d[p] & 0x80);
    const type = d[p] & 0x7f, len = (d[p + 1] << 16) | (d[p + 2] << 8) | d[p + 3];
    const block = d.subarray(p, p + 4 + len);
    if (type === 4) vorbisComments(block.subarray(4), f, 'Vorbis comment');
    else if (type === 6) f.push(F('other', 'FLAC', 'cover art', `picture (${len.toLocaleString('en-US')} bytes)`));
    else if (type === 2) f.push(F('other', 'FLAC', 'application block', ascii(block, 4, 4)));
    if (type === 0 || type === 3 || type === 5) keep.push(block);
    p += 4 + len;
  }
  if (!doScrub) return { f };
  const audio = d.subarray(p);
  const out = new Uint8Array(4 + keep.reduce((s, k) => s + k.length, 0) + audio.length);
  out.set(fromLatin1('fLaC'), 0);
  let o = 4;
  keep.forEach((k, i) => { out.set(k, o); out[o] = (k[0] & 0x7f) | (i === keep.length - 1 ? 0x80 : 0); o += k.length; });
  out.set(audio, o);
  return { f, out };
}

const INFO_CAT = { IART: ['identity', 'artist'], ICRD: ['time', 'created'], ISFT: ['device', 'software'], ICMT: ['other', 'comment'], INAM: ['other', 'title'],
  ICOP: ['identity', 'copyright'], IENG: ['identity', 'engineer'], ITCH: ['identity', 'technician'], ISRC: ['other', 'source'], IPRD: ['other', 'album'],
  IKEY: ['other', 'keywords'], ISBJ: ['other', 'subject'], IGNR: ['other', 'genre'] };

function riffChunks(d, start, end, be) {
  const out = [];
  const u32 = o => be ? ((d[o] << 24) >>> 0) + ((d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]) : (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16)) + d[o + 3] * 0x1000000;
  let p = start;
  while (p + 8 <= end) {
    const id = ascii(d, p, 4);
    let len = u32(p + 4);
    if (len === 0xffffffff) len = end - p - 8;
    out.push({ id, p, body: d.subarray(p + 8, Math.min(end, p + 8 + len)), raw: d.subarray(p, Math.min(end, p + 8 + len + (len & 1))) });
    p += 8 + len + (len & 1);
  }
  return out;
}

function wav(d, doScrub) {
  const f = [];
  const KEEP = new Set(['fmt ', 'data', 'fact', 'ds64', 'cue ', 'smpl']);
  const kids = riffChunks(d, 12, d.length, false);
  for (const c of kids) {
    if (KEEP.has(c.id)) continue;
    if (c.id === 'LIST' && ascii(c.body, 0, 4) === 'INFO') {
      for (const s of riffChunks(c.body, 4, c.body.length, false)) {
        const [cat, name] = INFO_CAT[s.id] || ['other', s.id];
        const v = latin1.decode(s.body).replace(/\u0000/g, '').trim();
        if (v) f.push(F(cat, 'LIST/INFO', name, v));
      }
    } else if (c.id === 'bext') {
      const t = (o, n) => latin1.decode(c.body.subarray(o, o + n)).replace(/\u0000/g, '').trim();
      if (t(256, 32)) f.push(F('identity', 'bext', 'originator', t(256, 32)));
      if (t(320, 10)) f.push(F('time', 'bext', 'recorded', `${t(320, 10)} ${t(330, 8)}`));
      if (t(0, 256)) f.push(F('other', 'bext', 'description', t(0, 256)));
      if (c.body.length > 602 && t(602, c.body.length - 602)) f.push(F('device', 'bext', 'coding history', t(602, c.body.length - 602)));
    } else if (/^(id3 |ID3 )$/.test(c.id)) {
      if (ascii(c.body, 0, 3) === 'ID3') id3v2(c.body, 0, f);
    } else if (c.id === '_PMX') {
      f.push(...xmpFindings(utf8.decode(c.body)));
    } else if (!/^(JUNK|junk|PAD |FLLR)$/.test(c.id)) {
      f.push(F(c.id === 'iXML' || c.id === 'cart' ? 'identity' : 'other', 'WAV', `${c.id.trim()} chunk`, `${c.body.length.toLocaleString('en-US')} bytes`));
    }
  }
  if (!doScrub) return { f };
  const kept = kids.filter(c => KEEP.has(c.id)).map(c => c.raw);
  const out = new Uint8Array(12 + kept.reduce((s, k) => s + k.length, 0));
  out.set(d.subarray(0, 12), 0);
  let o = 12;
  for (const k of kept) { out.set(k, o); o += k.length; }
  const v = new DataView(out.buffer);
  if (ascii(out, 0, 4) === 'RIFF') v.setUint32(4, out.length - 8, true);
  else {   // RF64: real sizes live in ds64
    const ds = kids.find(c => c.id === 'ds64');
    if (ds) { const at = 12 + 8; v.setUint32(at, (out.length - 8) >>> 0, true); v.setUint32(at + 4, Math.floor((out.length - 8) / 0x100000000), true); }
  }
  return { f, out };
}

function aiff(d, doScrub) {
  const f = [];
  const KEEP = new Set(['COMM', 'SSND', 'FVER', 'MARK', 'INST', 'AESD', 'CHAN']);
  const kids = riffChunks(d, 12, d.length, true);
  for (const c of kids) {
    if (KEEP.has(c.id)) continue;
    const text = latin1.decode(c.body).replace(/\u0000/g, '').trim();
    if (c.id === 'NAME') f.push(F('other', 'AIFF', 'title', text));
    else if (c.id === 'AUTH') f.push(F('identity', 'AIFF', 'author', text));
    else if (c.id === '(c) ') f.push(F('identity', 'AIFF', 'copyright', text));
    else if (c.id === 'ANNO') f.push(F('other', 'AIFF', 'annotation', text));
    else if (c.id === 'ID3 ' && ascii(c.body, 0, 3) === 'ID3') id3v2(c.body, 0, f);
    else f.push(F('other', 'AIFF', `${c.id.trim()} chunk`, `${c.body.length} bytes`));
  }
  if (!doScrub) return { f };
  const kept = kids.filter(c => KEEP.has(c.id)).map(c => c.raw);
  const out = new Uint8Array(12 + kept.reduce((s, k) => s + k.length, 0));
  out.set(d.subarray(0, 12), 0);
  let o = 12;
  for (const k of kept) { out.set(k, o); o += k.length; }
  new DataView(out.buffer).setUint32(4, out.length - 8, false);
  return { f, out };
}

const MP4_CAT = { [mp4.CAT.LOCATION]: 'location', [mp4.CAT.DEVICE]: 'device', [mp4.CAT.SOFTWARE]: 'device', [mp4.CAT.DATES]: 'time', [mp4.CAT.CAMERA]: 'device' };
async function m4a(d, doScrub) {
  const blob = new Blob([d]);
  try {
    const a = await mp4.analyze(blob);
    const f = [...a.report.categories].map(c => F(MP4_CAT[c] || 'other', 'MP4 boxes', c, a.report.details.find(x => x) || 'removed'));
    if (a.report.recordedUtc) f.push(F('time', 'MP4 boxes', 'recorded', a.report.recordedUtc));
    if (!doScrub) return { f };
    const clean = mp4.buildClean(blob, a, 'audio/mp4');
    return { f, out: new Uint8Array(await clean.arrayBuffer()) };
  } catch (e) {
    if (e instanceof mp4.UnsupportedFormatError) throw new UnsupportedFileError(e.message);
    throw e;
  }
}

const HANDLERS = { image, pdf, ooxml, odf, epub, zip: zipAny, rtf, svg, mp3, flac, wav, aiff, m4a };
