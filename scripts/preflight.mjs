/**
 * Answers one question: what is still missing before Quartermaster can run?
 *
 * Setup lives across the TrueForge UI, a Daytona account, a GitHub token, and this repo, so the
 * failure mode is a half-configured server and a confusing error three layers down. This checks
 * every layer and tells you the next thing to do.
 *
 *   npm run preflight
 */
import { readdirSync, readFileSync } from 'node:fs';
import { policiesFor } from './lib/policies.mjs';
import { describeConnectorFailure } from './lib/connector-advice.mjs';
import { join } from 'node:path';
import { classify, ungatedRisks } from './lib/annotations.mjs';
import { loadEnv } from './lib/env.mjs';
import { routingConflicts, specFiles } from './lib/spec.mjs';
import { loadAgents } from './lib/route.mjs';
import { fromModule } from './lib/paths.mjs';
import { skillPathAtRef } from './lib/skills.mjs';
import { driftBetween } from './lib/drift.mjs';
import { spawnSync } from 'node:child_process';

loadEnv();

const BASE = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';
const AGENTS_DIR = fromModule(import.meta.url, '../agents/');

const results = [];
const record = (ok, label, detail, fix) => results.push({ ok, label, detail, fix });

/**
 * The approval policy the agent specs declare for a given connector.
 *
 * Reading the real policy matters: checking against the library default would report a spec as
 * safe when the spec itself had narrowed the gate to nothing.
 */

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  const body = await res.json().catch(() => ({}));
  if (body.error) throw new Error(body.error.message);
  // A non-2xx body without an `error` key used to be accepted as data.
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
  return body.data ?? body;
}

const asList = (v) => (Array.isArray(v) ? v : (v?.items ?? []));

// 1. Is the harness running at all? Nothing below matters if not.
try {
  await get('/api/v1/capabilities');
  record(true, 'TrueForge server', BASE);
} catch {
  record(false, 'TrueForge server', `unreachable at ${BASE}`, 'npx @truefoundry/trueforge');
  report();
}

// 2. A model. The hard gate - agents cannot even be created without one.
let models = [];
try {
  const providers = asList(await get('/api/v1/settings/model-providers'));
  models = providers.flatMap((p) =>
    (p.manifest?.models ?? p.models ?? []).map((m) => `${p.name ?? p.manifest?.name}/${m.name}`),
  );
  record(
    models.length > 0,
    'Model provider',
    models.length ? `${models.length} models, e.g. ${models.slice(0, 3).join(', ')}` : 'none configured',
    `open ${BASE} -> Settings -> Models and paste an API key`,
  );
} catch {
  record(false, 'Model provider', 'none configured', `open ${BASE} -> Settings -> Models`);
}

// 3. Sandbox. Skills and every test run need one.
try {
  const sandbox = await get('/api/v1/settings/sandbox-providers');
  // An empty list is not a configured provider. Only a thrown request used to produce the MISS.
  const configured = Array.isArray(sandbox) ? sandbox.length > 0 : Boolean(sandbox && Object.keys(sandbox).length);
  if (!configured) throw new Error('no provider in the response');
  record(true, 'Sandbox provider', 'configured');
} catch {
  record(
    false,
    'Sandbox provider',
    'none configured - the local fallback will be used, which runs on this machine',
    `open ${BASE} -> Settings -> Sandbox providers and paste a Daytona API key`,
  );
}

// 4. The skill pack.
try {
  const skills = asList(await get('/api/v1/settings/skills'));
  const names = skills.map((s) => s.name ?? s.manifest?.name);

  /**
   * Every skill any spec attaches, read from the specs rather than listed here.
   *
   * The hardcoded pair drifted the moment the library grew: five skills were added, four agents
   * were pointed at them, and preflight went on reporting that the two it knew about were fine.
   */
  const attached = [
    ...new Set(
      specFiles()
        .flatMap(({ path }) => JSON.parse(readFileSync(path, 'utf8'))?.manifest?.skills ?? [])
        .map((skill) => skill?.name)
        .filter(Boolean),
    ),
  ].sort();

  /**
   * Resolving a ref locally, for the check below. Returns null rather than throwing so an
   * unresolvable ref is reported as unknown instead of taking preflight down with it.
   */
  const gitLsTree = (args) => {
    const out = spawnSync('git', args, { cwd: fromModule(import.meta.url, '../'), encoding: 'utf8' });
    return out.status === 0 ? out.stdout : null;
  };

  for (const required of attached) {
    const registered = names.includes(required);
    if (!registered) {
      record(false, `Skill: ${required}`, `not registered (found: ${names.join(', ') || 'none'})`,
        `open ${BASE} -> Settings -> Skills -> Import from GitHub, pointing at skills/${required}`);
      continue;
    }

    /**
     * Registered is not the same as fetchable, and reporting the first as though it were the second
     * is how this said `Skill: handing-off registered` while every agent attaching it failed at
     * sandbox init on "the required Git skill path /opt/tf/skills/handing-off was not found". Both
     * statements were true. The commit holding the skill had gone to a different branch than the one
     * the registration points at. Registration is a row in the harness; what the sandbox needs is a
     * path in a tree.
     */
    const manifest = skills.find((sk) => (sk.name ?? sk.manifest?.name) === required)?.manifest;
    const at = skillPathAtRef(manifest, gitLsTree);

    if (at.known && !at.present) {
      record(false, `Skill: ${required}`,
        `registered at ${manifest.ref}, but ${manifest.path} is not in that ref - every agent attaching it will fail at sandbox init`,
        `push the commit holding ${manifest.path} to ${manifest.ref}, or repoint the registration at a ref that has it`);
    } else if (at.known) {
      record(true, `Skill: ${required}`, `registered, and ${manifest.path} is in ${at.ref}`);
    } else {
      record(true, `Skill: ${required}`, `registered (${at.why}, so the path was not verified)`);
    }
  }

  /**
   * A skill fetched from a branch works until the branch is gone.
   *
   * This is not a failure - pointing at a branch is how you use a skill before it is merged, and
   * every skill added on a branch has to. But it is a fact that expires, and it expires silently:
   * the branch is deleted on merge, the fetch fails at sandbox init, and the agent reports that it
   * could not reach its tools. So it is stated every run rather than remembered.
   */
  const offMain = skills
    .filter((s) => (s.manifest?.ref ?? 'main') !== 'main')
    .map((s) => `${s.name ?? s.manifest?.name}@${s.manifest?.ref}`);
  if (offMain.length) {
    record(
      true,
      'Skills on a branch',
      `${offMain.join(', ')} - fine until it is merged and the branch is deleted`,
      're-point these at main once the branch lands, or the fetch fails at sandbox init',
    );
  }
} catch {
  record(false, 'Skills', 'could not list skills', `open ${BASE} -> Settings -> Skills`);
}

// 5. Connectors, and whether their approval gate is real.
try {
  const servers = asList(await get('/api/v1/settings/mcp-servers'));
  if (!servers.length) {
    record(false, 'MCP connectors', 'none connected', `open ${BASE} -> Settings -> Connectors`);
  } else {
    for (const server of servers) {
      const name = server.name ?? server.manifest?.name;
      try {
        const tools = asList(await get(`/api/v1/mcp-servers/${encodeURIComponent(name)}/tools`));
        // Audit the policy the specs actually declare for this server, not the library default.
        // A spec that narrowed or emptied its policy used to pass this check while gating nothing.
        /**
         * Each agent's policy, judged separately, weakest first.
         *
         * These were merged into one set, which audits a policy no single agent has - so one
         * agent's narrow gate was covered by another's wide one and the connector was reported ok
         * for a route `audit-tools` rejects.
         */
        const policies = policiesFor(name);
        const risks = [];
        const seenRisk = new Set();
        for (const policy of policies.length ? policies : [{ agent: null }]) {
          for (const tool of ungatedRisks(tools, policy.approval, policy.enabled)) {
            if (seenRisk.has(tool.name)) continue;
            seenRisk.add(tool.name);
            risks.push({ ...tool, agent: policy.agent });
          }
        }
        const summary = tools.map((t) => classify(t.annotations));
        const unannotated = summary.filter((k) => k === 'unannotated').length;
        record(
          risks.length === 0,
          `Connector: ${name}`,
          risks.length
            ? `${risks.length} of ${tools.length} tools would run UNGATED: ${risks.map((r) => (r.agent ? `${r.name} (via ${r.agent})` : r.name)).join(', ')}`
            : unannotated > 0
              ? `${tools.length} tools, ${unannotated} unannotated but reached by name`
              : `${tools.length} tools, all annotated`,
          'make the spec fail closed: name the tools you want in enable_tools rather than reaching them with a tag',
        );
      } catch (err) {
        /**
         * Say which of the two problems this is.
         *
         * Every failure here used to advise authenticating the connector. For a local server that
         * simply is not running - the usual case, since two of them ship in this repo and have to
         * be started - that is advice which cannot possibly work, sending someone to look for
         * credentials for a process they only needed to start. Being confidently unhelpful is the
         * failure this project is about; it does not get a pass in the tool that checks for it.
         */
        const failure = describeConnectorFailure(name, err.message, server.manifest?.url);
        record(false, `Connector: ${name}`, `cannot list tools - ${failure.reason}`, failure.advice);
      }
    }
  }

  /**
   * A connector nothing reaches is credentials sitting there for nothing.
   *
   * It is not a failure - somebody may be halfway through wiring one up - but it is worth saying
   * out loud every run, because the reason to notice is security rather than tidiness: a configured
   * server is reachable by anything that can reach the harness, and one no agent uses is blast
   * radius bought and never spent. It is also how a connector ends up connected under a name no
   * spec matches, which reads as configured and is not.
   */
  const reached = new Set(
    specFiles().flatMap(({ path }) =>
      (JSON.parse(readFileSync(path, 'utf8'))?.manifest?.mcp_servers ?? []).map((srv) => srv?.name).filter(Boolean),
    ),
  );
  const idle = servers.map((srv) => srv.manifest?.name ?? srv.name).filter((name) => name && !reached.has(name));
  if (idle.length) {
    record(
      true,
      'Connectors nothing reaches',
      `${idle.join(', ')} - configured, and no agent spec names them`,
      'either point an agent at it or remove it: a connector no agent uses is reachable for nothing',
    );
  }
} catch {
  record(false, 'MCP connectors', 'could not list servers');
}

// 6. Are our specs actually on the server, and are they the specs in this repository?
try {
  const server = asList(await get('/api/v1/agents'));
  const applied = new Set(server.map((a) => a.name));
  const files = readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.json'));
  const specs = files.map((f) => JSON.parse(readFileSync(join(AGENTS_DIR, f), 'utf8')));
  const wanted = specs.map((spec) => spec.name);
  const missing = wanted.filter((n) => !applied.has(n));
  record(
    missing.length === 0,
    'Agents applied',
    missing.length ? `not on the server: ${missing.join(', ')}` : wanted.join(', '),
    'npm run agents:apply',
  );

  /**
   * Applied is not the same as current, and reporting the first as though it were the second is how
   * nine agents ended up running against a provider whose quota was exhausted while `.env`, every
   * spec file and every document went on describing the local model. Nothing was broken in the
   * repository. Nothing was wrong in the harness. The pair disagreed, and the only way anybody found
   * out was by looking.
   *
   * `${TRUEFORGE_MODEL}` is resolved the way `apply-agents` resolves it, because comparing an
   * unresolved placeholder against a real model name would report drift on every agent every time,
   * which is the fastest way to teach somebody to ignore a check.
   */
  const model = process.env.TRUEFORGE_MODEL;
  const drifted = [];
  for (const spec of specs) {
    const live = server.find((a) => a.name === spec.name);
    if (!live) continue;
    const resolved = model ? JSON.parse(JSON.stringify(spec).replaceAll('${TRUEFORGE_MODEL}', model)) : spec;
    for (const line of driftBetween(live, resolved)) drifted.push(`${spec.name} - ${line}`);
  }

  record(
    drifted.length === 0,
    'Specs match the harness',
    drifted.length ? drifted.join('; ') : `${specs.length} agent(s) applied as this repository declares them`,
    'npm run agents:apply, or work out which side is the one you meant',
  );
} catch (err) {
  record(false, 'Agents applied', err.message, 'npm run agents:apply');
}

/**
 * Whether an unnamed request can be routed anywhere, and whether two agents fight over it.
 *
 * The router refuses to guess, which means a routing gap shows up as a question to the person
 * rather than as a wrong answer - good, but only if somebody is told before the demo rather than
 * during it. A conflict is the sharper one: it is invisible in either spec read alone.
 */
{
  const agents = loadAgents(AGENTS_DIR);
  const routable = agents.filter((a) => a.routing?.handles?.length);
  const conflicts = routingConflicts(agents);
  const silent = agents.filter((a) => !a.routing?.handles?.length).map((a) => a.name);

  record(
    conflicts.length === 0,
    'Routing',
    conflicts.length
      ? conflicts.join('; ')
      : `${routable.length} of ${agents.length} agents routable${silent.length ? ` - ${silent.join(', ')} need --agent` : ''}`,
    conflicts.length ? 'two agents claim the same phrase; narrow one of them in its routing block' : null,
  );
}

report();

function report() {
  const width = Math.max(...results.map((r) => r.label.length));
  console.log('');
  for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'MISS'}  ${r.label.padEnd(width)}  ${r.detail}`);
  }
  const blocked = results.filter((r) => !r.ok);
  if (!blocked.length) {
    console.log('\n  Ready.\n');
    process.exit(0);
  }
  console.log('\n  Next:');
  for (const r of blocked) if (r.fix) console.log(`    - ${r.label}: ${r.fix}`);
  console.log('');
  process.exit(1);
}
