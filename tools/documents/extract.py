#!/usr/bin/env python3
"""
Get the text out of a document, and say exactly which parts did not come out.

WHY this is a layered strategy rather than one call. A document arrives as one of three things and
they need three different tools: a text file, which needs nothing; a PDF carrying a text layer,
which needs a parser; and a scan, which needs OCR and therefore a binary. Only the first two work
with nothing installed, so the layers are tried in that order and the last one is allowed to be
missing.

THE ONE RULE. Empty text is never reported as an empty page. These are three different answers and
this module keeps them apart in three different fields, the same way `skills/sql-analysis` keeps a
query that returned no rows apart from a query that failed and from a command that never ran:

  - `read`        the layer ran, and this is what it found. An empty string here means the page is
                  genuinely blank - no text operators, no images, nothing drawn.
  - `needs-ocr`   the layer ran and found no text, but the page draws something. A scan. There is
                  text on it and this reader did not get it.
  - `unavailable` the layer that could have read it never ran, and `why` says what was missing.

A caller that only looks at `text` gets the first and third confused, which is the failure this
whole file exists to refuse - so `complete` is False and `skipped` is non-empty whenever anything
was missed, and `summary` says it in a sentence.

WHAT WORKS WITH NOTHING INSTALLED:

  - `.txt`, `.md` and anything else that decodes as text - the standard library
  - a PDF text layer - `pdfread.py`, beside this file, standard library only
  - OCR of a scanned PDF page whose scan is a single DCTDecode (JPEG) or JPXDecode (JPEG 2000)
    image XObject. Those stream bytes *are* a JPEG file, so the page can be handed to an OCR
    binary without a rasteriser. This covers the common "exported from a design tool" PDF.

WHAT NEEDS A BINARY THAT IS NOT IN THIS PROJECT'S SANDBOX:

  - OCR itself, which needs `tesseract`. Absent, every page that needed it is `unavailable` with
    the reason, and the run still succeeds - a document that is half text and half scan gives you
    the half that could be read plus an explicit list of the half that could not.
  - rasterising a PDF page that is not one embedded photograph - a page drawn from vector art, or
    tiled across many image XObjects. That needs `pdftoppm`, `magick` or `sips`, and when none of
    them is present the page is `unavailable` rather than guessed at.

Python 3.9 compatible on purpose - the project has already been bitten by 3.10-only syntax.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zlib
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import pdfread  # noqa: E402  - the path above is what makes this importable when run as a script

# --------------------------------------------------------------------------------------------
# Vocabulary
# --------------------------------------------------------------------------------------------

# The four methods the caller is promised. Nothing else ever appears in a `method` field.
METHOD_TEXT = 'text'
METHOD_PDF = 'pdf-text-layer'
METHOD_OCR = 'ocr'
METHOD_UNAVAILABLE = 'unavailable'

# A fifth value exists only at document level, and only because the alternative is a lie: a
# twelve-page PDF with ten text pages and two scans was produced by two methods, and naming either
# one of them as *the* method hides the other. `mixed` forces the reader to look at `page_methods`.
METHOD_MIXED = 'mixed'

STATUS_READ = 'read'
STATUS_NEEDS_OCR = 'needs-ocr'
STATUS_PARTIAL = 'partial'
STATUS_UNAVAILABLE = 'unavailable'

TEXT_SUFFIXES = ('.txt', '.md', '.markdown', '.text', '.rst', '.csv', '.log')
IMAGE_SUFFIXES = ('.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.gif', '.webp', '.pnm', '.ppm')

# Image filters whose decoded bytes are already a file an OCR binary opens. Writing the stream out
# untouched is not a shortcut - it is the *only* way to reach these pixels without a codec, because
# nothing in the standard library decodes JPEG.
DIRECT_IMAGE_FILTERS = {'DCTDecode': '.jpg', 'DCT': '.jpg', 'JPXDecode': '.jpf'}

# How long an OCR call is given before it is reported as a failure rather than waited on forever.
# A stuck subprocess in an agent's turn looks exactly like a hung agent to whoever is watching.
OCR_TIMEOUT_SECONDS = 120


class Skipped(object):
    """
    One thing that was not read, and why.

    A dataclass would be tidier and `@dataclass` is 3.7, but slots on a plain class keep this file
    importable by anything and the shape is four fields.
    """

    __slots__ = ('where', 'why', 'remedy')

    def __init__(self, where: str, why: str, remedy: Optional[str] = None):
        self.where = where
        self.why = why
        self.remedy = remedy

    def as_dict(self) -> Dict[str, Any]:
        out = {'where': self.where, 'why': self.why}
        if self.remedy:
            out['remedy'] = self.remedy
        return out


# --------------------------------------------------------------------------------------------
# OCR availability
# --------------------------------------------------------------------------------------------


def ocr_status(binary: str = 'tesseract') -> Dict[str, Any]:
    """
    Whether OCR can run here, answered by looking rather than by assuming.

    Returns `{'available': bool, ...}`. When it is False, `why` carries the sentence that goes in
    the report. This is deliberately a probe and not a try/except around the first real call: the
    caller needs to know the answer *before* it decides whether a page without text is a page it
    can still recover, and a report that says "OCR was not attempted" is worth more than one that
    says nothing because the code never got there.
    """
    found = shutil.which(binary)
    if not found:
        return {
            'available': False,
            'binary': binary,
            'why': '`%s` is not on PATH, so no page could be read by OCR' % binary,
            'remedy': 'install tesseract (brew install tesseract, apt-get install tesseract-ocr)',
        }

    try:
        run = subprocess.run(
            [found, '--version'], capture_output=True, text=True, timeout=20,
        )
    except (OSError, subprocess.SubprocessError) as problem:
        # Present on PATH and unrunnable is a real state - a broken symlink, a binary for the wrong
        # architecture. Reporting it as "not installed" sends whoever is debugging to the wrong fix.
        return {
            'available': False,
            'binary': found,
            'why': '`%s` is on PATH but would not run: %s' % (found, problem),
            'remedy': 'reinstall tesseract, or check it is built for this architecture',
        }

    version = (run.stdout or run.stderr or '').strip().splitlines()
    return {
        'available': True,
        'binary': found,
        'version': version[0] if version else 'unknown',
    }


def rasteriser_status() -> Dict[str, Any]:
    """
    Whether a PDF page that is not one embedded photograph can be turned into an image at all.

    Kept separate from `ocr_status` because the two fail independently and the difference decides
    the remedy. Tesseract present with no rasteriser is not "OCR unavailable" - it is OCR that
    works on images and cannot reach this particular page, and telling somebody to install
    tesseract when they already have it wastes their afternoon.
    """
    for name, args in (
        ('pdftoppm', ['-r', '200', '-png', '-f', '{page}', '-l', '{page}']),
        ('magick', ['-density', '200']),
        ('sips', ['-s', 'format', 'png']),
    ):
        found = shutil.which(name)
        if found:
            return {'available': True, 'binary': found, 'name': name, 'args': args}
    return {
        'available': False,
        'why': 'no PDF rasteriser on PATH (looked for pdftoppm, magick, sips)',
        'remedy': 'install poppler (brew install poppler, apt-get install poppler-utils)',
    }


# --------------------------------------------------------------------------------------------
# Plain text
# --------------------------------------------------------------------------------------------


def _decode_text(raw: bytes) -> Tuple[str, str, List[str]]:
    """
    Bytes to characters, saying which encoding was used and what it cost.

    UTF-8 first because it is nearly always right, then cp1252, then latin-1 which cannot fail.
    The fallbacks are noted rather than silent: a file read as latin-1 that was really UTF-8 gives
    you mojibake, which looks like text and is not, and the note is the only warning anybody gets.
    """
    notes = []  # type: List[str]
    for encoding in ('utf-8-sig', 'utf-8', 'cp1252'):
        try:
            return (raw.decode(encoding), encoding, notes)
        except UnicodeDecodeError:
            notes.append('not valid %s' % encoding)
    text = raw.decode('latin-1')
    notes.append('read as latin-1, which cannot fail and therefore cannot be trusted - some '
                 'characters may be wrong rather than missing')
    return (text, 'latin-1', notes)


def extract_text_file(path: str) -> Dict[str, Any]:
    """A text file is one page. Page numbers still exist so a citation has the same shape everywhere."""
    with open(path, 'rb') as handle:
        raw = handle.read()
    text, encoding, notes = _decode_text(raw)
    page = {
        'page': 1,
        'method': METHOD_TEXT,
        'status': STATUS_READ,
        'text': text,
        'chars': len(text),
        'lines': text.count('\n') + 1 if text else 0,
        'notes': notes,
    }
    return {'pages': [page], 'skipped': [], 'notes': ['decoded as %s' % encoding]}


# --------------------------------------------------------------------------------------------
# PDF
# --------------------------------------------------------------------------------------------


def _page_image_streams(document: 'pdfread.Document', page: Dict[str, Any]) -> List[Any]:
    """Every image XObject on a page, as streams, in the order `image_names_on` reports them."""
    resources = document.resolve(page.get('Resources'))
    if not isinstance(resources, dict):
        return []
    xobjects = document.resolve(resources.get('XObject'))
    if not isinstance(xobjects, dict):
        return []
    found = []  # type: List[Any]
    for key in sorted(xobjects):
        entry = document.resolve(xobjects[key])
        if not isinstance(entry, pdfread.Stream):
            continue
        node = entry.dictionary
        if str(document.resolve(node.get('Subtype')) or '') == 'Image':
            found.append(entry)
    return found


def _direct_image_bytes(document: 'pdfread.Document', stream: Any) -> Optional[Tuple[bytes, str]]:
    """
    A page's scan as a file an OCR binary can open, when that is possible without a codec.

    Returns (bytes, suffix) or None. The whole trick is that a DCTDecode stream's bytes already
    are a JPEG - the PDF filter is the JPEG. So a scanned page can reach tesseract with nothing
    installed beyond tesseract itself, which is the difference between recovering a 17-page scanned
    brochure and reporting seventeen pages of nothing.

    A Flate wrapper in front of it is unwrapped, because `/Filter [/FlateDecode /DCTDecode]` is a
    real thing producers emit. Anything else returns None and the caller reports the page as
    needing a rasteriser, which is the honest answer rather than writing out bytes that are not an
    image file and letting tesseract fail with a confusing message.
    """
    filters = document.resolve(stream.dictionary.get('Filter'))
    if filters is None:
        return None
    if not isinstance(filters, list):
        filters = [filters]
    names = [str(document.resolve(f) or '') for f in filters]
    if not names or names[-1] not in DIRECT_IMAGE_FILTERS:
        return None

    data = stream.raw
    for name in names[:-1]:
        if name in ('FlateDecode', 'Fl'):
            try:
                data = zlib.decompress(data)
            except zlib.error:
                return None
        else:
            return None
    return (data, DIRECT_IMAGE_FILTERS[names[-1]])


def _remove(directory: Optional[str]) -> None:
    """
    Delete a scratch directory, and never let the delete become the failure.

    An unwritable temp directory is somebody else's problem; a page that was successfully read and
    then reported as an error because the cleanup raised is this module's, and it is the worse one.
    """
    if directory:
        shutil.rmtree(directory, ignore_errors=True)


def _ocr_image_file(path: str, ocr: Dict[str, Any], language: Optional[str] = None) -> Tuple[Optional[str], Optional[str]]:
    """
    Run the OCR binary over one image file. Returns (text, error) with exactly one of them set.

    An OCR run that fails is not an OCR run that found nothing, and the two are separated here so
    they can stay separated all the way out to the report.
    """
    with tempfile.TemporaryDirectory(prefix='quartermaster-ocr-') as workspace:
        stem = os.path.join(workspace, 'out')
        command = [ocr['binary'], path, stem]
        if language:
            command += ['-l', language]
        try:
            # `errors='replace'`, because tesseract echoes the offending file's raw bytes into
            # stderr for a corrupt image, and decoding those as UTF-8 raised UnicodeDecodeError out
            # of the subprocess call - past the remedy reporting, as a traceback.
            run = subprocess.run(command, capture_output=True, text=True, errors='replace',
                                 timeout=OCR_TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired:
            return (None, 'OCR timed out after %ds' % OCR_TIMEOUT_SECONDS)
        except OSError as problem:
            return (None, 'OCR could not be started: %s' % problem)

        if run.returncode != 0:
            detail = (run.stderr or run.stdout or '').strip().splitlines()
            return (None, 'OCR exited %d: %s' % (run.returncode, detail[-1] if detail else 'no message'))

        produced = stem + '.txt'
        if not os.path.exists(produced):
            # Exit zero and no output file. Rare, and reporting it as empty text would be the exact
            # confusion this module refuses.
            return (None, 'OCR exited 0 but wrote no text file')
        with open(produced, 'rb') as handle:
            text, _, _ = _decode_text(handle.read())
        return (text, None)


def _rasterise_page(path: str, number: int, raster: Dict[str, Any]) -> Tuple[Optional[str], Optional[str], Optional[str]]:
    """
    One PDF page as a PNG on disk, using whichever rasteriser was found.

    Returns (image path, its directory to remove afterwards, error). The directory comes back rather
    than being cleaned up here because the caller needs the file to survive until OCR has read it -
    and an earlier draft that used a `with` block deleted the page before tesseract opened it, which
    fails as "no such file" and reads like a broken install.

    Only pdftoppm is driven page by page. `magick` and `sips` are detected and reported so the
    remedy names something the machine already has, but rasterising a single page through them
    needs argument shapes that differ between builds, and a command assembled from a guess that
    silently rasterises the wrong page is worse than an admitted gap.
    """
    if raster.get('name') != 'pdftoppm':
        return (None, None, '%s was found but this module only drives pdftoppm page by page'
                % raster.get('name', 'a rasteriser'))

    workspace = tempfile.mkdtemp(prefix='quartermaster-raster-')
    stem = os.path.join(workspace, 'page')
    command = [raster['binary'], '-r', '200', '-png', '-f', str(number), '-l', str(number), path, stem]
    try:
        # `errors='replace'`, because tesseract echoes the offending file's raw bytes into
        # stderr for a corrupt image, and decoding those as UTF-8 raised UnicodeDecodeError out of
        # the subprocess call - past the remedy reporting, as a traceback.
        run = subprocess.run(command, capture_output=True, text=True, errors='replace',
                             timeout=OCR_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        return (None, workspace, 'rasterising timed out after %ds' % OCR_TIMEOUT_SECONDS)
    except OSError as problem:
        return (None, workspace, 'rasteriser could not be started: %s' % problem)
    if run.returncode != 0:
        detail = (run.stderr or '').strip().splitlines()
        return (None, workspace,
                'rasteriser exited %d: %s' % (run.returncode, detail[-1] if detail else 'no message'))

    produced = sorted(os.path.join(workspace, name) for name in os.listdir(workspace))
    if not produced:
        return (None, workspace, 'rasteriser exited 0 and wrote no image')
    return (produced[0], workspace, None)


def extract_pdf(path: str, ocr: Dict[str, Any], raster: Dict[str, Any],
                use_ocr: bool = True, language: Optional[str] = None) -> Dict[str, Any]:
    """
    Every page of a PDF, by text layer first and OCR only where the text layer came back short.

    OCR is not run on a page that already has text. It is slower by three orders of magnitude and
    it is *worse*: the text layer is what the producer wrote, and OCR is a guess at a picture of it.
    """
    with open(path, 'rb') as handle:
        data = handle.read()

    document = pdfread.Document(data)
    pages = document.pages()
    out_pages = []  # type: List[Dict[str, Any]]
    skipped = []  # type: List[Skipped]
    notes = list(document.notes)

    if not pages:
        # No pages at all is a fact about the file, not about its text, and it must not read as an
        # empty document. Encrypted PDFs land here, and so do files that are not PDFs.
        encrypted = b'/Encrypt' in data[:4096] or b'/Encrypt' in data[-4096:]
        why = ('the file is encrypted and this reader does not decrypt' if encrypted
               else 'no page objects were found - the file may not be a PDF, or may be damaged '
                    'beyond what scanning for objects recovers')
        skipped.append(Skipped('the whole document', why,
                               'open it in a PDF reader and re-export it, or supply the text'))
        return {'pages': [], 'skipped': [s.as_dict() for s in skipped], 'notes': notes}

    for number, page in enumerate(pages, 1):
        content, problems = document.content_of(page)
        fonts = pdfread.fonts_on(page, document)
        text, undecodable, unresolved = pdfread.page_text(content, fonts)
        images = document.image_names_on(page)

        page_notes = list(problems)
        for key in unresolved:
            page_notes.append('font /%s is referenced by the content stream and not in /Resources; '
                              'its bytes were read as Latin-1 and may be wrong' % key)
        if undecodable:
            page_notes.append('%d byte(s) belong to a font with no /ToUnicode and no glyph names '
                              'this reader knows; they are missing from the text above, not blank'
                              % undecodable)

        record = {
            'page': number,
            'method': METHOD_PDF,
            'status': STATUS_READ,
            'text': text,
            'chars': len(text),
            'lines': text.count('\n') + 1 if text else 0,
            'images': len(images),
            'undecodable_bytes': undecodable,
            'notes': page_notes,
        }

        stripped = text.strip()
        # "Partial" is a page that gave up some text and admitted losing some. It is the most
        # dangerous state of the three, because it looks like a success: a caller reading `text`
        # sees prose and has no reason to suspect a sentence is missing out of the middle of it.
        if stripped and (undecodable or problems):
            record['status'] = STATUS_PARTIAL
            skipped.append(Skipped(
                'page %d' % number,
                'read, but %s' % (page_notes[0] if page_notes else 'with losses'),
                'OCR this page to recover the rest' if images else None,
            ))

        if not stripped:
            if images or problems:
                record['status'] = STATUS_NEEDS_OCR
                record['method'] = METHOD_UNAVAILABLE
                if images:
                    record['notes'].append(
                        'no text layer, and the page draws %d image(s) - this is a scan, not a '
                        'blank page' % len(images))
                else:
                    record['notes'].append(
                        'no text layer, and a content stream could not be decoded - there may be '
                        'text on this page that nothing here has seen')
            else:
                # Genuinely nothing on it. Said explicitly, because it is the only case where an
                # empty string is the answer rather than a gap.
                record['notes'].append('no text operators and nothing drawn - the page is blank')

        out_pages.append(record)

    if use_ocr:
        _ocr_pdf_pages(path, document, pages, out_pages, skipped, ocr, raster, language)
    else:
        for record in out_pages:
            if record['status'] == STATUS_NEEDS_OCR:
                skipped.append(Skipped('page %d' % record['page'],
                                       'has no text layer and OCR was switched off for this run',
                                       'run again without --no-ocr'))

    return {'pages': out_pages, 'skipped': [s.as_dict() for s in skipped], 'notes': notes}


def _ocr_pdf_pages(path: str, document: 'pdfread.Document', pages: List[Dict[str, Any]],
                   records: List[Dict[str, Any]], skipped: List[Skipped],
                   ocr: Dict[str, Any], raster: Dict[str, Any], language: Optional[str]) -> None:
    """
    Fill in the pages the text layer could not read, in place.

    Three ways this can end for one page, and they are three different report lines: OCR ran and
    found text; OCR ran and found nothing on a page that draws something, which is a real finding
    about a blank scan; OCR never ran, and `why` names the missing binary. The third one is the
    reason this function exists as its own step rather than as a fallback inside the loop above -
    a fallback would have nowhere to put the reason.
    """
    for record in records:
        if record['status'] != STATUS_NEEDS_OCR:
            continue
        number = record['page']

        if not ocr.get('available'):
            record['method'] = METHOD_UNAVAILABLE
            record['ocr'] = {'attempted': False, 'why': ocr.get('why', 'OCR is not available here')}
            skipped.append(Skipped('page %d' % number,
                                   'has no text layer and %s' % ocr.get('why', 'OCR is unavailable'),
                                   ocr.get('remedy')))
            continue

        image_path = None
        directory = None
        source = None
        streams = _page_image_streams(document, pages[number - 1])
        direct = _direct_image_bytes(document, streams[0]) if len(streams) == 1 else None

        if direct is not None:
            payload, suffix = direct
            directory = tempfile.mkdtemp(prefix='quartermaster-page-')
            image_path = os.path.join(directory, 'page%d%s' % (number, suffix))
            with open(image_path, 'wb') as handle:
                handle.write(payload)
            source = "the page's embedded image, written out unchanged"
        elif raster.get('available'):
            image_path, directory, error = _rasterise_page(path, number, raster)
            source = 'the page rasterised at 200dpi'
            if image_path is None:
                _remove(directory)
                record['method'] = METHOD_UNAVAILABLE
                record['ocr'] = {'attempted': False, 'why': error}
                skipped.append(Skipped('page %d' % number, 'could not be turned into an image: %s' % error))
                continue
        else:
            why = ('the page is not one embedded photograph, so it has to be rasterised first, and %s'
                   % raster.get('why', 'no rasteriser is available'))
            record['method'] = METHOD_UNAVAILABLE
            record['ocr'] = {'attempted': False, 'why': why}
            skipped.append(Skipped('page %d' % number, why, raster.get('remedy')))
            continue

        try:
            text, error = _ocr_image_file(image_path, ocr, language)
        finally:
            _remove(directory)

        if error is not None:
            record['method'] = METHOD_UNAVAILABLE
            record['ocr'] = {'attempted': True, 'why': error, 'source': source}
            skipped.append(Skipped('page %d' % number, 'OCR was attempted and failed: %s' % error))
            continue

        record['method'] = METHOD_OCR
        record['text'] = text
        record['chars'] = len(text)
        record['lines'] = text.count('\n') + 1 if text else 0
        record['ocr'] = {'attempted': True, 'source': source, 'binary': ocr.get('binary'),
                         'version': ocr.get('version')}
        if text.strip():
            record['status'] = STATUS_READ
            record['notes'].append('this page has no text layer; the text above is OCR of an image '
                                   'and is a reading of a picture, not what the author typed')
        else:
            # OCR ran and found nothing on a page that draws something. That is a result, and it
            # is not the same as OCR not having run - so the status stays needs-ocr and says why.
            record['notes'].append('OCR ran over this page and found no characters - the image may '
                                   'be a photograph, a diagram, or a scan too poor to read')
            skipped.append(Skipped('page %d' % number,
                                   'OCR ran and returned no characters; the page draws an image '
                                   'with no readable text in it'))


# --------------------------------------------------------------------------------------------
# Images
# --------------------------------------------------------------------------------------------


def extract_image(path: str, ocr: Dict[str, Any], use_ocr: bool = True,
                  language: Optional[str] = None) -> Dict[str, Any]:
    """An image is one page, and OCR is the only layer that can read it."""
    record = {
        'page': 1,
        'method': METHOD_UNAVAILABLE,
        'status': STATUS_UNAVAILABLE,
        'text': '',
        'chars': 0,
        'lines': 0,
        'images': 1,
        'notes': [],
    }  # type: Dict[str, Any]
    skipped = []  # type: List[Skipped]

    if not use_ocr:
        record['ocr'] = {'attempted': False, 'why': 'OCR was switched off for this run'}
        skipped.append(Skipped(os.path.basename(path), 'is an image and OCR was switched off',
                               'run again without --no-ocr'))
        return {'pages': [record], 'skipped': [s.as_dict() for s in skipped], 'notes': []}

    if not ocr.get('available'):
        record['ocr'] = {'attempted': False, 'why': ocr.get('why')}
        skipped.append(Skipped(os.path.basename(path),
                               'is an image and %s' % ocr.get('why', 'OCR is unavailable'),
                               ocr.get('remedy')))
        return {'pages': [record], 'skipped': [s.as_dict() for s in skipped], 'notes': []}

    text, error = _ocr_image_file(path, ocr, language)
    if error is not None:
        record['ocr'] = {'attempted': True, 'why': error}
        skipped.append(Skipped(os.path.basename(path), 'OCR was attempted and failed: %s' % error))
        return {'pages': [record], 'skipped': [s.as_dict() for s in skipped], 'notes': []}

    record['method'] = METHOD_OCR
    record['text'] = text
    record['chars'] = len(text)
    record['lines'] = text.count('\n') + 1 if text else 0
    record['ocr'] = {'attempted': True, 'binary': ocr.get('binary'), 'version': ocr.get('version')}
    record['notes'].append('the text above is OCR of an image and is a reading of a picture, not '
                           'what the author typed')
    if text.strip():
        record['status'] = STATUS_READ
    else:
        record['status'] = STATUS_NEEDS_OCR
        record['notes'].append('OCR ran over this image and found no characters')
        skipped.append(Skipped(os.path.basename(path), 'OCR ran and returned no characters'))
    return {'pages': [record], 'skipped': [s.as_dict() for s in skipped], 'notes': []}


# --------------------------------------------------------------------------------------------
# The front door
# --------------------------------------------------------------------------------------------


def _kind_of(path: str, head: bytes) -> str:
    """
    What sort of file this is, from its bytes first and its name second.

    Content wins because a name is a claim: `.txt` on a PDF is common in ticket attachments, and a
    reader that trusts the suffix reads the binary as Latin-1 and reports a page of mojibake as
    successfully extracted text - which is worse than failing, because it is not obviously wrong.
    """
    if head.startswith(b'%PDF-'):
        return 'pdf'
    if head.startswith(b'\x89PNG') or head.startswith(b'\xff\xd8\xff') or head[:4] in (b'II*\x00', b'MM\x00*'):
        return 'image'
    if head.startswith(b'GIF8') or head[:2] == b'BM':
        return 'image'

    suffix = os.path.splitext(path)[1].lower()
    if suffix == '.pdf':
        # Named .pdf without the header. Scanning for objects still recovers most damaged files, so
        # it is worth handing to the PDF layer, which reports honestly if it finds nothing.
        return 'pdf'
    if suffix in IMAGE_SUFFIXES:
        return 'image'
    if suffix in TEXT_SUFFIXES:
        return 'text'
    if b'\x00' in head:
        return 'binary'
    return 'text'


def extract(path: str, use_ocr: bool = True, language: Optional[str] = None,
            ocr: Optional[Dict[str, Any]] = None,
            raster: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Read a document and report what came out and what did not.

    `ocr` and `raster` are injectable so a test can assert the unavailable path without uninstalling
    anything. That is not a convenience: the machine that wrote this has tesseract and the sandbox
    this ships to does not, so the branch that matters most is the one that cannot be reached here
    by any other means.
    """
    if ocr is None:
        ocr = ocr_status()
    if raster is None:
        raster = rasteriser_status()

    absolute = os.path.abspath(path)
    if not os.path.exists(absolute):
        # A file that is not there is not a document with no text in it. Same distinction, one
        # level up: the command never ran.
        return _finish(absolute, None, 'missing', {
            'pages': [],
            'skipped': [Skipped(absolute, 'no such file', 'check the path').as_dict()],
            'notes': [],
        }, ocr, raster)

    if os.path.isdir(absolute):
        # An obvious tab-completion slip, and it raised IsADirectoryError straight past the
        # reporting this module exists to do. A directory is not a document that could not be read;
        # it is not a document, which is the same distinction the missing-file branch draws.
        return _finish(absolute, None, 'missing', {
            'pages': [],
            'skipped': [Skipped(absolute, 'is a directory, not a file', 'name a file inside it').as_dict()],
            'notes': [],
        }, ocr, raster)
    with open(absolute, 'rb') as handle:
        head = handle.read(4096)
    size = os.path.getsize(absolute)
    kind = _kind_of(absolute, head)

    if kind == 'pdf':
        body = extract_pdf(absolute, ocr, raster, use_ocr=use_ocr, language=language)
    elif kind == 'image':
        body = extract_image(absolute, ocr, use_ocr=use_ocr, language=language)
    elif kind == 'binary':
        body = {
            'pages': [],
            'skipped': [Skipped(
                os.path.basename(absolute),
                'contains NUL bytes and is not a PDF or an image this reader recognises, so no '
                'layer here can read it',
                'convert it to PDF, or export its text',
            ).as_dict()],
            'notes': [],
        }
    else:
        body = extract_text_file(absolute)

    return _finish(absolute, size, kind, body, ocr, raster)


def _finish(path: str, size: Optional[int], kind: str, body: Dict[str, Any],
            ocr: Dict[str, Any], raster: Dict[str, Any]) -> Dict[str, Any]:
    """Assemble the report, and compute the fields a caller cannot miss."""
    pages = body['pages']
    methods = sorted(set(page['method'] for page in pages))
    if not methods:
        method = METHOD_UNAVAILABLE
    elif len(methods) == 1:
        method = methods[0]
    else:
        method = METHOD_MIXED

    read = [p for p in pages if p['status'] == STATUS_READ]
    partial = [p for p in pages if p['status'] == STATUS_PARTIAL]
    unread = [p for p in pages if p['status'] in (STATUS_NEEDS_OCR, STATUS_UNAVAILABLE)]
    complete = not body['skipped'] and not unread

    digest = None
    if size is not None:
        sha = hashlib.sha256()
        with open(path, 'rb') as handle:
            for chunk in iter(lambda: handle.read(65536), b''):
                sha.update(chunk)
        digest = sha.hexdigest()

    return {
        'source': {
            'path': path,
            'name': os.path.basename(path),
            'bytes': size,
            'sha256': digest,
            'kind': kind,
        },
        'method': method,
        'page_methods': dict((m, sum(1 for p in pages if p['method'] == m)) for m in methods),
        # The three fields a caller cannot read past. `complete` is the boolean, `skipped` is the
        # detail, `summary` is the sentence to put in an answer.
        'complete': complete,
        'skipped': body['skipped'],
        'summary': _summary(pages, read, partial, unread, body['skipped']),
        'pages': pages,
        'text': '\n\n'.join(p['text'] for p in pages if p['text']),
        'chars': sum(p['chars'] for p in pages),
        'notes': body['notes'],
        'ocr': ocr,
        'rasteriser': raster,
        'schema': 'quartermaster/document-extraction/1',
    }


def _summary(pages: List[Dict[str, Any]], read: List[Dict[str, Any]], partial: List[Dict[str, Any]],
             unread: List[Dict[str, Any]], skipped: List[Dict[str, Any]]) -> str:
    """One sentence, written so that pasting it into an answer is already the honest disclosure."""
    if not pages:
        return 'Nothing was read from this file. %s' % (skipped[0]['why'] if skipped else 'No pages were found.')
    total = len(pages)
    plural = 'page' if total == 1 else 'pages'
    if len(read) == total and not skipped:
        return ('The one page was read.' if total == 1 else 'All %d pages were read.' % total)

    def listed(group: List[Dict[str, Any]], verb: str) -> str:
        numbers = ', '.join(str(p['page']) for p in group)
        return '%d %s %s (page %s)' % (len(group), 'was' if len(group) == 1 else 'were', verb, numbers)

    parts = ['%d of %d %s were read in full' % (len(read), total, plural)]
    if partial:
        parts.append(listed(partial, 'read with losses'))
    if unread:
        parts.append(listed(unread, 'not read at all'))
    return ('%s. Do not describe what is missing as blank - `skipped` says why each one was not '
            'read.' % '; '.join(parts))


# --------------------------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------------------------


def _render(result: Dict[str, Any]) -> str:
    # A file that was never opened has no size, and "None bytes" reads like a bug in the reader
    # rather than a fact about the file.
    size = result['source'].get('bytes')
    measured = '%s bytes' % size if isinstance(size, int) else 'size unknown'
    lines = ['%s  (%s, %s)' % (result['source']['name'], result['source']['kind'], measured)]
    lines.append('method: %s   complete: %s' % (result['method'], result['complete']))
    lines.append(result['summary'])
    if not result['ocr'].get('available'):
        lines.append('OCR: unavailable - %s' % result['ocr'].get('why'))
    else:
        lines.append('OCR: %s' % result['ocr'].get('version'))
    if result['skipped']:
        lines.append('')
        lines.append('NOT READ:')
        for entry in result['skipped']:
            lines.append('  - %s: %s' % (entry['where'], entry['why']))
            if entry.get('remedy'):
                lines.append('    remedy: %s' % entry['remedy'])
    for page in result['pages']:
        lines.append('')
        lines.append('--- page %d [%s / %s] %d chars' % (page['page'], page['method'],
                                                         page['status'], page['chars']))
        for note in page.get('notes', []):
            lines.append('    note: %s' % note)
        if page['text']:
            lines.append(page['text'])
    return '\n'.join(lines)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument('path', help='the document to read')
    parser.add_argument('--json', action='store_true', help='print the whole report as JSON')
    parser.add_argument('--no-ocr', action='store_true',
                        help='do not run OCR; pages that needed it are reported as unavailable')
    parser.add_argument('--lang', default=None, help='OCR language, passed to tesseract as -l')
    args = parser.parse_args(argv)

    result = extract(args.path, use_ocr=not args.no_ocr, language=args.lang)
    print(json.dumps(result, indent=2, sort_keys=True, ensure_ascii=False) if args.json
          else _render(result))

    # Exit 0 when everything was read, 2 when something was not. Not 1, which every traceback
    # already uses - a caller needs to tell "ran, and part of the document is missing" from
    # "crashed", and that is this module's whole argument applied to its own exit code.
    return 0 if result['complete'] else 2


if __name__ == '__main__':
    sys.exit(main())
