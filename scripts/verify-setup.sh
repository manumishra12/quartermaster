#!/usr/bin/env bash
# Everything that becomes possible once the credentials are in the harness.
#
# Run after configuring a model provider, the GitHub connector, and a sandbox provider. It stops at
# the first thing that is still missing rather than running on and reporting a misleading result.
set -uo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

step "1. What the harness has"
npm run preflight --silent
preflight=$?

step "2. Applying all seven agents"
npx tsx scripts/apply-agents.ts

step "3. Auditing every connector's approval gate"
# The one that has been pending all week. deepwiki, from this same catalog, publishes no
# annotations at all - so if GitHub is the same, the default ["@write", "@destructive"] policy
# gates nothing on the connector where every dangerous action lives.
npm run tools:audit --silent
audit=$?

step "4. Smoke testing every credential-free agent"
npm run smoke --silent -- --budget 180
smoke=$?

step "Summary"
printf '  preflight   %s\n' "$([ $preflight -eq 0 ] && echo 'all green' || echo 'still missing something (see above)')"
printf '  gate audit  %s\n' "$([ $audit -eq 0 ] && echo 'nothing runs ungated' || echo 'NEEDS ATTENTION')"
printf '  smoke       %s\n' "$([ $smoke -eq 0 ] && echo 'every agent reached its tools' || echo 'some agents did not reach their tools')"
echo
