#!/usr/bin/env python3
"""Independent check of scrubbed files (Python stdlib only, so it runs anywhere):
every planted 'leak' from make_samples.py must be gone, looking inside zip members
and compressed PDF streams too, and zip-based files must still be valid archives.
Usage: python3 tools/verify.py CLEAN_DIR"""
import io, os, re, sys, zipfile, zlib

CANARIES = [b"Pat Example", b"pexample", b"pat@example.com", b"ACME Example", b"SN12345",
            b"Pixel 8 Pro", b"+33.4484", b"backyard", b"zipped by pat", b"secret.txt",
            b"Boss", b"ClientName", b"calibre", b"2026:11:07", b"2026-11-07", b"20261108"]

def blobs(name, data, depth=0):
    yield name, data
    if depth > 3:
        return
    if data[:4] == b"PK\x03\x04":
        z = zipfile.ZipFile(io.BytesIO(data))
        bad = z.testzip()
        if bad:
            raise AssertionError(f"{name}: corrupt zip member {bad}")
        for i in z.infolist():
            yield from blobs(f"{name}/{i.filename}", z.read(i), depth + 1)
    if data[:5] == b"%PDF-":
        for m in re.finditer(rb"stream\r?\n(.*?)endstream", data, re.S):
            try:
                yield f"{name}#stream", zlib.decompress(m.group(1))
            except zlib.error:
                pass

ok = True
clean = sys.argv[1]
for n in sorted(os.listdir(clean)):
    data = open(os.path.join(clean, n), "rb").read()
    left = sorted({(c.decode(), where) for where, b in blobs(n, data) for c in CANARIES if c in b})
    print(f"{n:30} {'clean' if not left else 'LEFT: ' + str(left)}")
    ok &= not left
print("VERIFY PASSED" if ok else "VERIFY FAILED")
sys.exit(0 if ok else 1)
