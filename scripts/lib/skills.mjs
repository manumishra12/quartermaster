/**
 * The skill registry, checked rather than described.
 *
 * Skills are `type: git`: the harness fetches them from this repository at a ref, by path, when a
 * sandbox starts. Three things can be wrong with that arrangement and none of them are visible in
 * a spec file:
 *
 *   - an agent attaches a skill whose directory does not exist, so the fetch fails at sandbox init
 *   - a skill exists in `skills/` and no agent uses it, so it is dead documentation
 *   - the frontmatter name disagrees with the directory, so the harness registers something under
 *     a name nothing attaches to
 *
 * The first is the expensive one. A skill that cannot be fetched takes the sandbox with it, and the
 * agent then reports that it could not reach its tools - which sends whoever is debugging to the
 * connector, the token and the sandbox provider, none of which are the problem.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fromModule } from './paths.mjs';

export const SKILLS_DIR = fromModule(import.meta.url, '../../skills/');

/** Skills every agent should carry, whatever else it does. */
export const UNIVERSAL = ['untrusted-input'];

/**
 * Read one skill's frontmatter.
 *
 * Deliberately small: this validates the contract the harness relies on - a name and a description -
 * rather than parsing YAML in general. A skill with a malformed header is a skill that will register
 * with a blank description, and a blank description is what decides whether the model ever loads it.
 */
export function readSkill(dir, root = SKILLS_DIR) {
  const path = join(root, dir, 'SKILL.md');
  const source = readFileSync(path, 'utf8');

  const framed = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (!framed) return { dir, problems: ['no frontmatter block'] };

  const front = framed[1];
  const field = (key) => {
    const found = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(front);
    return found ? found[1].trim() : null;
  };

  const name = field('name');
  const description = field('description');
  const problems = [];

  if (!name) problems.push('frontmatter has no name');
  else if (name !== dir) problems.push(`frontmatter name "${name}" does not match its directory "${dir}"`);

  if (!description) problems.push('frontmatter has no description');
  else if (description.length < 60) {
    /**
     * The description is the whole of what the model sees until it decides the skill is relevant.
     * A one-liner that does not say *when* to load it means the pack is materialised in the sandbox
     * and never read, which costs the fetch and buys nothing.
     */
    problems.push('description is too short to say when the skill applies');
  } else if (!/\buse (when|whenever|for|after|once|before|during)\b/i.test(description)) {
    /**
     * The rule is that the description names a trigger, and this was checking for three spellings
     * of one. It rejected "Use after opening a pull request", which states a trigger perfectly
     * well - so the check was about phrasing rather than about the property it exists to enforce.
     */
    problems.push('description does not say when to use the skill ("Use when ...", "Use after ...")');
  }

  return { dir, name, description, body: source.slice(framed[0].length), problems };
}

/** Every skill directory in the repository. */
export function skillDirs(root = SKILLS_DIR) {
  return readdirSync(root).filter((entry) => {
    try {
      return statSync(join(root, entry, 'SKILL.md')).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Check the registry against the specs that use it.
 * Returns a list of problems; empty means the two agree.
 */
export function checkRegistry(specs, root = SKILLS_DIR) {
  const problems = [];
  const dirs = skillDirs(root);
  const known = new Set(dirs);

  for (const dir of dirs) {
    for (const problem of readSkill(dir, root).problems) problems.push(`skills/${dir}: ${problem}`);
  }

  const attached = new Map();
  for (const spec of specs) {
    const sandboxed = spec?.manifest?.config?.sandbox?.enabled === true;
    for (const skill of spec?.manifest?.skills ?? []) {
      if (!skill?.name) continue;
      attached.set(skill.name, [...(attached.get(skill.name) ?? []), spec.name]);
      if (!known.has(skill.name)) {
        problems.push(
          `${spec.name}: attaches skill "${skill.name}", which has no skills/${skill.name}/SKILL.md - ` +
            'the fetch fails at sandbox init and the agent reports it could not reach its tools',
        );
      }
    }

    /**
     * The universal skills are the guardrails, and an agent that reads anything from outside needs
     * them. An agent with no sandbox cannot carry a skill at all, so it is exempt - and has to make
     * the same case in its instructions instead.
     */
    if (!sandboxed) continue;
    const carried = new Set((spec?.manifest?.skills ?? []).map((s) => s?.name));
    for (const universal of UNIVERSAL) {
      if (!carried.has(universal)) problems.push(`${spec.name}: does not carry the "${universal}" guardrail`);
    }
  }

  for (const dir of dirs) {
    if (!attached.has(dir)) problems.push(`skills/${dir}: no agent attaches it - dead documentation`);
  }

  return problems;
}

/**
 * Whether a registered skill's path actually exists at the ref it names.
 *
 * preflight reported `Skill: handing-off registered` while every agent attaching it failed at
 * sandbox init with "the required Git skill path /opt/tf/skills/handing-off was not found". Both
 * statements were true. The skill was registered with the harness; the commit holding it had not
 * reached the branch the registration points at, because it had been committed to a different one.
 *
 * That is the shape of failure this project keeps finding: a check that passes while the thing it
 * is checking for is broken, because it verifies the nearest fact rather than the one that matters.
 * Registration is a row in the harness. What the sandbox needs is a path in a tree, and only the
 * second one is worth reporting.
 *
 * Answered from the local clone rather than over the network, so it works with no token and no
 * connectivity. A ref that cannot be resolved is reported as unknown rather than as present - the
 * check that could not run is not the check that passed.
 */
export function skillPathAtRef(manifest, run) {
  if (manifest?.type !== 'git' || !manifest?.path || !manifest?.ref) return { known: false, why: 'not a git skill' };

  for (const ref of [`origin/${manifest.ref}`, manifest.ref]) {
    const found = run(['ls-tree', '--name-only', ref, manifest.path]);
    if (found === null) continue;
    if (found.trim() === manifest.path) return { known: true, present: true, ref };
    return { known: true, present: false, ref };
  }

  return { known: false, why: `neither origin/${manifest.ref} nor ${manifest.ref} could be resolved here` };
}
