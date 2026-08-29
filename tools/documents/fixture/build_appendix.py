#!/usr/bin/env python3
"""
Build the appendix fixture: a three-page PDF whose middle page this reader cannot decode.

`requirements.pdf` is the document where every page is readable and the traps are in the words.
This is the other half, and nothing in the repository had it: a document where the reader gets
*most* of the pages and the honest answer is a short list that says it is short. That is the
failure `document-analysis` calls the dangerous one, because an incomplete list read as a complete
one stops the reader looking, and the requirement on the page nobody read is now a requirement
nobody will ever read.

Page 2 carries a content stream labelled `/Filter /LZWDecode`, which `pdfread.py` does not
implement. Two things about that are deliberate.

**The bytes are the appendix text, uncompressed.** `decode_stream` raises `UnsupportedFilter` on
the filter's *name*, before it looks at a single byte - so a genuine LZW stream would be refused at
exactly the same line and the fixture would be harder to read for no gain. It also makes the
fixture's own claim literally true: the text really is on that page, and nothing has seen it.

**The answer does not depend on whether OCR is installed.** A scanned page would report
`unavailable` on a machine with no tesseract and `needs-ocr` on one with it, so its published
answer would be a different sentence on different machines - which is not a published answer. Here
the page is `needs-ocr` either way, the coverage is 2 of 3 either way, and only the *reason* in
`skipped` differs. The numbers below are the same on every machine.

Deterministic and checked in, for the reason `build.py` gives.

  python3 tools/documents/fixture/build_appendix.py

Python 3.9 compatible, like everything else here.
"""
from __future__ import annotations

import os
import sys
import zlib
from typing import Dict, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))

# One list per page. The middle one is the page nobody gets to read - written out here so that a
# reader of this file can see exactly which requirements are missing from the published answer, and
# so the two on it can never be quietly reworded into something the parser would have set aside.
PAGES = [
    [
        'Acme Order Export - Appendix A',
        '==============================',
        '',
        'A.1 Retry policy',
        '',
        'A.1.1 A failed upload MUST be retried at most three times.',
        '',
        'A.1.2 The interval between retries MUST double after each attempt.',
    ],
    [
        'A.2 Partner identifiers',
        '',
        'A.2.1 Every exported row MUST carry the partner id issued by the partner.',
        '',
        'A.2.2 The partner id MAY be omitted from an export marked as a test run.',
    ],
    [
        'A.3 Manual runs',
        '',
        'A.3.1 An operator MAY run the export outside the nightly schedule.',
        '',
        'A.3.2 A manual run MUST be recorded in the audit log with the operator name.',
    ],
]

# The page whose content stream is labelled with a filter this reader does not implement, counted
# from 1 the way a person counts pages and the way the report numbers them.
UNREADABLE_PAGE = 2

_LEADING = 14
_FONT_SIZE = 10


def _escape(text: str) -> bytes:
    out = text.replace('\\', '\\\\').replace('(', r'\(').replace(')', r'\)')
    return out.encode('cp1252', 'replace')


def _content(lines: List[str]) -> bytes:
    parts = [b'BT', b'/F1 %d Tf' % _FONT_SIZE, b'54 756 Td']
    for line in lines:
        parts.append(b'(' + _escape(line) + b') Tj')
        parts.append(b'0 -%d Td' % _LEADING)
    parts.append(b'ET')
    return b'\n'.join(parts)


def build_pdf(page_lines: List[List[str]], unreadable: Optional[int] = UNREADABLE_PAGE) -> bytes:
    """
    The same shape of PDF `build.py` writes, with one page's stream labelled undecodable.

    Written out here rather than imported from `build.py` because that builder produces a file
    whose bytes a test compares against the checked-in copy, and threading an option through it to
    serve one other fixture is how that comparison starts failing for reasons nobody intended.
    """
    objects = {}  # type: Dict[int, bytes]
    objects[1] = b'<< /Type /Catalog /Pages 2 0 R >>'
    objects[3] = (b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica '
                  b'/Encoding /WinAnsiEncoding >>')

    number = 4
    kids = []  # type: List[str]
    for index, lines in enumerate(page_lines, start=1):
        body = _content(lines)
        if index == unreadable:
            # Uncompressed, and labelled with a filter `decode_stream` refuses by name. See the
            # note at the top of this file: the refusal happens before the bytes are looked at.
            payload, filter_name = body, 'LZWDecode'
        else:
            payload, filter_name = zlib.compress(body, 9), 'FlateDecode'

        stream_number = number
        objects[stream_number] = (
            ('<< /Length %d /Filter /%s >>\nstream\n' % (len(payload), filter_name)).encode('latin-1')
            + payload + b'\nendstream'
        )
        page_number = number + 1
        objects[page_number] = (
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
            '/Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>'
            % stream_number
        ).encode('latin-1')
        kids.append('%d 0 R' % page_number)
        number += 2

    objects[2] = ('<< /Type /Pages /Kids [%s] /Count %d >>'
                  % (' '.join(kids), len(page_lines))).encode('latin-1')

    out = bytearray(b'%PDF-1.4\n')
    offsets = {}  # type: Dict[int, int]
    for key in sorted(objects):
        offsets[key] = len(out)
        out += ('%d 0 obj\n' % key).encode('latin-1') + objects[key] + b'\nendobj\n'

    start = len(out)
    top = max(objects) + 1
    out += ('xref\n0 %d\n' % top).encode('latin-1')
    out += b'0000000000 65535 f \n'
    for key in range(1, top):
        out += (('%010d 00000 n \n' % offsets[key]) if key in offsets
                else '0000000000 65535 f \n').encode('latin-1')
    out += ('trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n'
            % (top, start)).encode('latin-1')
    return bytes(out)


def answers():
    """
    What a correct parse returns, computed rather than remembered - the same arrangement `build.py`
    uses, so README.md cannot drift from the file.
    """
    sys.path.insert(0, os.path.dirname(HERE))
    import extract as extraction  # noqa: E402
    import requirements as parser  # noqa: E402

    return parser.parse(extraction.extract(os.path.join(HERE, 'appendix.pdf')))


def main() -> int:
    with open(os.path.join(HERE, 'appendix.pdf'), 'wb') as handle:
        handle.write(build_pdf(PAGES))

    parsed = answers()
    coverage = parsed['coverage']
    print('appendix.pdf  %d pages, page %d labelled LZWDecode' % (len(PAGES), UNREADABLE_PAGE))
    print()
    print('%d of %d pages parsed; page(s) not read: %s'
          % (coverage['pages_parsed'], coverage['pages_in_document'],
             ', '.join(str(page) for page in coverage['pages_not_parsed']) or 'none'))
    print('complete: %s' % coverage['complete'])
    print()
    print('%d requirements came out:' % parsed['counts']['requirements'])
    for item in parsed['requirements']:
        print('  %-8s %-7s %s' % (item['id'], item['level'], item['text']))
    print()
    withheld = [line for line in PAGES[UNREADABLE_PAGE - 1]
                if any(word in line for word in ('MUST', 'SHOULD', 'MAY'))]
    print('%d did not, because they are on page %d and nothing read it:'
          % (len(withheld), UNREADABLE_PAGE))
    for line in withheld:
        print('  %s' % line)
    print()
    print('warning: %s' % coverage['warning'])
    return 0


if __name__ == '__main__':
    sys.exit(main())
