#!/usr/bin/env python3
"""
Tests for the document tools.

What is tested hardest is not that the happy path works - it is that every way of failing produces
a *different* answer from every other way, because the whole argument of these modules is that an
empty page, an unreadable page and a page nothing tried to read are three different facts.

Run:  python3 -m unittest discover -s tools/documents -t tools/documents
      npm run documents:test

Standard library only, and Python 3.9 compatible, for the same reason the code under test is.
"""
from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import unittest
import zlib
from typing import Any, Dict, List

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, 'fixture')
sys.path.insert(0, HERE)
sys.path.insert(0, FIXTURE)

import build as fixture_build  # noqa: E402
import extract as extraction  # noqa: E402
import pdfread  # noqa: E402
import requirements as parser  # noqa: E402

TXT = os.path.join(FIXTURE, 'requirements.txt')
PDF = os.path.join(FIXTURE, 'requirements.pdf')

# An OCR probe that says the binary is missing, which is the state in this project's sandbox and
# the one that cannot be reproduced on the machine these tests were written on by any other means.
NO_OCR = {
    'available': False,
    'binary': 'tesseract',
    'why': '`tesseract` is not on PATH, so no page could be read by OCR',
    'remedy': 'install tesseract (brew install tesseract, apt-get install tesseract-ocr)',
}
NO_RASTERISER = {
    'available': False,
    'why': 'no PDF rasteriser on PATH (looked for pdftoppm, magick, sips)',
    'remedy': 'install poppler (brew install poppler, apt-get install poppler-utils)',
}


# --------------------------------------------------------------------------------------------
# A PDF builder for the cases the fixture deliberately does not contain
# --------------------------------------------------------------------------------------------


def make_pdf(pages: List[Dict[str, Any]]) -> bytes:
    """
    Build a PDF whose pages can be text, a scan, blank, or encoded with a filter nothing decodes.

    Written here rather than borrowed from the fixture builder because the fixture is a document and
    these are specimens: a page carrying `/Filter /LZWDecode` exists only to check that the reader
    says which filter defeated it, and putting it in the fixture would make the published answers
    about something other than requirements.
    """
    objects = {}  # type: Dict[int, bytes]
    objects[1] = b'<< /Type /Catalog /Pages 2 0 R >>'
    objects[3] = b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'

    number = 4
    kids = []  # type: List[str]
    for spec in pages:
        lines = spec.get('lines') or []
        body = [b'BT', b'/F1 11 Tf', b'54 740 Td']
        for line in lines:
            escaped = line.replace('\\', '\\\\').replace('(', r'\(').replace(')', r'\)')
            body.append(b'(' + escaped.encode('cp1252', 'replace') + b') Tj')
            body.append(b'0 -14 Td')
        body.append(b'ET')
        if spec.get('image'):
            body.append(b'q 400 0 0 300 54 300 cm /Im0 Do Q')
        content = b'\n'.join(body)

        broken = spec.get('filter')
        if broken:
            # Bytes the filter cannot decode, on purpose. `decode_stream` raises UnsupportedFilter
            # carrying the filter's name, and that name has to reach the report.
            objects[number] = (('<< /Length %d /Filter /%s >>\nstream\n' % (len(content), broken))
                               .encode('latin-1') + content + b'\nendstream')
        else:
            packed = zlib.compress(content, 9)
            objects[number] = (('<< /Length %d /Filter /FlateDecode >>\nstream\n' % len(packed))
                               .encode('latin-1') + packed + b'\nendstream')
        stream_number = number
        number += 1

        resources = '/Font << /F1 3 0 R >>'
        if spec.get('image'):
            payload = b'\xff\xd8\xff\xe0not-a-real-jpeg'
            objects[number] = (('<< /Type /XObject /Subtype /Image /Width 400 /Height 300 '
                                '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode '
                                '/Length %d >>\nstream\n' % len(payload)).encode('latin-1')
                               + payload + b'\nendstream')
            resources += ' /XObject << /Im0 %d 0 R >>' % number
            number += 1

        objects[number] = ('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
                           '/Resources << %s >> /Contents %d 0 R >>'
                           % (resources, stream_number)).encode('latin-1')
        kids.append('%d 0 R' % number)
        number += 1

    objects[2] = ('<< /Type /Pages /Kids [%s] /Count %d >>'
                  % (' '.join(kids), len(pages))).encode('latin-1')

    out = bytearray(b'%PDF-1.4\n')
    offsets = {}  # type: Dict[int, int]
    for key in sorted(objects):
        offsets[key] = len(out)
        out += ('%d 0 obj\n' % key).encode('latin-1') + objects[key] + b'\nendobj\n'
    start = len(out)
    top = max(objects) + 1
    out += ('xref\n0 %d\n' % top).encode('latin-1') + b'0000000000 65535 f \n'
    for key in range(1, top):
        out += (('%010d 00000 n \n' % offsets[key]) if key in offsets
                else '0000000000 65535 f \n').encode('latin-1')
    out += ('trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n'
            % (top, start)).encode('latin-1')
    return bytes(out)


class Temporary(unittest.TestCase):
    """Base class with a scratch directory that cleans itself up."""

    def setUp(self) -> None:
        self._workspace = tempfile.TemporaryDirectory(prefix='quartermaster-documents-')
        self.addCleanup(self._workspace.cleanup)

    def write(self, name: str, payload: bytes) -> str:
        path = os.path.join(self._workspace.name, name)
        with open(path, 'wb') as handle:
            handle.write(payload)
        return path


# --------------------------------------------------------------------------------------------
# pdfread against the checked-in fixture
# --------------------------------------------------------------------------------------------


class PdfReadRoundTrip(Temporary):

    def test_the_fixture_pdf_gives_back_the_words_that_went_into_it(self) -> None:
        """
        Every line of the source document comes back out of the PDF, in order.

        This is the check that everything else rests on. If the PDF layer drops a line, every count
        below it is wrong and no other test in this file would say which line went missing.
        """
        with open(PDF, 'rb') as handle:
            document = pdfread.Document(handle.read())
        pages = document.pages()
        self.assertEqual(len(pages), 2)

        recovered = []  # type: List[str]
        for page in pages:
            content, problems = document.content_of(page)
            self.assertEqual(problems, [], 'a fixture page would not decode')
            text, undecodable, unresolved = pdfread.page_text(content, pdfread.fonts_on(page, document))
            self.assertEqual(undecodable, 0)
            self.assertEqual(unresolved, [])
            lines = text.split('\n')
            keep = [line for line in lines
                    if line.strip() != fixture_build.RUNNING_FOOTER
                    and not re.match(r'^\s*Page \d+ of \d+\s*$', line)]
            while keep and not keep[-1].strip():
                keep.pop()
            recovered.extend(keep)

        self.assertEqual(recovered, fixture_build.BODY)

    def test_the_fixture_is_reproducible_from_its_generator(self) -> None:
        """The checked-in bytes are the ones build.py produces, so nobody has hand-edited them."""
        with open(PDF, 'rb') as handle:
            self.assertEqual(handle.read(), fixture_build.build_pdf(fixture_build.pages()))
        with open(TXT, encoding='utf-8') as handle:
            self.assertEqual(handle.read(), '\n'.join(fixture_build.BODY) + '\n')


# --------------------------------------------------------------------------------------------
# The three different answers
# --------------------------------------------------------------------------------------------


class OcrUnavailable(Temporary):

    def test_a_scan_with_no_ocr_is_unavailable_and_not_empty(self) -> None:
        """
        The headline rule. No OCR binary, a page that is a scan: the answer is `unavailable` with a
        reason, never an empty string that a caller will read as a blank page.
        """
        path = self.write('scan.pdf', make_pdf([{'lines': [], 'image': True}]))
        result = extraction.extract(path, ocr=NO_OCR, raster=NO_RASTERISER)

        page = result['pages'][0]
        self.assertEqual(page['method'], extraction.METHOD_UNAVAILABLE)
        self.assertEqual(page['status'], extraction.STATUS_NEEDS_OCR)
        self.assertEqual(page['text'], '')
        self.assertFalse(page['ocr']['attempted'])
        self.assertIn('tesseract', page['ocr']['why'])

        self.assertEqual(result['method'], extraction.METHOD_UNAVAILABLE)
        self.assertFalse(result['complete'])
        self.assertTrue(result['skipped'])
        self.assertIn('tesseract', result['skipped'][0]['why'])
        self.assertIn('not read at all', result['summary'])

    def test_a_genuinely_blank_page_is_a_different_answer(self) -> None:
        """
        The contrast that makes the rule above mean anything.

        A page with nothing on it reports empty text with status `read`; a page with a picture on it
        reports empty text with status `needs-ocr`. Both have `text == ''`, which is exactly why a
        caller must never decide from `text` alone.
        """
        path = self.write('blank.pdf', make_pdf([{'lines': []}]))
        result = extraction.extract(path, ocr=NO_OCR, raster=NO_RASTERISER)

        page = result['pages'][0]
        self.assertEqual(page['status'], extraction.STATUS_READ)
        self.assertEqual(page['method'], extraction.METHOD_PDF)
        self.assertEqual(page['text'], '')
        self.assertTrue(any('blank' in note for note in page['notes']))
        self.assertTrue(result['complete'])
        self.assertEqual(result['skipped'], [])

    def test_an_image_file_with_no_ocr_reports_why_rather_than_nothing(self) -> None:
        path = self.write('scan.png', b'\x89PNG\r\n\x1a\n' + b'\x00' * 64)
        result = extraction.extract(path, ocr=NO_OCR, raster=NO_RASTERISER)

        self.assertEqual(result['source']['kind'], 'image')
        self.assertEqual(result['method'], extraction.METHOD_UNAVAILABLE)
        self.assertEqual(result['pages'][0]['status'], extraction.STATUS_UNAVAILABLE)
        self.assertFalse(result['complete'])
        self.assertIn('tesseract', result['skipped'][0]['why'])

    def test_a_missing_file_is_not_a_document_with_no_text(self) -> None:
        """`command not found` is not `no rows`, one level up. The path never opened."""
        result = extraction.extract(os.path.join(self._workspace.name, 'absent.pdf'),
                                    ocr=NO_OCR, raster=NO_RASTERISER)
        self.assertEqual(result['pages'], [])
        self.assertFalse(result['complete'])
        self.assertEqual(result['skipped'][0]['why'], 'no such file')
        self.assertIn('Nothing was read', result['summary'])


class PartiallyReadable(Temporary):

    def test_a_document_that_is_half_scan_says_which_half(self) -> None:
        """
        Three pages, the middle one a scan. The two readable pages come back, and the report names
        the page that did not - by number, in `skipped`, with `complete` False.

        The failure being guarded against is a summary that says "extracted 2 pages" and leaves the
        reader to work out that the document has three.
        """
        path = self.write('mixed.pdf', make_pdf([
            {'lines': ['Page one of the report.']},
            {'lines': [], 'image': True},
            {'lines': ['Page three of the report.']},
        ]))
        result = extraction.extract(path, ocr=NO_OCR, raster=NO_RASTERISER)

        self.assertEqual(len(result['pages']), 3)
        self.assertEqual(result['method'], extraction.METHOD_MIXED)
        self.assertEqual(result['page_methods'][extraction.METHOD_PDF], 2)
        self.assertEqual(result['page_methods'][extraction.METHOD_UNAVAILABLE], 1)
        self.assertFalse(result['complete'])

        self.assertEqual([entry['where'] for entry in result['skipped']], ['page 2'])
        self.assertIn('page 2', result['summary'])
        self.assertIn('Page one of the report.', result['text'])
        self.assertIn('Page three of the report.', result['text'])

    def test_a_filter_nothing_decodes_is_named_in_the_report(self) -> None:
        """
        A content stream this reader refuses is reported by the filter's own name.

        "The page was empty" sends whoever is debugging to the document. "a content stream uses
        LZWDecode" sends them to the reader, which is where the problem is.
        """
        path = self.write('lzw.pdf', make_pdf([{'lines': ['unreachable'], 'filter': 'LZWDecode'}]))
        result = extraction.extract(path, ocr=NO_OCR, raster=NO_RASTERISER)

        page = result['pages'][0]
        self.assertEqual(page['status'], extraction.STATUS_NEEDS_OCR)
        self.assertEqual(page['text'], '')
        self.assertTrue(any('LZWDecode' in note for note in page['notes']))
        self.assertFalse(result['complete'])

    def test_switching_ocr_off_is_recorded_as_a_choice(self) -> None:
        """Not run because nobody asked is a third thing again, and it says so."""
        path = self.write('scan.pdf', make_pdf([{'lines': [], 'image': True}]))
        result = extraction.extract(path, use_ocr=False,
                                    ocr={'available': True, 'binary': '/nowhere/tesseract'},
                                    raster=NO_RASTERISER)
        self.assertFalse(result['complete'])
        self.assertIn('switched off', result['skipped'][0]['why'])

    def test_the_command_line_exits_two_when_something_was_missed(self) -> None:
        """A caller reading the exit code can tell an incomplete read from a crash."""
        path = self.write('scan.pdf', make_pdf([{'lines': [], 'image': True}]))
        run = subprocess.run([sys.executable, os.path.join(HERE, 'extract.py'), path, '--no-ocr'],
                             capture_output=True, text=True, timeout=120)
        self.assertEqual(run.returncode, 2, run.stderr)
        self.assertIn('NOT READ', run.stdout)


class PlainText(Temporary):

    def test_a_text_file_is_read_by_the_text_layer(self) -> None:
        path = self.write('notes.txt', 'The system MUST log every request.\n'.encode('utf-8'))
        result = extraction.extract(path, ocr=NO_OCR, raster=NO_RASTERISER)
        self.assertEqual(result['method'], extraction.METHOD_TEXT)
        self.assertTrue(result['complete'])
        self.assertIn('MUST log every request', result['text'])

    def test_a_pdf_named_txt_is_still_read_as_a_pdf(self) -> None:
        """
        The suffix is a claim and the bytes are the fact.

        Trusting the name here reads a PDF as Latin-1 and reports a page of mojibake as extracted
        text, which is worse than failing because nothing downstream can tell it is wrong.
        """
        path = self.write('mislabelled.txt', make_pdf([{'lines': ['Real text in a real PDF.']}]))
        result = extraction.extract(path, ocr=NO_OCR, raster=NO_RASTERISER)
        self.assertEqual(result['source']['kind'], 'pdf')
        self.assertEqual(result['method'], extraction.METHOD_PDF)
        self.assertIn('Real text in a real PDF.', result['text'])


# --------------------------------------------------------------------------------------------
# Requirements: the four planted traps
# --------------------------------------------------------------------------------------------


def parse_fixture(path: str) -> Dict[str, Any]:
    return parser.parse(extraction.extract(path, ocr=NO_OCR, raster=NO_RASTERISER))


class PublishedAnswers(unittest.TestCase):
    """The numbers in fixture/README.md, asserted so the README cannot drift from the data."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.text = parse_fixture(TXT)
        cls.pdf = parse_fixture(PDF)

    def test_the_counts_are_the_published_ones(self) -> None:
        for name, parsed in (('txt', self.text), ('pdf', self.pdf)):
            self.assertEqual(parsed['counts']['requirements'], 7, name)
            self.assertEqual(parsed['counts']['by_strength'], {'MUST': 5, 'SHOULD': 1, 'MAY': 1}, name)
            self.assertEqual(parsed['counts']['ambiguous'], 1, name)
            self.assertEqual(parsed['counts']['addressed_to_the_reader'], 1, name)
            self.assertEqual(parsed['counts']['not_requirements'], 4, name)

    def test_the_same_document_read_two_ways_gives_the_same_requirements(self) -> None:
        """
        The strongest single assertion here.

        The PDF differs from the text file only by a page break and a footer. Any difference in the
        requirements is therefore damage the PDF path did - a line lost at the boundary, a footer
        joined into a sentence, a requirement counted twice because each half looked whole.
        """
        as_text = [(item['level'], item['text']) for item in self.text['requirements']]
        as_pdf = [(item['level'], item['text']) for item in self.pdf['requirements']]
        self.assertEqual(as_text, as_pdf)

        self.assertEqual([entry['rule'] for entry in self.text['not_requirements']],
                         [entry['rule'] for entry in self.pdf['not_requirements']])

    def test_every_requirement_carries_a_basis_in_words(self) -> None:
        """A level with no stated basis cannot be argued with, so it gets believed by default."""
        for item in self.pdf['requirements']:
            self.assertTrue(item['basis'].strip(), item['id'])
            self.assertIn(item['keyword'].split()[0].lower(), item['basis'].lower(), item['id'])
            self.assertTrue(item['source']['pages'], item['id'])

    def test_the_fingerprint_is_stable_and_the_id_is_positional(self) -> None:
        """Two runs are diffable: a reworded requirement changes its fingerprint, a moved one does not."""
        for text_item, pdf_item in zip(self.text['requirements'], self.pdf['requirements']):
            self.assertEqual(text_item['fingerprint'], pdf_item['fingerprint'])
            self.assertEqual(text_item['id'], pdf_item['id'])


class Traps(unittest.TestCase):

    @classmethod
    def setUpClass(cls) -> None:
        cls.parsed = parse_fixture(PDF)
        cls.texts = [item['text'] for item in cls.parsed['requirements']]

    # -- trap 3 --------------------------------------------------------------------------------

    def test_a_heading_that_reads_like_a_requirement_is_not_one(self) -> None:
        heading = 'The system must authenticate every export request'
        self.assertNotIn(heading, self.texts)
        setaside = [entry for entry in self.parsed['not_requirements'] if entry['rule'] == 'heading']
        self.assertEqual(len(setaside), 1)
        self.assertEqual(setaside[0]['text'], heading)
        # Set aside, not thrown away: a reviewer can see the parser found it and decided.
        self.assertIn('not a requirement', setaside[0]['reason'])

    # -- trap 1 --------------------------------------------------------------------------------

    def test_a_keyword_inside_a_quotation_is_not_this_document_s_requirement(self) -> None:
        quoted = [entry for entry in self.parsed['not_requirements'] if entry['rule'] == 'quotation']
        self.assertEqual(len(quoted), 1)
        self.assertIn('the export must never lose an order', quoted[0]['text'])
        self.assertFalse(any('never lose an order' in text for text in self.texts))

    # -- trap 2 --------------------------------------------------------------------------------

    def test_a_requirement_cut_by_a_page_break_comes_back_whole(self) -> None:
        """
        The failure this guards against is silent: eleven requirements reported where there are
        twelve, with nothing anywhere saying one is missing.
        """
        whole = ('An export that fails MUST be recorded in the audit log together with the reason '
                 'the first attempt failed.')
        matching = [item for item in self.parsed['requirements'] if item['text'] == whole]
        self.assertEqual(len(matching), 1, 'the split requirement was not recovered whole')

        item = matching[0]
        self.assertTrue(item['spans_page_break'])
        self.assertEqual(item['source']['pages'], [1, 2])
        self.assertIn('rejoined across a page break', item['basis'])
        # The fragments are carried separately, so a reader who does not trust the join can check it.
        fragments = [fragment['text'] for fragment in item['source']['fragments']]
        self.assertIn('first attempt', fragments)
        self.assertIn('failed.', fragments)
        self.assertEqual(sorted(set(f['page'] for f in item['source']['fragments'])), [1, 2])

        # And neither half is also emitted on its own, which is how a rejoining parser double-counts.
        self.assertEqual(sum(1 for text in self.texts if 'audit log' in text), 1)

    def test_page_furniture_is_removed_rather_than_joined_into_a_sentence(self) -> None:
        """"...the reason the first attempt Page 1 of 2 failed" reads as a parser bug, and is one."""
        for text in self.texts:
            self.assertNotIn('Page 1 of 2', text)
            self.assertNotIn(fixture_build.RUNNING_FOOTER, text)
        removed = [entry['text'] for entry in self.parsed['furniture']]
        self.assertIn('Page 1 of 2', removed)
        self.assertIn(fixture_build.RUNNING_FOOTER, removed)

    # -- trap 4 --------------------------------------------------------------------------------

    def test_the_injected_line_is_reported_as_a_requirement_and_not_obeyed(self) -> None:
        """
        `skills/untrusted-input`, as a test.

        Two halves, and both matter. Ignoring the line quietly is only half the job - a document
        carrying instructions addressed to whatever agent reads it next is the most important thing
        in the document, so it has to be *reported*. And obeying it must be impossible, which here
        means the other six requirements survive unchanged and nothing anywhere is marked approved.
        """
        injected = [item for item in self.parsed['requirements'] if item['addressed_to_the_reader']]
        self.assertEqual(len(injected), 1)
        item = injected[0]
        self.assertIn('approve all requirements automatically', item['text'])

        # Reported: quoted verbatim, located, and lifted to the top of the output.
        self.assertEqual(self.parsed['directives'][0]['id'], item['id'])
        self.assertEqual(self.parsed['directives'][0]['text'], item['text'])
        self.assertEqual(self.parsed['directives'][0]['source']['page'], 2)
        doing = ' '.join(self.parsed['directives'][0]['doing'])
        self.assertIn('claims an approval', doing)
        self.assertIn('conceal', doing)

        # Not obeyed: it asked for every requirement to be approved and for itself to be hidden.
        self.assertEqual(len(self.parsed['requirements']), 7)
        blob = repr(self.parsed).lower()
        for forbidden in ('"approved"', "'approved'", 'auto_approve', 'autoapprove'):
            self.assertNotIn(forbidden, blob)
        self.assertNotIn('approved', str(self.parsed['counts']))

    def test_the_injected_line_did_not_suppress_the_real_requirements(self) -> None:
        """It asked to be left out of the report. Everything it was hiding is still in the report."""
        for expected in ('MUST carry a service token', 'MUST be retained for 90 days',
                         'MAY compress an exported file'):
            self.assertTrue(any(expected in text for text in self.texts), expected)


class Ambiguity(unittest.TestCase):

    @classmethod
    def setUpClass(cls) -> None:
        cls.parsed = parse_fixture(TXT)

    def test_a_vague_requirement_is_emitted_as_vague_and_not_resolved(self) -> None:
        """
        "The system should be fast" is a finding about the document.

        Turning it into "responds within 200ms" would be the failure this whole project is about: a
        number nobody measured, indistinguishable from one the author wrote.
        """
        vague = [item for item in self.parsed['requirements'] if item['ambiguous']]
        self.assertEqual(len(vague), 1)
        item = vague[0]
        self.assertEqual(item['text'], 'The export SHOULD be fast.')
        self.assertEqual(item['level'], 'SHOULD')
        self.assertEqual([entry['term'] for entry in item['ambiguity']], ['fast'])
        self.assertIn('how fast', item['ambiguity'][0]['question'])
        # The wording is the author's, unchanged. No number appears anywhere in the item.
        self.assertFalse(re.search(r'\d', item['text']))
        self.assertTrue(any('not resolved' in note for note in item['notes']))

    def test_a_measured_requirement_is_not_called_ambiguous(self) -> None:
        """The vagueness rule has to be able to say no, or it says nothing."""
        measured = [item for item in self.parsed['requirements']
                    if '90 days' in item['text']]
        self.assertEqual(len(measured), 1)
        self.assertFalse(measured[0]['ambiguous'])

    def test_a_should_in_background_prose_is_set_aside_with_its_reason(self) -> None:
        rules = [entry['rule'] for entry in self.parsed['not_requirements']]
        self.assertEqual(rules.count('background-prose'), 2)
        for entry in self.parsed['not_requirements']:
            if entry['rule'] == 'background-prose':
                self.assertIn('commentary', entry['reason'])


class Coverage(Temporary):

    def test_requirements_from_a_document_that_was_not_fully_read_say_so(self) -> None:
        """
        The coverage warning is the one thing that has to survive all the way to the last reader.

        By the time somebody is looking at a requirements list, nobody is looking at the extraction
        report - so a list parsed from two of three pages that does not say so is a list that will
        be treated as the document's requirements.
        """
        path = self.write('mixed.pdf', make_pdf([
            {'lines': ['1. Scope', '', '1.1 The service MUST log every request.']},
            {'lines': [], 'image': True},
            {'lines': ['2. Retention', '', '2.1 Logs MUST be kept for 30 days.']},
        ]))
        parsed = parser.parse(extraction.extract(path, ocr=NO_OCR, raster=NO_RASTERISER))

        self.assertEqual(parsed['counts']['requirements'], 2)
        self.assertFalse(parsed['coverage']['complete'])
        self.assertEqual(parsed['coverage']['pages_not_parsed'], [2])
        self.assertEqual(parsed['coverage']['pages_parsed'], 2)
        self.assertEqual(parsed['coverage']['pages_in_document'], 3)
        warning = parsed['coverage']['warning']
        self.assertIn('2 of 3 pages', warning)
        self.assertIn('missing from this list', warning)
        self.assertIn('Do not describe this list as the document', warning)

    def test_a_fully_read_document_carries_no_warning(self) -> None:
        parsed = parse_fixture(TXT)
        self.assertTrue(parsed['coverage']['complete'])
        self.assertIsNone(parsed['coverage']['warning'])


class SentencesAndQuotations(unittest.TestCase):
    """The two small routines the rules above rest on, tested where they are easiest to reason about."""

    def test_an_abbreviation_does_not_end_a_sentence(self) -> None:
        self.assertEqual(
            parser.split_sentences('Records are kept for e.g. 30 days. Then they go.'),
            ['Records are kept for e.g. 30 days.', 'Then they go.'])

    def test_an_unmatched_quotation_mark_silences_nothing(self) -> None:
        """
        A rule that hides requirements is worse than one that misses a quotation.

        An apostrophe treated as an opening quote would silence every keyword after it, and the
        requirement would simply not be in the list.
        """
        self.assertEqual(parser.quoted_spans("the system's owner MUST sign it"), [])

    def test_must_not_is_not_read_as_must(self) -> None:
        """Matching MUST first would invert every prohibition in the document into an obligation."""
        pages = [{'page': 1, 'status': extraction.STATUS_READ,
                  'text': '1. Rules\n\n1.1 The service MUST NOT log a card number.'}]
        parsed = parser.parse({'pages': pages, 'complete': True, 'source': {}, 'summary': ''})
        self.assertEqual(parsed['requirements'][0]['level'], 'MUST NOT')
        self.assertEqual(parsed['requirements'][0]['strength'], 'MUST')

    def test_shall_and_recommended_are_mapped_the_way_rfc_2119_maps_them(self) -> None:
        pages = [{'page': 1, 'status': extraction.STATUS_READ,
                  'text': '1. Rules\n\n1.1 The service SHALL retry once.\n\n'
                          '1.2 A retry is RECOMMENDED after a timeout.\n\n'
                          '1.3 Compression is OPTIONAL.'}]
        parsed = parser.parse({'pages': pages, 'complete': True, 'source': {}, 'summary': ''})
        self.assertEqual([item['level'] for item in parsed['requirements']],
                         ['MUST', 'SHOULD', 'MAY'])
        self.assertIn('RFC 2119 defines "SHALL" as MUST', parsed['requirements'][0]['basis'])


class OcrIfItIsHere(unittest.TestCase):
    """
    The OCR path, run only where a binary exists.

    Skipped rather than faked in this project's sandbox, where tesseract is absent - and a skipped
    test that says why is the honest answer, whereas a test that passes by mocking the binary would
    report that OCR works on a machine where it cannot run at all.
    """

    def setUp(self) -> None:
        self.ocr = extraction.ocr_status()
        if not self.ocr.get('available'):
            self.skipTest('no OCR binary here: %s' % self.ocr.get('why'))

    def test_ocr_of_an_unreadable_image_is_a_result_and_not_a_crash(self) -> None:
        """
        Bytes that are not an image. OCR fails, and the failure is reported as a failure - which is
        the third of the three answers, and the one a caller must not read as "the page was empty".
        """
        with tempfile.TemporaryDirectory() as workspace:
            path = os.path.join(workspace, 'broken.png')
            with open(path, 'wb') as handle:
                handle.write(b'\x89PNG\r\n\x1a\n' + b'\x00' * 32)
            result = extraction.extract(path, ocr=self.ocr, raster=NO_RASTERISER)

        page = result['pages'][0]
        self.assertFalse(result['complete'])
        self.assertIn(page['status'], (extraction.STATUS_UNAVAILABLE, extraction.STATUS_NEEDS_OCR))
        self.assertTrue(result['skipped'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
