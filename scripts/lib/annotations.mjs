/**
 * How TrueForge decides whether a tool needs human approval.
 *
 * Mirrors `core/mcp/toolSelectors.ts` in the harness:
 *
 *   @read-only    readOnlyHint === true
 *   @write        readOnlyHint === false and destructiveHint !== true
 *   @destructive  destructiveHint === true
 *
 * A tool publishing no annotations matches none of them, so the default policy
 * ["@write", "@destructive"] lets it through ungated. That is the case worth catching.
 */

export const READ_ONLY = 'read-only';
export const WRITE = 'write';
export const DESTRUCTIVE = 'destructive';
export const UNANNOTATED = 'unannotated';

/** Classify a tool the way the harness would. */
export function classify(annotations) {
  // Destructive is checked first on purpose. The harness treats these as independent predicates,
  // and a sloppy server can publish both readOnlyHint: true and destructiveHint: true. Reading
  // that as read-only would drop a destructive tool out of the risk list entirely, which is the
  // unsafe direction to be wrong in.
  if (annotations?.destructiveHint === true) return DESTRUCTIVE;
  if (annotations?.readOnlyHint === true) return READ_ONLY;
  if (annotations?.readOnlyHint === false) return WRITE;
  return UNANNOTATED;
}

/**
 * Whether a tool would pause for approval under the given policy.
 * Selectors are the harness tags or literal tool names.
 */
export function wouldBeGated(toolName, annotations, selectors = ['@write', '@destructive']) {
  if (!selectors?.length) return false;
  const kind = classify(annotations);
  for (const selector of selectors) {
    if (selector === '@all') return true;
    if (selector === '@write' && kind === WRITE) return true;
    if (selector === '@destructive' && kind === DESTRUCTIVE) return true;
    if (selector === toolName) return true;
  }
  return false;
}

/**
 * Tools that can act on the outside world but would run with no human gate.
 * Read-only tools are excluded: ungated is the correct outcome for them.
 */
export function ungatedRisks(tools, selectors, enableSelectors) {
  return tools.filter((tool) => {
    const kind = classify(tool.annotations);
    if (kind === READ_ONLY) return false;
    if (wouldBeGated(tool.name, tool.annotations, selectors)) return false;

    // An explicit allowlist contains the risk without needing annotations. A tool named in it is
    // deliberately reachable; a tool absent from it cannot run at all, so it is not a risk either.
    // The previous version only forgave the named ones, which meant every tool the allowlist
    // *excluded* was reported as an ungated risk - the audit contradicting the fail-closed design
    // that SECURITY.md prescribes, and failing loudest for the specs doing it right.
    if (Array.isArray(enableSelectors) && enableSelectors.length > 0) {
      const reachedByTag = enableSelectors.some((sel) => sel.startsWith('@'));
      /**
       * A name-only allowlist forgives the tools it *excludes*, not the ones it admits.
       *
       * The check stopped at "no tags, so nothing unexpected can appear" and returned false for
       * every tool - including one the allowlist deliberately enables. So a spec that enabled
       * `delete_repo` by name and gated only `@write`, which does not match a destructive tool,
       * was reported clean; `audit-tools` printed GATED beside it and exited 0 saying "the default
       * policy gates what it claims to gate". Being confidently wrong about a destructive tool is
       * the worst thing this file can do.
       */
      const admittedByName = enableSelectors.includes(tool.name);
      /**
       * The allowlist contains what the server might *add*; it does not gate what it admits.
       *
       * For an unannotated tool that containment is the whole answer, and a deliberate one: we
       * cannot tell what it does, so naming it is the strongest statement available. But a tool
       * whose annotations say destructive or write is one we *do* know about, and admitting it
       * without a gate is not contained by anything - it is simply ungated.
       */
      if (!reachedByTag && !(admittedByName && kind !== UNANNOTATED)) return false;
    }
    return true;
  });
}
