# Scrubgnome-File: FAQ

*Twig's answers to the usual questions. Paperwork edition (Android app + iPhone web app).*

## The basics

**What does it do?**
It wipes the hidden diary out of documents, PDFs and audio before you send them: author and "last modified by" names, company, editing time, save-folder paths (which often include your Windows user name), printer names, preview thumbnails, revision IDs, and GPS or time in pasted photos.

**Does it upload my files?**
No. The web page is locked so it can't send data anywhere, and the Android app is a thin shell around it with no internet permission.

**Which files?**
Word, Excel, PowerPoint, OpenDocument (LibreOffice), PDF, EPUB, ZIP, RTF, SVG, MP3, M4A, FLAC, WAV, AIFF, plus photos (via Scrubgnome-Face's scrubber). Not yet on the phone: OGG/Opus and WMA. Videos go to Away from Home.

**Did it delete my comments and tracked changes?**
No, they stay in your document. The names on them become "Author" and their dates are blanked.

**Why did my e-book keep its title and author?**
Those are the book's content, not your personal data.

## PDFs

**Why won't Twig save my PDF?**
Twig cleans PDFs in place, overwriting each hidden field with a blank of exactly the same length so the pages look identical. If a PDF keeps personal fields in a compressed section that can't be edited that way, or is password-protected, he says so and won't hand you a half-clean copy. Desktop Scrubgnome rewrites those fully.

**My PDF had older saved versions. Are they gone?**
Their hidden fields are cleaned, but the old versions themselves are still in the file. Desktop Scrubgnome drops them entirely.

## iPhone

**How do I install it?**
Open **kultrshok.github.io/scrubgnome-file** in Safari, then tap **Share → Add to Home Screen**. It works offline after the first visit. Needs iOS 16.4 or newer.

**How do I save the clean copies?**
**Save / share → Save to Files**.

**The icon didn't change after an update.**
iOS doesn't refresh home-screen icons. Delete the home-screen app and add it again from Safari.

## Android

**How do I install it?**
Download the APK from **Releases** (or **Actions → latest Build APK → Artifacts**), open it, and allow installs once. Needs Android 10 or newer with an up-to-date Android System WebView. Clean copies go to `Download/Scrubgnome/`.

## Limits

**Is my document now anonymous?**
Only the hidden data is gone. A name typed in the text, a signature, a letterhead or a logo is still there, so give it a once-over.

**Why did some file names change?**
Names that contain a date get a random name instead, since the date is a leak too.

---
Author: kultrshok · MIT License · Generated with AI
