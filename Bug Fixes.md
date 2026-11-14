# Scrubgnome-File: Bug Fixes

*What got fixed, and anything still known to bite.*

## v1.0 (2026-11-14)

**Fixed: iPhone M4A/MP4 audio could fail with "Something survived the scrub: Other tags"**
File borrows the video scrubber from Away from Home, and it had the same bug: iPhone files keep a small metadata block inside each track. Twig removed it, then failed to recognise the empty block he left behind and flagged it as leftover tags. Fixed the same way as in Away from Home.

**New: app icon.** Twig with his blank sign. On iPhone, re-add the app to the home screen to see it.

**Fixed: release builds** now start for version tags written as `V1.0` as well as `v1.0` (phone keyboards capitalise the first letter).

**Fixed: offline cache** bumped so installed iPhone apps pick up the new files.

## Known issues

- **iPhone home-screen icon doesn't update** after an app update. That's iOS; re-add the app from Safari.
- **Some PDFs are refused** (compressed personal fields or password protection). Use desktop Scrubgnome.
- **Old PDF versions** keep their (cleaned) structure; desktop Scrubgnome removes them.
- **No partial copy on failure:** if something survives, File skips that file rather than saving it.
- **OGG/Opus and WMA** aren't on the phone yet.

## Reporting a bug

Open an issue on the GitHub repo with the phone model, iOS or Android version, the file type and the exact message Twig showed. **Don't attach the file**: it contains the data you're trying to hide.

---
Author: kultrshok · MIT License · Generated with AI
