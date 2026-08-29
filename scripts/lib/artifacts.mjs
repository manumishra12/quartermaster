/**
 * Files the agent wrote in the sandbox, brought back out.
 *
 * Eight of the nine specs set `sandbox.file_downloads`, and until now nothing ever downloaded
 * anything - so the analytics agent could write a report to `/work/reports/` and there was no way
 * on earth to read it. A capability declared and never exercised is the "thin wrapper" criticism
 * with the evidence supplied.
 *
 * The harness's contract is a fenced block in the answer, which the SDK's own markdown renderer
 * dispatches on:
 *
 *     ```sandbox_artifacts
 *     /work/reports/revenue-may.md
 *     ```
 *
 * The interface turns that into a download control. The command line had nothing, which is the
 * surface most of this project is demonstrated from.
 */

/** Only the block the harness defines, and only paths that look like paths. */
const BLOCK = /```sandbox_artifacts\s*\n([\s\S]*?)```/g;

/**
 * The absolute sandbox paths an answer announced.
 *
 * Absolute only, and deliberately: the block is written by the model, the path is handed to the
 * harness, and a relative one has no meaning to a download endpoint anyway. Deduplicated, because
 * an agent that mentions the same report in two blocks wrote one file.
 */
export function announcedArtifacts(finalText = '') {
  const paths = new Set();

  for (const [, body] of String(finalText ?? '').matchAll(BLOCK)) {
    for (const line of body.split('\n')) {
      const path = line.trim().replace(/^[-*]\s+/, '');
      if (path.startsWith('/') && !path.includes('\n')) paths.add(path);
    }
  }

  return [...paths];
}

/**
 * The name a downloaded file gets on disk.
 *
 * Flattened to a single segment, for the same reason the session id is: this decides where a file
 * the model named ends up, and `../../` in it would put it somewhere nobody was looking. The
 * separators become dashes rather than being stripped, so two reports from different directories
 * do not collide on the same basename.
 */
export function artifactName(path) {
  const flat = String(path ?? '')
    .replace(/^\/+/, '')
    .replace(/[/\\]+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, '_');

  // All dots is not a name. It is the two things that mean "somewhere else".
  return /^[.]+$/.test(flat) || flat === '' ? 'artifact' : flat;
}
