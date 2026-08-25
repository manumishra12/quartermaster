#!/usr/bin/env bash
# Publishes fixtures/ledger as its own public repo.
#
# It has to be separate. If the agent clones the submission repo to fix the fixture, it can also
# read ARCHITECTURE.md and DEVLOG.md - so it would be solving the problem from our notes rather
# than from the code, and the demo would prove nothing. The fixture repo contains the broken code
# and nothing else.
#
#   bash scripts/publish-fixture.sh
set -euo pipefail

OWNER="manumishra12"
REPO="ledger-fixture"
SRC="$(cd "$(dirname "$0")/.." && pwd)/fixtures/ledger"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

command -v gh >/dev/null || { echo "gh CLI not found"; exit 1; }
[ "$(gh api user -q .login)" = "$OWNER" ] || { echo "wrong gh account - run: gh auth switch -u $OWNER"; exit 1; }

cp -R "$SRC/." "$TMP/"
find "$TMP" -name __pycache__ -type d -exec rm -rf {} + 2>/dev/null || true

cd "$TMP"
git init -b main -q
git config user.name  "manumishra12"
git config user.email "connectmanumishra@gmail.com"
git add -A
git commit -q -m "A ledger package with one failing test

split_evenly drops the remainder cents, so 1000 split three ways returns 999.
The test is correct. The bug is in the implementation."

gh repo create "$OWNER/$REPO" --public --source=. --remote=origin \
  --description "Deliberately broken fixture for the Quartermaster demo. One failing test, standard library only." \
  --push

echo
echo "Fixture published: https://github.com/$OWNER/$REPO"
echo "Point the agent at it. Nothing in that repo hints at the fix."
