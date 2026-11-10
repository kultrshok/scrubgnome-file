#!/usr/bin/env bash
# Self-test: scrub every leaky sample in tools/samples with the real core (web/js/file.js),
# then check the clean copies independently (planted "leaks" must be gone, zips valid).
# Needs: Node 22+ and Python 3 (stdlib only). Regenerate samples with tools/make_samples.py.
set -euo pipefail
cd "$(dirname "$0")/.."
T=$(mktemp -d)
node tools/selftest.mjs tools/samples "$T"
python3 tools/verify.py "$T"
echo "SELF-TEST PASSED"
