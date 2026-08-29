# Documents

The reader in `tools/documents/` as MCP tools, so that an agent reads the extraction report before
it reads the text - and cannot reach one without the other.

## Why it exists

The readers landed first: a standard-library PDF text layer, a layered extractor with optional OCR,
and a requirement parser. An agent could already use them, by assembling a command line in the
sandbox shell and parsing stdout. That works, and three things about it are wrong.

**The arguments are unchecked.** `--lang`, `--no-ocr` and the path are a string the model puts
together, and a forgotten `--json` gives back the human rendering, which parses as prose.

**The reply is stdout.** `extract.py` prints the report and then the text, so an agent reading the
tail of a long buffer has read the text without the report. The command line exits **2** when part
of the document was missed precisely because stdout can be skimmed past and an exit code cannot -
and nothing in a tool call has an exit code.

**The shell is not gated.** Every other guarantee in this project lives outside the model, enforced
by a connector. The document reader's lived in `skills/document-analysis/SKILL.md`, which is a
promise rather than a mechanism. This server is the mechanism.

```bash
npm run documents             # http://localhost:8799/mcp
curl -s localhost:8799/health
```

Register it once, then `npm run agents:apply`:

```bash
curl -X POST http://localhost:8790/api/v1/settings/mcp-servers \
  -H 'content-type: application/json' \
  -d '{"manifest":{"type":"remote","name":"documents","url":"http://localhost:8799/mcp",
       "description":"Read an uploaded document and say which parts could not be read. Every tool is a read, confined to one directory."}}'
```

## The three answers, which are the whole point

A page read and empty, a page that could not be read, and a page nothing tried to read **all carry
`text: ""`**. They are three different facts and an agent acts differently on each:

| `status` | Means | The mistake it prevents |
| --- | --- | --- |
| `read` | the layer ran; this is what is on the page | - |
| `partial` | text came out and some of it was lost | the dangerous one: it looks like a success |
| `needs-ocr` | the layer ran, found no text, and the page draws something | "the document has three blank pages" |
| `unavailable` | the layer that could have read it never ran; `ocr.why` says what was missing | "OCR found nothing" on a machine with no OCR |

So the reply is arranged so that `text` is never where a caller starts. `complete`, `summary` and
`skipped` are the first three keys of every response and `pages` is the last. **Key order is what a
model reads top to bottom, so key order is the affordance**, not a matter of taste, and there is a
test asserting it.

There is no joined `text` field on this server, and that is deliberate. `extract.py` produces one;
it is the single field with no page, method or status attached, which makes it the one field this
server exists to stop a caller reaching for first. The same characters are here per page with their
provenance beside them.

An unread page also stays **in** the page list, in its proper position. An agent paging through a
document meets page 2 being a scan rather than stepping from page 1 to page 3 and finding a hole in
the numbering that nothing explains.

## The two layers, and whose job is whose

This server takes a filesystem path from the model. That is the whole attack surface, and getting
the two layers the wrong way round is how it would quietly stop working.

**1. `realpath`, then a containment check against the resolved root, is the guarantee.** Every path
is handed to the operating system to resolve *first* - traversal, an absolute path, a symlink, a
symlinked directory halfway along - and only the answer is compared against the root. It does not
care how the string was spelled, which is the property a pattern check can never have:
`a/../../etc/passwd` normalises to something with no traversal left in it, and a symlink named
`notes.md` pointing at `~/.ssh/id_rsa` never contained any. Resolving after checking would pass
both. There is a test for each.

Two details that are not decoration:

- The **root itself is realpath'd at startup**. On macOS `/tmp` is a symlink to `/private/tmp`, so
  a root of `/tmp/uploads` and a file resolved to `/private/tmp/uploads/spec.pdf` share no prefix
  at all, and every honest read is refused as an escape. Both sides have to be real paths or the
  comparison is between two spellings.
- The check is `p === root || p.startsWith(root + sep)`. Without the separator, `/srv/uploads-archive`
  is admitted for a root of `/srv/uploads` - a sibling directory, nothing nested about it.

**2. The name, extension and content rules are the residue, not the boundary.** They exist for what
layer 1 permits, and layer 1 permits a great deal: the root is a directory that legitimately
contains a `.env`, a `.git`, and whatever else somebody left in their checkout. A reader who thinks
these are the security boundary will improve them into one, and the value of layer 1 is precisely
that it does not depend on how good layer 2 is.

**Layer 2 will miss a secret written in prose in a `.md` file. That is not what stops it.**

## The root, and why the default is the repository

`DOCUMENTS_ROOT` sets it. The default is the repository.

A `documents/` directory would be a tighter default, and this repository does not have one, so it
would also be an empty one. The only document here is `tools/documents/fixture/requirements.pdf`,
and a server that cannot reach its own fixture on a fresh clone is a server nobody tries. The
warehouse gets to refuse to start without its fixture because that fixture is *built* from a
checked-in seed; there is nothing to build here.

Said plainly: **the default root withholds nothing**, because every agent in this project can
already read this repository through the sandbox shell. What the root stops is the path *leaving*
the tree - `/etc/passwd`, `~/.ssh/id_rsa`, a symlink into somebody's home directory - which is
exactly the reach this server would otherwise add to a connector that has none.

An operator serving real uploads sets the tight root:

```bash
DOCUMENTS_ROOT=/work/uploads npm run documents
```

A root that does not exist is a startup failure with the reason, not four tools that refuse
everything. A connector that starts, registers, and then fails every call is worse than one that
does not start: the failure arrives in the middle of an investigation rather than during setup.

## What it refuses, and what each refusal says

| Attempt | Answer | Because |
| --- | --- | --- |
| `../../../../etc/passwd` | `outside_root` | resolved first, checked afterwards, so traversal has already normalised away |
| `/etc/passwd`, or any absolute path elsewhere | `outside_root` | an absolute path is resolved and checked like every other |
| a symlink pointing out of the root | `outside_root` | `realpath` before the check, never after |
| a path under a directory symlinked out of the root | `outside_root` | the deepest existing ancestor is resolved, so a link halfway along is followed too |
| a path that does not exist | `not_found` | **a different answer** from a file that was read and could not be parsed |
| a path that cannot be resolved at all - a symlink loop, a permission error | `unresolvable_path` | answering `not_found` would be a false statement made authoritatively |
| a directory, a pipe, a device | `not_a_file` | opening a FIFO blocks rather than fails, and would report as a slow document |
| `.env`, anything under `.git` | `refused_by_name` | a dot-file is configuration or version control, not a document |
| anything under `node_modules` | `refused_by_name` | installed packages are not this project's documents |
| `id_rsa`, `authorized_keys`, `shadow` | `refused_by_name` | never a document whatever the suffix says |
| `config.json`, `passwd`, anything without a readable suffix | `refused_by_extension` | an allowlist, naming the suffixes the extractor can read |
| `report.docx`, `.xlsx`, `.html`, `.eml` | `refused_by_extension`, **with the export to do instead** | out of scope per `DOCUMENTS.md`, and a real document deserves a next step |
| a `.docx` renamed `.pdf` | `refused_by_content` | the suffix is a claim and the bytes are the fact |
| an executable or archive with a readable suffix | `refused_by_content`, naming what it is | "contains NUL bytes" is true and says nothing |
| a file beginning with a PEM private key block | `refused_by_content` | key material is not a document in any reading |
| a file larger than `DOCUMENTS_MAX_BYTES` (32 MiB) | `file_too_large` | not read at all rather than in part - half a PDF is not half a document |
| a document the reader could not finish in time | `reader_timed_out` | **not the same as** a document with no text in it |
| the reader crashing | `reader_failed`, quoting stderr | an incomplete extraction is a success with a hole in it; a crashed reader is no answer at all |

That last row is the distinction the whole project turns on, one level up from the page. `run.py`
exits 0 whenever it produced a report, incomplete or not, so a non-zero exit really is the reader
failing rather than the document being short. Reporting the first as the second sends an agent to
fix the wrong thing.

## Nothing is ever handed to a shell

The path comes from the model. `exec` would put it in front of `/bin/sh`, at which point a filename
containing `; rm -rf ~` is two commands and every refusal above is decoration, because the string
would never have to name a file that exists.

So `run.py` takes its request as **JSON on stdin**, and argv is `[RUNNER]` and nothing else. There
is no argument for the path to be mistaken for. `shell: false` is the default on `spawnSync` and is
written out anyway, because it is the one option on that call that would undo the whole arrangement
and it deserves to be visible in the file. A test asserts the source contains no `exec(` and no
`shell: true`, with comments stripped first so the prose describing the danger cannot satisfy the
check written to prevent it.

The subprocess also gets a named environment - `PATH`, `HOME`, `TMPDIR` and the locale - rather than
the harness's own, which holds the model's credentials and is no business of a process that reads
files. The startup probe uses the same one, so a server cannot start cleanly and then fail every
call.

## Pagination, and two withholdings that are not the same fact

A long document comes back a page range at a time. **Two bounds apply and both are reported
separately**, because "you asked for ten pages and got three" and "you got ten pages and two of them
are cut off" are different things:

```json
{
  "pagination": {
    "from_page": 1, "pages_returned": 2, "pages_in_document": 12,
    "characters_returned": 40000, "characters_withheld": 8213,
    "truncated": true, "next_page": 3,
    "note": "Pages 1 to 2 of 12, with 8213 character(s) cut off... Do not summarise it as the document..."
  }
}
```

Page count alone bounds nothing: one page of a scanned contract is worth more characters than ten
pages of a memo. A page cut off says so **beside its own text** - `characters_shown` and
`text_truncated` on the page record - not in a note at the bottom of the reply.

Truncation is known rather than guessed. Inferring it from `pages.length === max_pages` would send
an agent to fetch a page that does not exist and then let it read the empty reply as a finding, so a
document of exactly `max_pages` pages reports `truncated: false`. Which is also why a range past the
end says so in its own words:

| What happened | What comes back |
| --- | --- |
| The document has pages and this range covers the last of them | `truncated: false`, `note: "...complete, with nothing cut off."` |
| The range is past the end of a shorter document | `pages_returned: 0`, `note: "...past the end of it. That is not the same as a document with nothing in it."` |
| The document has no pages at all | `pages_returned: 0`, `note: "...`skipped` says why - it is not a document that was read and found empty."` |

**A withheld page and an unread page never share a field.** A page cut off by pagination *was* read
and is one call away; a page in `skipped` was not read and calling again changes nothing. Sharing a
flag would make the second look recoverable.

## The tools, and which side of the gate they sit on

| Tool | Annotation | Gated |
| --- | --- | --- |
| `read_document` | `readOnlyHint` | no |
| `list_pages` | `readOnlyHint` | no |
| `parse_requirements` | `readOnlyHint` | no |
| `ocr_status` | `readOnlyHint` | no |

Every tool publishes annotations, and on this server that is the *only* thing that could go wrong
with the policy, because there is nothing here to gate. The selectors `@read-only`, `@write` and
`@destructive` are resolved from these hints; a tool that publishes none matches none of them and
runs ungated. The shipped deepwiki server publishes zero, which is the fail-open hole `SECURITY.md`
describes.

The spec should name all four in `enable_tools` rather than reaching them with `@read-only`, and
keep `require_approval_for_tools: ["@write", "@destructive"]` even though it gates nothing today.
Both halves are the same argument the warehouse's README makes: the tags are a standing instruction
for a tool added next week, and the admission list is where this connector actually fails closed.

`npm run tools:audit` prints what each connector publishes and what each agent's policy lets
through.

### `list_pages` before `read_document`

`list_pages` returns per-page method, status, character count and notes, and **no text**. That is
its whole reason for existing: an agent decides what it is dealing with from the report rather than
by pulling a 400-page document into context to find out. It carries the same document-level header,
so a decision made from it is made on the same facts.

### `parse_requirements` takes a path *or* text

Not both, and sending both is `ambiguous_request` rather than a guess - an agent that sent a path
and some text has made a mistake, and the useful reply says so rather than silently parsing whichever
this file happened to check first.

Every item carries `basis`, the classification in words. That field is the point: a level with no
stated basis cannot be argued with, so it cannot be corrected, so it gets believed - and the reason
to hand somebody a requirements list is so they can disagree with individual lines.

`directives` lifts out the lines written to instruct whoever is reading the document. **It is never
paged, however many there are.** `requirements.py` lifts them out precisely so that a caller which
never inspects the per-item flags cannot miss a document that is talking to it; truncating them to
fit a page budget would put the one unmissable field behind a `truncated: true`, which is the whole
failure in miniature. They are reported because they are in the document, and never obeyed, because
a document is data.

`coverage` carries the pages the extractor could not read straight through to here, because by the
time somebody is reading a requirements list nobody is reading the extraction report.

### `ocr_status` exists for one sentence

**Tesseract present with no rasteriser is not "OCR unavailable".** It is OCR that works on images and
cannot reach one particular kind of PDF page, and telling somebody to install tesseract when they
already have it wastes their afternoon. Four states, four different remedies:

| tesseract | rasteriser | What can be read | Remedy |
| --- | --- | --- | --- |
| yes | yes | everything | none |
| yes | no | image files, and a PDF page drawn as one embedded photograph | poppler only |
| no | yes | nothing scanned | tesseract only |
| no | no | nothing scanned | both |

Probed on every call and never cached. A cache would report an absence that has since been fixed,
which is the failure this tool exists to prevent, one step further along.

## Notes for anyone extending it

- **Read the two-layer note at the top of `server.mjs` before touching the name or content rules.**
  They are the residue, not the boundary. Every temptation to make them thorough is a temptation to
  make layer 1 look optional.
- **`realpath` before the check, never after.** The whole confinement is that one ordering.
- **Do not shell out.** A test asserts the source has no `exec(` and no `shell: true`.
- **If you add a tool, give it annotations.** An unannotated tool matches no selector and runs
  ungated, and here it would also want adding to `enable_tools` by hand, which is the point.
- **The suffix allowlist is duplicated** between this server and `extract.py`, because importing
  across the language boundary would mean running Python to answer a question about a filename. A
  test reads both and asserts they agree, so the duplication cannot drift in silence.
- **There is no directory listing.** An agent is given a path by whoever attached the document; it
  does not go looking. Adding one would be a second thing to confine and a second thing to get
  wrong, and nothing here needs it yet.
- **The reader runs synchronously.** `spawnSync` blocks the event loop for the length of an
  extraction, which for a scanned document with OCR can be tens of seconds. This server listens on
  loopback and serves one investigation at a time, so that is a stated limitation rather than a
  fixed one - the timeout bounds it, and the refusal says the reader did not finish rather than that
  the document was empty.
