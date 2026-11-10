// Scrubgnome-File (web + Android) - UI glue. Twig's voice lives here.
// In the Android app this page runs inside a WebView with no internet permission;
// window.SGAndroid (if present) is the app's bridge for saving and sharing files.
// Author: kultrshok. MIT License.
import { scan, scrub, score, categories, dateInName, mimeFor, isClean, UnsupportedFileError } from './file.js';

const $ = id => document.getElementById(id);
const ANDROID = typeof window.SGAndroid !== 'undefined';
const INTRO = "Twig here, paperwork edition! Documents keep a diary: who wrote them, who edited them, for how long, on which computer, which printer, and every photo you pasted in still knows where it was taken. Hand me PDFs, Office files, e-books or music and I'll wipe the diary. Your words, pages and sound stay exactly as they are, and nothing leaves your phone.";

// one entry per picked file: { file, bytes, report, el, clean, cleanName, savedUri }
let items = [], busy = false, urls = [];

const twig = s => { $('twig').textContent = s; };
const show = (id, on = true) => $(id).classList.toggle('hidden', !on);
const geekOn = () => $('geek').checked;
const applyGeek = () => document.querySelectorAll('.geek').forEach(g => g.classList.toggle('hidden', !geekOn() || !g.textContent));
const progress = f => { $('prog').value = Math.round(f * 1000); };
const human = n => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const color = s => s >= 50 ? 'var(--danger)' : s > 0 ? 'var(--warn)' : 'var(--accent)';
const ICON = { 'Office document': 'DOC', OpenDocument: 'ODF', PDF: 'PDF', 'E-book (EPUB)': 'EPUB', 'ZIP archive': 'ZIP', 'RTF document': 'RTF', 'SVG drawing': 'SVG', Photo: 'IMG' };
const randomHex = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), x => x.toString(16).padStart(2, '0')).join('');
const extOf = n => (n.match(/\.[A-Za-z0-9]+$/) || [''])[0].toLowerCase();

function setBusy(b, msg) {
  busy = b;
  for (const id of ['pick', 'scrub']) $(id).disabled = b;
  show('prog', b);
  $('prog').value = 0;
  $('status').classList.remove('err');
  $('status').textContent = msg || '';
}

function fail(msg) {
  setBusy(false);
  $('status').classList.add('err');
  $('status').textContent = msg;
  twig("Well, #@%&. That didn't go to plan. Read the red bit.");
}

function reset() {
  for (const u of urls) URL.revokeObjectURL(u);
  urls = []; items = [];
  $('list').textContent = '';
  $('downloads').textContent = '';
  for (const id of ['scrub', 'savedcard', 'downloads']) show(id, false);
  $('status').textContent = '';
  $('file').value = '';
  twig(INTRO);
}

/** Plain-language summary, one line per kind of leak. */
function plainLines(findings, name) {
  const leaks = findings.filter(f => !f.info);
  const by = c => leaks.filter(f => f.cat === c);
  const list = (fs, n = 3) => [...new Set(fs.map(f => f.key === 'people' ? f.value : `${f.key}: ${f.value}`))].slice(0, n).join(' · ');
  const lines = [];
  if (by('identity').length) lines.push(['🪪', 'Who', list(by('identity'))]);
  if (by('location').length) lines.push(['📍', 'Where', list(by('location'), 2)]);
  if (by('time').length) lines.push(['🕒', 'When', list(by('time'), 2)]);
  if (by('device').length) lines.push(['💻', 'What with', list(by('device'), 2)]);
  if (by('other').length) lines.push(['🧩', 'Hidden extras', [...new Set(by('other').map(f => f.key === 'part' ? f.value : f.key))].slice(0, 5).join(', ')]);
  for (const f of findings.filter(x => x.info && x.where !== 'file name')) lines.push(['ℹ️', f.key, f.value]);
  if (dateInName(name)) lines.push(['🏷️', 'The file name', `"${dateInName(name)}" is a timestamp, so the clean copy gets a random name`]);
  return lines;
}

function render(p) {
  const el = document.createElement('div');
  el.className = 'card photo';
  const ph = document.createElement('div'); ph.className = 'ph';
  ph.textContent = p.report ? (ICON[p.report.label] || p.report.label.split(' ')[0].slice(0, 4)) : '?';
  const mid = document.createElement('div');
  const nm = document.createElement('div'); nm.className = 'name'; nm.textContent = p.file.name || 'file';
  const sz = document.createElement('div'); sz.className = 'status'; sz.style.marginTop = '0';
  sz.textContent = `${human(p.file.size)} · ${p.report ? p.report.label : 'unreadable'}`;
  mid.append(nm, sz);
  const sc = document.createElement('div'); sc.className = 'score';
  el.append(ph, mid, sc);
  if (p.error) {
    const e = document.createElement('div'); e.className = 'clean'; e.style.color = 'var(--danger)'; e.textContent = p.error;
    el.append(e);
  } else {
    const s = score(p.report.findings);
    sc.textContent = s; sc.style.color = color(s);
    const ul = document.createElement('ul'); ul.className = 'leaks';
    const lines = plainLines(p.report.findings, p.file.name);
    if (isClean(p.report.findings)) {
      const c = document.createElement('div'); c.className = 'clean'; c.textContent = 'Already squeaky clean. Suspicious… but clean.'; el.append(c);
    }
    for (const [icon, label, val] of lines) {
      const li = document.createElement('li');
      const b = document.createElement('b'); b.textContent = `${icon} ${label}: `;
      li.append(b, val);
      ul.append(li);
    }
    if (lines.length) el.append(ul);
    const g = document.createElement('div'); g.className = 'geek hidden';
    g.textContent = p.report.findings.map(f => `› [${f.info ? 'info' : f.cat}] ${f.where}: ${f.key} = ${f.value}`).join('\n');
    el.append(g);
  }
  p.el = el;
  $('list').append(el);
}

async function load(fileList) {
  if (busy || !fileList?.length) return;
  const files = [...fileList];
  reset();
  setBusy(true, 'Rummaging through the paperwork…');
  let leaky = 0, unreadable = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const p = { file };
    try {
      p.bytes = new Uint8Array(await file.arrayBuffer());
      p.report = await scan(file.name, p.bytes);
      if (!isClean(p.report.findings)) leaky++;
    } catch (e) {
      unreadable++;
      p.error = e instanceof UnsupportedFileError ? `#@%&! ${e.message}` : `Gah! Couldn't read this one: ${e.message}`;
    }
    items.push(p);
    render(p);
    progress((i + 1) / files.length);
    await new Promise(r => setTimeout(r));
  }
  setBusy(false);
  applyGeek();
  const ok = items.filter(p => !p.error).length;
  show('scrub', ok > 0);
  $('scrub').textContent = ok === 1 ? '🧹  Scrub & make a clean copy' : `🧹  Scrub all ${ok} & make clean copies`;
  if (!ok) twig("Nothing here I can work on. I do PDF, Office, OpenDocument, EPUB, ZIP, RTF, SVG, MP3, M4A, FLAC, WAV, AIFF and photos.");
  else if (!leaky) twig("Huh. Not a peep out of these. Either you're careful or someone beat me to it. You can still make fresh copies.");
  else twig(`Great gears! ${leaky === 1 ? 'This one is' : `${leaky} of these are`} gossiping about you. Hit Scrub and I'll make ${leaky === 1 ? 'it' : 'them'} forget everything.${unreadable ? ' (I skipped the ones I couldn\'t handle; see the red notes.)' : ''}`);
}

const toB64 = u8 => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); };

async function doScrub() {
  if (busy) return;
  setBusy(true, 'Scrubbing! Zap… wipe… forget…');
  const todo = items.filter(p => !p.error && !p.clean);
  let removed = 0, done = 0;
  const refused = [];
  for (let i = 0; i < todo.length; i++) {
    const p = todo[i];
    try {
      const { clean, before } = await scrub(p.file.name, p.bytes);
      removed += before.findings.filter(f => !f.info).length;
      const name = dateInName(p.file.name) ? `file_${randomHex(3)}${extOf(p.file.name)}` : p.file.name;
      const mime = mimeFor(p.file.name);
      p.clean = new File([clean], name, { type: mime, lastModified: 0 });
      if (ANDROID) p.savedUri = window.SGAndroid.save(name, mime, toB64(clean));
      p.bytes = null;
      const sc = p.el.querySelector('.score');
      sc.textContent = `${score(before.findings)} → 0`; sc.style.color = 'var(--accent)';
      const c = document.createElement('div'); c.className = 'clean';
      c.textContent = ANDROID ? `✔ Saved Download/Scrubgnome/${name} (${human(clean.length)})` : `✔ Clean copy: ${name} (${human(clean.length)})`;
      p.el.append(c);
      done++;
    } catch (e) {
      if (e instanceof UnsupportedFileError) {
        refused.push(p.file.name);
        const c = document.createElement('div'); c.className = 'clean'; c.style.color = 'var(--warn)';
        c.textContent = `⚠ Not saved: ${e.message}`;
        p.el.append(c);
      } else {
        fail(`#@%&! ${p.file.name}: ${e.message}. I didn't save it. Don't post that one; tell kultrshok.`);
        return;
      }
    }
    progress((i + 1) / todo.length);
    await new Promise(r => setTimeout(r));
  }
  setBusy(false);
  show('scrub', false);
  if (!done) { twig('Nothing I could safely clean in that batch. The yellow notes say why.'); return; }
  show('savedcard');
  $('saved').textContent = `Double-checked: nothing hidden left in ${done} clean cop${done === 1 ? 'y' : 'ies'}${ANDROID ? ', saved in Download/Scrubgnome' : ''}. Removed ${removed} snitching bits; the content itself is untouched.`
    + (refused.length ? ` Skipped ${refused.length} I couldn't clean safely here (desktop Scrubgnome can).` : '');
  const out = items.filter(p => p.clean).map(p => p.clean);
  if (ANDROID) { show('share'); show('downloads', false); }
  else {
    const canShare = navigator.canShare && navigator.canShare({ files: out });
    show('share', !!canShare);
    const dl = $('downloads');
    dl.textContent = '';
    for (const f of out) {
      const u = URL.createObjectURL(f); urls.push(u);
      const a = document.createElement('a'); a.className = 'dl'; a.href = u; a.download = f.name; a.textContent = `⬇️ ${f.name}`;
      dl.append(a);
    }
    show('downloads', !canShare);
  }
  twig(ANDROID ? 'Ha HA! Squeaky clean! Share the copies from Download/Scrubgnome, not the originals. The originals still gossip.'
    : 'Ha HA! Squeaky clean! Tap Save / share and pick "Save to Files", or send them straight to wherever they were headed.');
}

async function doShare() {
  if (ANDROID) { window.SGAndroid.share(JSON.stringify(items.filter(p => p.savedUri).map(p => p.savedUri))); return; }
  const files = items.filter(p => p.clean).map(p => p.clean);
  if (!files.length) return;
  try { await navigator.share({ files }); } catch (e) {
    if (e.name !== 'AbortError') { show('downloads'); $('status').textContent = 'Sharing hiccuped. Use the download links instead.'; }
  }
}

// Android: files shared INTO the app arrive here as [{name, b64}]
window.sgReceive = list => {
  const files = list.map(x => {
    const bin = atob(x.b64), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new File([u8], x.name);
  });
  load(files);
};

$('pick').addEventListener('click', () => !busy && $('file').click());
$('file').addEventListener('change', e => load(e.target.files));
$('scrub').addEventListener('click', doScrub);
$('share').addEventListener('click', doShare);
$('again').addEventListener('click', reset);
$('geek').addEventListener('change', applyGeek);

const main = $('main');
main.addEventListener('dragover', e => { e.preventDefault(); main.classList.add('drop'); });
main.addEventListener('dragleave', () => main.classList.remove('drop'));
main.addEventListener('drop', e => { e.preventDefault(); main.classList.remove('drop'); load(e.dataTransfer.files); });

reset();
if (ANDROID) window.SGAndroid.ready();

if (!ANDROID && 'serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
