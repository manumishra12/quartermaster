#!/usr/bin/env python3
"""
One request in on stdin, one JSON report out on stdout. The bridge between the MCP server and the
readers in `tools/documents/`.

WHY THIS FILE EXISTS AT ALL, given that `extract.py` and `requirements.py` already have command
lines. Three reasons, and the first is the one that matters:

  1. The path comes from the model. `extract.py <path>` puts a model-supplied string in argv, and
     the moment anybody wraps that call in a shell - a `subprocess.run(..., shell=True)`, a
     `child_process.exec`, a pipeline in a README - the string is a command. Here the request
     arrives as JSON on stdin and argv is fixed, so there is no argument to get wrong. The Node
     side passes argv as a list as well; this is the second lock on the same door.

  2. `requirements.py` only takes a path, and the MCP tool also accepts text pasted into the call.
     Rather than write that text to a file so the command line can read it back, the parse is
     driven from the module directly - `requirements.parse()` takes an extraction report, and a
     one-page report is six fields.

  3. Parsing requirements through the command line extracts the document twice, once for the text
     and once inside `requirements.py`. A 200-page PDF is not something to read twice because the
     process boundary was in the wrong place.

Exit codes follow `extract.py`'s convention exactly, and the reason is its reason: a caller has to
be able to tell "ran, and part of the document is missing" from "crashed".

  0  a report was produced. It may say the document is incomplete; that is in the report.
  1  this script failed. The traceback is on stderr and there is no report.

There is deliberately no exit 2 here. `extract.py` uses it so a shell script can see an incomplete
read without parsing JSON; this script's only caller parses the JSON, and a second channel saying
the same thing is a second thing to keep in agreement.

Standard library only, Python 3.9 compatible, matching the modules it drives.
"""
from __future__ import annotations

import json
import os
import sys

# `tools/documents/` holds the readers. Prepended rather than appended so a module of the same name
# somewhere else on the path cannot shadow the one this file is written against.
TOOLS = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
                     'tools', 'documents')
sys.path.insert(0, TOOLS)

import extract as extraction  # noqa: E402  - the path above is what makes this importable
import requirements as parser  # noqa: E402


def _probe():
    """
    Both binaries, asked separately.

    They fail independently and the difference decides the remedy, which is the whole reason the
    `ocr_status` tool exists: tesseract present with no rasteriser is not "OCR unavailable", and
    telling somebody to install tesseract when they already have it wastes their afternoon.
    """
    return {'ocr': extraction.ocr_status(), 'rasteriser': extraction.rasteriser_status()}


def _report_for_text(text):
    """
    An extraction report for text that never came from a file.

    Built from the modules' own constants rather than from strings typed here, so a rename in
    `extract.py` breaks this import instead of quietly producing a page whose status no longer
    means anything. The shape matches what `extract_text_file` produces for a file that decoded as
    UTF-8: one page, read in full, nothing skipped.

    `source.path` is None on purpose. There is no file, and inventing a name here would put a
    filename in a requirements report that nobody could go and look at.
    """
    page = {
        'page': 1,
        'method': extraction.METHOD_TEXT,
        'status': extraction.STATUS_READ,
        'text': text,
        'chars': len(text),
        'lines': text.count('\n') + 1 if text else 0,
        'notes': [],
    }
    return {
        'source': {'path': None, 'name': None, 'bytes': len(text.encode('utf-8')),
                   'sha256': None, 'kind': 'text'},
        'method': extraction.METHOD_TEXT,
        'page_methods': {extraction.METHOD_TEXT: 1},
        'complete': True,
        'skipped': [],
        'summary': 'The text was supplied in the call, so there was nothing to extract and nothing '
                   'to miss. What is parsed below is exactly what was sent.',
        'pages': [page],
        'text': text,
        'chars': len(text),
        'notes': ['this text was supplied in the call and did not come from a file'],
        'ocr': {'available': False, 'why': 'no extraction was run - the text was supplied directly'},
        'rasteriser': {'available': False,
                       'why': 'no extraction was run - the text was supplied directly'},
        'schema': 'quartermaster/document-extraction/1',
    }


def main(stdin=None, stdout=None):
    request = json.loads((stdin or sys.stdin).read())
    op = request.get('op')
    use_ocr = bool(request.get('use_ocr', True))
    language = request.get('language') or None
    out = stdout or sys.stdout

    if op == 'probe':
        json.dump(_probe(), out)
        return 0

    if op == 'extract':
        json.dump(extraction.extract(request['path'], use_ocr=use_ocr, language=language), out)
        return 0

    if op == 'requirements':
        if request.get('text') is not None:
            result = _report_for_text(request['text'])
        else:
            result = extraction.extract(request['path'], use_ocr=use_ocr, language=language)
        # The whole report goes in, never just its text. A list parsed from ten of twelve pages is
        # not wrong, it is incomplete, and the difference is entirely in whether `coverage` says so.
        json.dump({'extraction': result, 'parsed': parser.parse(result)}, out)
        return 0

    # An unknown op is this script's caller being wrong, which is a bug rather than a document
    # problem, so it exits 1 like any other failure here instead of returning a report.
    raise SystemExit('unknown op %r' % (op,))


if __name__ == '__main__':
    sys.exit(main())
