# Scrubgnome-File

*Twig's paperwork edition. Wipe the hidden diary out of your documents, PDFs and music before you send them.*

> "Great gears! That document is gossiping about who wrote it, where it was saved and which printer it met. Hand it over." — Twig

Scrubgnome-File is the document member of the Scrubgnome family, alongside desktop
[Scrubgnome](https://github.com/kultrshok/scrubgnome), the photo app
[Scrubgnome-Face](https://github.com/kultrshok/scrubgnome-face) and the video app
[Scrubgnome Away from Home](https://github.com/kultrshok/scrubgnome-afh). It does one job well:

1. **Pick** files (or *Share* them to "Scrub with Twig" from another app). One or a whole batch.
2. **See** what each one is leaking, in plain words: who, where, when, what with, and hidden extras.
3. **Scrub & save** clean copies (`Download/Scrubgnome/` on Android). Names that contain a date get a random one.
4. **Share / upload** the clean copies.

**Two flavours, one brain:**
- **Android app**: install the APK. It's a thin shell around the web app below, with **no internet permission at all**.
- **Web version for iPhone / any browser** (`web/`): open it in Safari, tap *Share → Add to Home Screen*, and it
  works like an app, even offline. The page's security policy forbids it from sending data anywhere.

---

## What gets removed

| File type | What Twig wipes |
|---|---|
| **Word, Excel, PowerPoint** | author, "last modified by", company, manager, editing time, template and save-folder paths (often containing your Windows user name), account e-mails, printer names, preview thumbnail, revision IDs that link drafts, and GPS/time in pasted photos |
| **OpenDocument** (LibreOffice) | the same kinds of things: author, dates, editing time, printer, thumbnail, pasted photos |
| **PDF** | document info (author, creator app, dates) in **every saved version**, XMP metadata, document IDs, annotation authors and dates, attached files and their names, and EXIF hidden in embedded photos |
| **EPUB, ZIP** | file dates and owner info inside the zip; everything inside is cleaned too |
| **RTF, SVG** | author/company blocks; editor names and file paths |
| **MP3, M4A, FLAC, WAV, AIFF** | artist, dates, location, encoder, comments, cover art |
| **Photos** | handed to Scrubgnome-Face's scrubber (GPS, time, phone, serials, thumbnails…) |

**Kept on purpose:** comments and tracked changes stay in your document, but the names on them become
"Author" and their dates are blanked. An e-book's own title and author are content, so they stay.

**PDFs are cleaned in place:** every hidden field is overwritten with a blank of exactly the same length, so
nothing in the file moves and every page looks identical. If a PDF keeps personal fields in a compressed
section that can't be edited that way (or is password-protected), Twig says so and won't save a half-clean
copy. Desktop Scrubgnome rewrites those fully. Same for PDFs with older saved versions: their hidden fields
are cleaned, but desktop Scrubgnome is the one that drops the old versions entirely.

**Not on the phone yet:** OGG/Opus and WMA audio (desktop Scrubgnome does them). Videos go to Away from Home.

**What it can't do:** it removes *hidden* information only. A name typed in the text, a signature, or a logo
on the page is still there, so give it a once-over.

After scrubbing, Twig re-scans every clean copy and refuses to save it if anything survived.

## Install (no app store needed)

1. Open the repo's **Actions** tab → newest green **Build APK** run → download **ScrubgnomeFile-apk** (a zip holding the APK).
   Tagged versions also show up under **Releases**.
2. Copy the APK to your phone and tap it. Android will ask you to allow installs from that app (Files/Chrome). Allow it once.
3. Requires **Android 10 or newer** with an up-to-date Android System WebView (it updates through the Play Store).

## iPhone / web version

1. Open the web app's address in Safari (published from this repo via GitHub Pages once the repo is public;
   see `.github/workflows/pages.yml`).
2. Tap **Share → Add to Home Screen**. Twig gets his own icon and works offline after the first visit.
3. **Pick files** → **Scrub all** → **Save / share** → **Save to Files**.
Needs iOS 16.4 or newer (for the built-in zip support Office files use).

## Build it yourself

**Easiest:** push to GitHub and let Actions build it (see `.github/workflows/build-apk.yml`).
Release signing uses the same four repo secrets as the other Scrubgnome apps (`SG_KEYSTORE_B64`,
`SG_KEYSTORE_PASS`, `SG_KEY_ALIAS`, `SG_KEY_PASS`). Without them you get a debug APK.

**Android Studio:** *File → Open* this folder, wait for Gradle sync, press ▶ with your phone plugged in.

**Self-test** (Node 22+ and Python 3, nothing else):
```
bash tools/selftest.sh     # scrub every sample in tools/samples, then verify independently
```
`tools/make_samples.py` regenerates the leaky samples (fake identity "Pat Example"; dev tools listed inside).

## Project layout

```
web/                          ← the app (both flavours)
├── index.html                ← one screen
├── js/file.js                ← the scrubber core (all formats)
├── js/zip.js                 ← tiny zip reader/writer (neutral dates, no extras)
├── js/face.js                ← photo scrubber, from Scrubgnome-Face
├── js/mp4.js                 ← MP4/M4A scrubber, from Scrubgnome Away from Home
├── js/app.js                 ← UI glue, Twig's voice
└── sw.js, manifest.webmanifest
app/src/main/java/com/kultrshok/scrubgnome/file/MainActivity.java   ← Android WebView shell
tools/                        ← selftest.sh, selftest.mjs, verify.py, make_samples.py, samples/
```
No third-party libraries anywhere. `web/js/file.js` + `zip.js` drop straight into other projects.

## License

MIT © kultrshok. See [LICENSE](LICENSE).

<sub>Generated with AI</sub>
