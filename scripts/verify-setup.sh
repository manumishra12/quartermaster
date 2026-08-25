#!/usr/bin/env bash
# Everything that becomes possible once the credentials are in the harness.
#
# Run after configuring a model provider, the GitHub connector, and a sandbox provider.
#
# It exits non-zero if any step fails. That is not a detail: this script's whole job is telling an
# operator whether the setup is sound, and the first version ended on a successful echo, so it
# returned 0 while reporting failures on screen. A verification tool that always says yes is worse
# than no verification tool, which is the argument this entire project is built on.
set -uo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

failures=0
note() {
  printf '  %-12s %s\n' "$1" "$2"
  [ "$1" = "FAILED" ] && failures=$((failures + 1))
  return 0
}

step "1. What the harness has"
npm run preflight --silent
[ $? -eq 0 ] && preflight=ok || preflight=FAILED

step "2. Applying all seven agents"
npx tsx scripts/apply-agents.ts
[ $? -eq 0 ] && apply=ok || apply=FAILED

step "3. Auditing every connector approval gate"
# deepwiki, from the shipped catalog, publishes no annotations at all - so this is checking whether
# the gate covers what the specs claim it covers, not assuming it.
npm run tools:audit --silent
[ $? -eq 0 ] && audit=ok || audit=FAILED

step "4. Smoke testing every credential-free agent"
npm run smoke --silent -- --budget 180
[ $? -eq 0 ] && smoke=ok || smoke=FAILED

step "Summary"
note "$preflight" "preflight - everything the harness needs is configured"
note "$apply" "agents    - all seven specs applied"
note "$audit" "gate      - nothing reachable runs ungated"
note "$smoke" "smoke     - every agent reached its tools"

echo
if [ "$failures" -gt 0 ]; then
  echo "  $failures step(s) failed. The setup is not verified."
  exit 1
fi
echo "  Verified."
