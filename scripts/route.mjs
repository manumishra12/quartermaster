#!/usr/bin/env node
/**
 * Who would take this, and why.
 *
 * `run.mjs` prints its choice and gets on with it. This answers the same question without starting
 * anything, which is what you want when the routing is what you are unsure about - and it shows
 * the losers too, because a route is easier to disagree with when you can see what it beat.
 */

import { loadAgents, route } from './lib/route.mjs';
import { authorityOf, widening } from './lib/authority.mjs';
import { readFileSync } from 'node:fs';

const request = process.argv.slice(2).join(' ');
const agents = loadAgents();

if (!request) {
  console.log('\n  usage: npm run route -- "<request>"\n');
  console.log('  What each agent says it handles:\n');
  for (const agent of agents) {
    if (!agent.routing?.handles?.length) {
      console.log(`    ${agent.name.padEnd(22)} (no routing block - reachable only with --agent)`);
      continue;
    }
    console.log(`    ${agent.name}`);
    console.log(`      handles  ${agent.routing.handles.join(', ')}`);
    if (agent.routing.avoid?.length) console.log(`      avoid    ${agent.routing.avoid.join(', ')}`);
  }
  console.log();
  process.exit(0);
}

const decision = route(request, agents);

console.log();
if (decision.decided) {
  console.log(`  ${decision.agent}  -  ${decision.why}`);
} else {
  console.log(`  Undecided: ${decision.why}.`);
  console.log('  Name one with --agent. Picking here would be a guess about authority.');
}
console.log();

const ranked = decision.scored.filter((s) => s.score !== 0);
if (ranked.length > 1) {
  console.log('  Also considered:');
  for (const other of ranked.slice(decision.decided ? 1 : 0)) {
    const on = other.matched.length ? other.matched.map((m) => `"${m}"`).join(', ') : 'nothing';
    const against = other.against.length ? `  (against: ${other.against.map((m) => `"${m}"`).join(', ')})` : '';
    console.log(`    ${String(other.score).padStart(3)}  ${other.name.padEnd(22)} ${on}${against}`);
  }
  console.log();
}

/**
 * Where this route could hand on to.
 *
 * Printed with the route because the two questions are the same question: choosing the agent is
 * choosing the authority, and the set of agents it may delegate to is part of that authority. An
 * agent that can reach everything by handing on has not been constrained by its own spec.
 */
if (decision.decided) {
  const spec = (name) => JSON.parse(readFileSync(new URL(`../agents/${name}.json`, import.meta.url), 'utf8'));
  let self;
  try {
    self = authorityOf(spec(decision.agent));
  } catch {
    process.exit(0);
  }

  const onward = agents
    .filter((a) => a.name !== decision.agent)
    .map((a) => {
      try {
        return { name: a.name, widened: widening(self, authorityOf(spec(a.name))) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const allowed = onward.filter((o) => o.widened.length === 0).map((o) => o.name);
  console.log(`  ${decision.agent} may hand on to: ${allowed.length ? allowed.join(', ') : 'nobody'}`);
  console.log(`  Every other agent would widen what this request can do, so a handoff to it is refused.`);
  console.log();
}
