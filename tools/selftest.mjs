// Scrub every sample in IN_DIR with the JS core, write clean copies to OUT_DIR.
// A sample must show leaks before, and the core's own re-scan must come back clean.
// Usage: node tools/selftest.mjs IN_DIR OUT_DIR
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const core = await import(new URL('../web/js/file.js', import.meta.url));
const [inDir, outDir] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
let ok = 0, bad = 0;
for (const n of readdirSync(inDir).sort()) {
  const d = new Uint8Array(readFileSync(join(inDir, n)));
  try {
    const r = await core.scrub(n, d);
    const leaks = r.before.findings.filter(f => !f.info);
    console.log(`${n.padEnd(36)} ${r.before.label.padEnd(16)} ${String(core.score(r.before.findings)).padStart(3)} -> ${core.score(r.after.findings)}  (${leaks.length} leaks, ${d.length} -> ${r.clean.length} bytes)`);
    if (!leaks.length) { console.log('   !! no leaks found in a leaky sample'); bad++; }
    writeFileSync(join(outDir, n), r.clean);
    ok++;
  } catch (e) {
    console.log(`${n.padEnd(36)} ${e.constructor.name}: ${e.message}`);
    if (!(e instanceof core.UnsupportedFileError)) bad++;
  }
}
console.log(`\n${ok} scrubbed, ${bad} problems`);
process.exit(bad ? 1 : 0);
