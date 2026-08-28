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
import { specFiles } from './lib/spec.mjs';
import { fromModule } from './lib/paths.mjs';

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

  for (const required of attached) {
    record(
      names.includes(required),
      `Skill: ${required}`,
      names.includes(required) ? 'registered' : `not registered (found: ${names.join(', ') || 'none'})`,
      `open ${BASE} -> Settings -> Skills -> Import from GitHub, pointing at skills/${required}`,
    );
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
} catch {
  record(false, 'MCP connectors', 'could not list servers');
}

// 6. Are our specs actually on the server?
try {
  const applied = new Set(asList(await get('/api/v1/agents')).map((a) => a.name));
  const wanted = readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(AGENTS_DIR, f), 'utf8')).name);
  const missing = wanted.filter((n) => !applied.has(n));
  record(
    missing.length === 0,
    'Agents applied',
    missing.length ? `not on the server: ${missing.join(', ')}` : wanted.join(', '),
    'npm run agents:apply',
  );
} catch (err) {
  record(false, 'Agents applied', err.message, 'npm run agents:apply');
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
