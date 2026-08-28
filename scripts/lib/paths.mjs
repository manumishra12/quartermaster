/**
 * Turning a module-relative path into a path the filesystem will accept.
 *
 * `new URL('../agents/', import.meta.url).pathname` looks like the answer and is not one: a URL
 * percent-encodes, so a repository checked out under `~/Desktop/My Work/` resolves to
 * `/Users/…/My%20Work/agents/`, and every script that reads the specs fails with ENOENT naming a
 * directory that visibly exists. The same goes for any accented character in a home directory,
 * and on Windows for the leading slash a file URL keeps.
 *
 * `fileURLToPath` is the decoder for exactly this, so nothing here has to know which characters
 * need undoing. It lives in one place because the mistake was made in four.
 */
import { fileURLToPath } from 'node:url';

/** Resolve `relative` against the module at `moduleUrl`, as a real filesystem path. */
export function fromModule(moduleUrl, relative) {
  return fileURLToPath(new URL(relative, moduleUrl));
}
