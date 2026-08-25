#!/usr/bin/env bash
# Hour-zero setup for the submission repo. Run AFTER the hackathon opens
# (24 Aug, 12:30 PM IST) so the first commit timestamp is inside the window.
#
#   bash scripts/bootstrap-repo.sh
set -euo pipefail

REPO_NAME="quartermaster"
OWNER="manumishra12"

command -v gh >/dev/null || { echo "gh CLI not found"; exit 1; }
[ "$(gh api user -q .login)" = "$OWNER" ] || { echo "wrong gh account - run: gh auth switch -u $OWNER"; exit 1; }

git init -b main
git config user.name  "manumishra12"
git config user.email "connectmanumishra@gmail.com"

curl -sL https://www.apache.org/licenses/LICENSE-2.0.txt >/dev/null || true
[ -f LICENSE ] || gh api /licenses/mit -q .body \
  | sed "s/\[year\]/2026/; s/\[fullname\]/Manu Mishra/" > LICENSE

git add -A
git commit -m "Initial commit: agent specs, verified-fix skill, and the broken fixture

The agent spec lives in version-controlled JSON rather than the TrueForge UI because
require_approval_for_tools is API-only today - which means the safety policy is reviewable
in a pull request instead of invisible in someone's UI state."

gh repo create "$OWNER/$REPO_NAME" --public --source=. --remote=origin \
  --description "An agent that proves its fix before it asks to publish it. Built on TrueForge."
git push -u origin main

# Everything after this lands through pull requests, never straight to main.
# That trail is the entire Best Code Quality qualifier and it cannot be reconstructed later.
gh api -X PUT "repos/$OWNER/$REPO_NAME/branches/main/protection" \
  -f "required_pull_request_reviews[required_approving_review_count]=0" \
  -F "enforce_admins=false" -F "required_status_checks=null" -F "restrictions=null" \
  >/dev/null 2>&1 && echo "main is protected - PRs only" \
  || echo "note: branch protection needs a paid plan on private repos; this repo is public so it should apply"

cat <<'NEXT'

Done. Next, by hand:
  1. Install the Qodo GitHub App on this repo - before the second commit, not after.
  2. git switch -c feat/<first-thing>   ... then open a PR. Never commit to main again.
NEXT
