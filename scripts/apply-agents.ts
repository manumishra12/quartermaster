/**
 * Applies the agent specs in agents/ to a running TrueForge server.
 *
 * Tool approval policy (`require_approval_for_tools`) is API-only in TrueForge today, so the specs
 * are version-controlled JSON applied through the SDK rather than clicked into the UI. That also
 * means the safety configuration is reviewable in a pull request, which is the point.
 *
 *   npx tsx scripts/apply-agents.ts --dry-run
 *   npx tsx scripts/apply-agents.ts agents/quartermaster.v0.json
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { TrueForge, type TrueForgeApi } from '@truefoundry/trueforge-sdk';
// @ts-expect-error - plain JS helper, no types needed
import { loadEnv } from './lib/env.mjs';
// @ts-expect-error - plain JS helper, no types needed
import { validateSpec } from './lib/spec.mjs';

loadEnv();

const AGENTS_DIR = new URL('../agents/', import.meta.url).pathname;
const BASE_URL = process.env.TRUEFORGE_BASE_URL ?? 'http://localhost:8790';
const MODEL = process.env.TRUEFORGE_MODEL;

type Spec = { name: string; manifest: TrueForgeApi.AgentSpec };

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
/**
 * Skills must resolve to a public GitHub/GitLab URL - the API validates the pattern - so they
 * cannot be registered before this repo is published. Use this to smoke-test the loop until then.
 */
const noSkills = args.includes('--no-skills');
const files = args.filter((a) => !a.startsWith('--'));

function load(file: string): Spec {
  const raw = readFileSync(file, 'utf8');
  if (raw.includes('${TRUEFORGE_MODEL}') && !MODEL) {
    throw new Error(
      `${basename(file)} needs a model. Set TRUEFORGE_MODEL to a configured model FQN, e.g. TRUEFORGE_MODEL=openai/gpt-5.2`,
    );
  }
  const spec = JSON.parse(raw.replaceAll('${TRUEFORGE_MODEL}', MODEL ?? '')) as Spec;
  if (!spec.name || !spec.manifest) throw new Error(`${basename(file)} is missing name or manifest`);
  if (!spec.manifest.model?.name) throw new Error(`${basename(file)} has no model`);

  // Validate here, not only in the test suite. An edited spec was previously applied without any
  // check at all, and an unsound safety policy applies just as cleanly as a sound one.
  const problems = validateSpec(spec, basename(file)) as string[];
  if (problems.length > 0) {
    throw new Error(`${basename(file)} is not sound:\n  ${problems.join('\n  ')}`);
  }
  if (noSkills) delete (spec.manifest as { skills?: unknown }).skills;
  return spec;
}

/** The SDK's list response has changed shape between versions; accept either. */
function toArray(data: unknown): Array<{ id: string; name: string }> {
  if (Array.isArray(data)) return data as Array<{ id: string; name: string }>;
  const items = (data as { items?: unknown; agents?: unknown })?.items ?? (data as { agents?: unknown })?.agents;
  return Array.isArray(items) ? (items as Array<{ id: string; name: string }>) : [];
}

const targets = (files.length ? files : readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.json')).map((f) => join(AGENTS_DIR, f)))
  .map(load);

const seen = new Set<string>();
for (const spec of targets) {
  if (seen.has(spec.name)) throw new Error(`two specs both claim the name "${spec.name}"`);
  seen.add(spec.name);
}

if (dryRun) {
  for (const spec of targets) {
    console.log(`--- ${spec.name} ---`);
    console.log(JSON.stringify(spec.manifest, null, 2));
  }
  process.exit(0);
}

const client = new TrueForge({ baseUrl: BASE_URL, timeoutInSeconds: 600 });

/** The SDK throws typed errors with useful bodies; a stack trace here would only bury the message. */
function explain(err: unknown): string {
  const body = (err as { body?: { error?: { message?: string } } })?.body?.error?.message;
  const status = (err as { statusCode?: number })?.statusCode;
  if (body?.includes('provider not configured')) {
    return `${body}\n\nConfigure a provider at ${BASE_URL} under Settings -> Models, then set TRUEFORGE_MODEL to one of its model FQNs (dashes, not dots - e.g. openai/gpt-5-5).`;
  }
  if (body) return `${body}${status ? ` (HTTP ${status})` : ''}`;
  if ((err as { code?: string })?.code === 'ECONNREFUSED') {
    return `No TrueForge server at ${BASE_URL}. Start one with: npx @truefoundry/trueforge`;
  }
  return err instanceof Error ? err.message : String(err);
}

let existing: Map<string, string>;
try {
  const { data: listed } = await client.agents.list();
  existing = new Map(toArray(listed).map((a) => [a.name, a.id]));
} catch (err) {
  console.error(`\ncannot reach TrueForge: ${explain(err)}`);
  process.exit(1);
}

/**
 * One agent failing must not stop the others. Several agents here depend on connectors that need
 * credentials, and aborting the whole apply because GitHub is not configured would leave the
 * agents that need nothing unapplied too.
 */
const skipped: Array<{ name: string; why: string }> = [];

for (const spec of targets) {
  const id = existing.get(spec.name);
  try {
    if (id) {
      await client.agents.update(id, { manifest: spec.manifest });
      console.log(`  updated  ${spec.name}`);
    } else {
      await client.agents.create({ name: spec.name, manifest: spec.manifest });
      console.log(`  created  ${spec.name}`);
    }
  } catch (err) {
    const why = explain(err);
    skipped.push({ name: spec.name, why: why.split('\n')[0] });
    console.log(`  skipped  ${spec.name}  - ${why.split('\n')[0]}`);
  }
}

if (skipped.length) {
  console.log(`\n${skipped.length} of ${targets.length} agents need something first:`);
  for (const s of skipped) console.log(`  - ${s.name}: ${s.why}`);
  console.log('\nRun `npm run preflight` for what to configure. The rest were applied.');
  // A run where nothing applied is a failure, not a warning. CI treated it as success.
  if (skipped.length === targets.length) process.exitCode = 1;
}
