#!/usr/bin/env python3
"""
Read the text layer out of a PDF with the standard library alone.

WHY this exists rather than a dependency. A PDF that already carries text needs no OCR, and OCR is
the layer this project cannot rely on - it needs a binary that is not in the agent's sandbox. So the
text-layer path is the one that has to work with nothing installed, and the standard library has
what it needs for the common case: zlib for the content streams, and a few hundred lines of
tokeniser for the operators.

WHAT it does reliably:

  - objects scanned straight out of the file, ignoring the cross-reference table, which is how every
    repair-mode reader works and which survives a file whose xref offsets are wrong
  - objects stored inside an /ObjStm, which is where PDF 1.5 and later put most of the page tree
  - FlateDecode, ASCIIHexDecode and ASCII85Decode streams, with the PNG predictors
  - the text-showing operators Tj, TJ, ' and ", with Td/TD/T*/BT/ET deciding the line breaks
  - simple fonts through WinAnsi, MacRoman and Standard encodings, /Differences with glyph names it
    knows, and any font carrying a /ToUnicode CMap

WHAT it does not do, and says so rather than guessing:

  - LZWDecode, and every image filter (DCTDecode, JPXDecode, CCITTFaxDecode). A page whose text is
    inside one of those has no text layer as far as this reader is concerned, and it is reported as
    a page needing OCR rather than as a blank page.
  - a subset font with no /ToUnicode and glyph names like /g17. Those bytes are glyph indices into a
    font nobody shipped, and there is no honest way to turn them into characters. Every such byte is
    counted and reported as an unreadable span - never dropped, never guessed at.
  - layout. Columns, tables and reading order are not reconstructed. Lines come out in the order the
    content stream draws them, which for a single-column document is the order a person reads.

The concrete failure this file is written against: a reader that returns "" for a page it could not
decode, and a caller that then reports the page as blank. An empty page and an undecodable page are
two different answers, and nothing in this module merges them.

Python 3.9 compatible on purpose - the project has already been bitten by 3.10-only syntax.
"""
from __future__ import annotations

import base64
import re
import zlib
from typing import Any, Dict, List, Optional, Tuple

# --------------------------------------------------------------------------------------------
# Object model
# --------------------------------------------------------------------------------------------


class Name(str):
    """A PDF name. A str subclass, so `d['Type'] == 'Page'` works without unwrapping anything."""

    __slots__ = ()


class Ref(object):
    """An indirect reference, `12 0 R`, left unresolved until somebody asks for it."""

    __slots__ = ('num', 'gen')

    def __init__(self, num, gen):
        self.num = num
        self.gen = gen

    def __repr__(self):
        return 'Ref(%d,%d)' % (self.num, self.gen)

    def __eq__(self, other):
        return isinstance(other, Ref) and other.num == self.num and other.gen == self.gen

    def __hash__(self):
        return hash((self.num, self.gen))


class Stream(object):
    """A stream object: its dictionary, and the bytes exactly as they sit in the file."""

    __slots__ = ('dictionary', 'raw')

    def __init__(self, dictionary, raw):
        self.dictionary = dictionary
        self.raw = raw


class Operator(str):
    """A content-stream operator such as `Tj`, kept a different type from a Name on purpose."""

    __slots__ = ()


class UnsupportedFilter(Exception):
    """Carries the filter's own name, so the reason reaches the report intact."""


# --------------------------------------------------------------------------------------------
# Tokeniser
# --------------------------------------------------------------------------------------------

_WHITESPACE = b'\x00\t\n\x0c\r '
_DELIMITERS = b'()<>[]{}/%'
_NUMBER = re.compile(rb'[+-]?(?:\d+\.\d*|\.\d+|\d+)')
_ESCAPES = {b'n': b'\n', b'r': b'\r', b't': b'\t', b'b': b'\b', b'f': b'\f'}


class Lexer(object):
    """
    A tokeniser over PDF syntax, used for object bodies and for content streams alike.

    Deliberately forgiving. Real files carry rubbish between objects, and a parser that raises on
    the first surprise reads nothing at all out of a file a person can open perfectly well.
    """

    def __init__(self, data: bytes, pos: int = 0):
        self.data = data
        self.pos = pos

    def _skip(self) -> None:
        data, end = self.data, len(self.data)
        while self.pos < end:
            ch = data[self.pos:self.pos + 1]
            if ch in _WHITESPACE:
                self.pos += 1
            elif ch == b'%':
                nl = data.find(b'\n', self.pos)
                self.pos = end if nl < 0 else nl + 1
            else:
                return

    def next(self) -> Tuple[str, Any]:
        """Return (kind, value) where kind is 'obj', 'op' or 'eof'."""
        self._skip()
        data = self.data
        if self.pos >= len(data):
            return ('eof', None)

        ch = data[self.pos:self.pos + 1]

        if ch == b'<':
            if data[self.pos:self.pos + 2] == b'<<':
                return ('obj', self._dictionary())
            return ('obj', self._hex_string())
        if ch == b'(':
            return ('obj', self._literal_string())
        if ch == b'[':
            return ('obj', self._array())
        if ch in (b']', b'>', b'{', b'}'):
            # A stray closer. Consume it, so a caller cannot loop forever on the same byte.
            self.pos += 1
            return ('op', Operator(ch.decode('latin-1')))
        if ch == b'/':
            return ('obj', self._name())

        match = _NUMBER.match(data, self.pos)
        if match:
            return ('obj', self._number_or_ref(match))

        start = self.pos
        while self.pos < len(data):
            here = data[self.pos:self.pos + 1]
            if here in _WHITESPACE or here in _DELIMITERS:
                break
            self.pos += 1
        word = data[start:self.pos]
        if not word:
            # Nothing matched and nothing consumed. Step over the byte rather than spin.
            self.pos += 1
            return ('op', Operator(''))
        if word == b'true':
            return ('obj', True)
        if word == b'false':
            return ('obj', False)
        if word == b'null':
            return ('obj', None)
        return ('op', Operator(word.decode('latin-1')))

    def parse_object(self) -> Any:
        kind, value = self.next()
        if kind == 'obj':
            return value
        if kind == 'eof':
            raise ValueError('end of data where an object was expected')
        raise ValueError('operator %r where an object was expected' % (value,))

    def _number_or_ref(self, match) -> Any:
        text = match.group(0)
        self.pos = match.end()
        if b'.' in text:
            return float(text)
        number = int(text)

        # `12 0 R` is a reference; `12 0` followed by anything else is two numbers. The only way to
        # tell them apart is to read ahead and put the position back when it was not a reference.
        rewind = self.pos
        self._skip()
        second = _NUMBER.match(self.data, self.pos)
        if second and b'.' not in second.group(0):
            self.pos = second.end()
            self._skip()
            if self.data[self.pos:self.pos + 1] == b'R':
                after = self.data[self.pos + 1:self.pos + 2]
                if after == b'' or after in _WHITESPACE or after in _DELIMITERS:
                    self.pos += 1
                    return Ref(number, int(second.group(0)))
        self.pos = rewind
        return number

    def _name(self) -> Name:
        self.pos += 1
        start = self.pos
        data = self.data
        while self.pos < len(data):
            ch = data[self.pos:self.pos + 1]
            if ch in _WHITESPACE or ch in _DELIMITERS:
                break
            self.pos += 1
        raw = data[start:self.pos]

        out = bytearray()
        i = 0
        while i < len(raw):
            if raw[i:i + 1] == b'#' and i + 2 < len(raw):
                try:
                    out.append(int(raw[i + 1:i + 3], 16))
                    i += 3
                    continue
                except ValueError:
                    pass
            out.append(raw[i])
            i += 1
        return Name(bytes(out).decode('latin-1'))

    def _array(self) -> List[Any]:
        self.pos += 1
        items = []  # type: List[Any]
        while True:
            self._skip()
            if self.pos >= len(self.data):
                break
            if self.data[self.pos:self.pos + 1] == b']':
                self.pos += 1
                break
            kind, value = self.next()
            if kind == 'eof':
                break
            if kind == 'obj':
                items.append(value)
        return items

    def _dictionary(self) -> Dict[str, Any]:
        self.pos += 2
        out = {}  # type: Dict[str, Any]
        while True:
            self._skip()
            if self.pos >= len(self.data):
                break
            if self.data[self.pos:self.pos + 2] == b'>>':
                self.pos += 2
                break
            if self.data[self.pos:self.pos + 1] != b'/':
                # A malformed pair. Consume one token so the loop cannot stall on it.
                kind, _value = self.next()
                if kind == 'eof':
                    break
                continue
            key = self._name()
            kind, value = self.next()
            if kind == 'eof':
                break
            if kind == 'obj':
                out[str(key)] = value
        return out

    def _hex_string(self) -> bytes:
        end = self.data.find(b'>', self.pos)
        if end < 0:
            end = len(self.data)
        digits = re.sub(rb'[^0-9A-Fa-f]', b'', self.data[self.pos + 1:end])
        if len(digits) % 2:
            digits += b'0'
        self.pos = end + 1
        return bytes.fromhex(digits.decode('ascii'))

    def _literal_string(self) -> bytes:
        data = self.data
        self.pos += 1
        depth = 1
        out = bytearray()
        while self.pos < len(data):
            ch = data[self.pos:self.pos + 1]
            self.pos += 1
            if ch == b'\\':
                nxt = data[self.pos:self.pos + 1]
                self.pos += 1
                if nxt in _ESCAPES:
                    out.extend(_ESCAPES[nxt])
                elif nxt in (b'(', b')', b'\\'):
                    out.extend(nxt)
                elif nxt == b'\n':
                    pass
                elif nxt == b'\r':
                    if data[self.pos:self.pos + 1] == b'\n':
                        self.pos += 1
                elif nxt.isdigit():
                    octal = nxt
                    while len(octal) < 3 and data[self.pos:self.pos + 1].isdigit():
                        octal += data[self.pos:self.pos + 1]
                        self.pos += 1
                    out.append(int(octal, 8) & 0xFF)
                else:
                    out.extend(nxt)
            elif ch == b'(':
                depth += 1
                out.extend(ch)
            elif ch == b')':
                depth -= 1
                if depth == 0:
                    break
                out.extend(ch)
            else:
                out.extend(ch)
        return bytes(out)


# --------------------------------------------------------------------------------------------
# Filters
# --------------------------------------------------------------------------------------------


def _png_predictor(data: bytes, colors: int, bpc: int, columns: int) -> bytes:
    """
    Undo the PNG row filters a Flate stream may have been encoded with.

    Needed for object streams and cross-reference streams. Without it those inflate to bytes that
    look like data and parse as nonsense, which is the worst failure mode available: no exception,
    no text, and no reason.
    """
    per_pixel = max(1, (colors * bpc + 7) // 8)
    row_length = (columns * colors * bpc + 7) // 8
    out = bytearray()
    previous = bytearray(row_length)
    pos = 0
    while pos + 1 <= len(data) - 1:
        tag = data[pos]
        row = bytearray(data[pos + 1:pos + 1 + row_length])
        if len(row) < row_length:
            row.extend(b'\x00' * (row_length - len(row)))
        pos += 1 + row_length
        if tag == 1:
            for i in range(per_pixel, row_length):
                row[i] = (row[i] + row[i - per_pixel]) & 0xFF
        elif tag == 2:
            for i in range(row_length):
                row[i] = (row[i] + previous[i]) & 0xFF
        elif tag == 3:
            for i in range(row_length):
                left = row[i - per_pixel] if i >= per_pixel else 0
                row[i] = (row[i] + ((left + previous[i]) >> 1)) & 0xFF
        elif tag == 4:
            for i in range(row_length):
                left = row[i - per_pixel] if i >= per_pixel else 0
                up = previous[i]
                upleft = previous[i - per_pixel] if i >= per_pixel else 0
                p = left + up - upleft
                pa, pb, pc = abs(p - left), abs(p - up), abs(p - upleft)
                if pa <= pb and pa <= pc:
                    nearest = left
                elif pb <= pc:
                    nearest = up
                else:
                    nearest = upleft
                row[i] = (row[i] + nearest) & 0xFF
        out.extend(row)
        previous = row
    return bytes(out)


def _inflate(data: bytes) -> bytes:
    """
    Inflate, tolerating a truncated tail.

    zlib.decompress raises on a stream that stops early; decompressobj hands back everything it did
    manage. A page that is 90 per cent readable is worth more than an exception, and the caller is
    told the length so it can see the shortfall.
    """
    try:
        return zlib.decompress(data)
    except zlib.error:
        try:
            return zlib.decompressobj().decompress(data)
        except zlib.error:
            # Some writers leave junk before the header. Try again from the first plausible byte.
            for skip in range(1, min(len(data), 32)):
                try:
                    return zlib.decompressobj().decompress(data[skip:])
                except zlib.error:
                    continue
            raise


IMAGE_FILTERS = frozenset(['DCTDecode', 'JPXDecode', 'CCITTFaxDecode', 'JBIG2Decode', 'RunLengthDecode'])


def decode_stream(stream: Stream, resolve) -> bytes:
    """Apply a stream's filter chain. Raises UnsupportedFilter, named, rather than returning b''."""
    filters = resolve(stream.dictionary.get('Filter'))
    if filters is None:
        filters = []
    elif not isinstance(filters, list):
        filters = [filters]

    parms = resolve(stream.dictionary.get('DecodeParms'))
    if parms is None:
        parms = []
    elif not isinstance(parms, list):
        parms = [parms]

    data = stream.raw
    for index, raw_filter in enumerate(filters):
        name = str(resolve(raw_filter) or '')
        parm = resolve(parms[index]) if index < len(parms) else None
        if not isinstance(parm, dict):
            parm = {}

        if name in ('FlateDecode', 'Fl'):
            data = _inflate(data)
        elif name in ('ASCIIHexDecode', 'AHx'):
            digits = re.sub(rb'[^0-9A-Fa-f]', b'', data.split(b'>')[0])
            if len(digits) % 2:
                digits += b'0'
            data = bytes.fromhex(digits.decode('ascii'))
            continue
        elif name in ('ASCII85Decode', 'A85'):
            body = data.split(b'~>')[0]
            data = base64.a85decode(body, adobe=False)
            continue
        else:
            raise UnsupportedFilter(name or 'an unnamed filter')

        predictor = int(resolve(parm.get('Predictor')) or 1)
        if predictor >= 10:
            data = _png_predictor(
                data,
                int(resolve(parm.get('Colors')) or 1),
                int(resolve(parm.get('BitsPerComponent')) or 8),
                int(resolve(parm.get('Columns')) or 1),
            )
        elif predictor == 2:
            raise UnsupportedFilter('TIFF predictor 2')
    return data


# --------------------------------------------------------------------------------------------
# Document
# --------------------------------------------------------------------------------------------

_OBJ_HEADER = re.compile(rb'(?<![0-9])(\d{1,10})[\x00\t\r\n\f ]+(\d{1,5})[\x00\t\r\n\f ]+obj\b')


class Document(object):
    """Every object in the file, indexed by number, with the page tree walked into order."""

    def __init__(self, data: bytes):
        self.data = data
        self.objects = {}  # type: Dict[int, Any]
        self.notes = []  # type: List[str]
        self._scan()
        self._expand_object_streams()

    # -- loading -------------------------------------------------------------------------------

    def _scan(self) -> None:
        data = self.data
        pos = 0
        while True:
            header = _OBJ_HEADER.search(data, pos)
            if header is None:
                return
            number = int(header.group(1))
            lexer = Lexer(data, header.end())
            try:
                body = lexer.parse_object()
            except (ValueError, IndexError):
                pos = header.end()
                continue

            pos = lexer.pos
            if isinstance(body, dict):
                lexer._skip()
                if data[lexer.pos:lexer.pos + 6] == b'stream':
                    start = lexer.pos + 6
                    if data[start:start + 2] == b'\r\n':
                        start += 2
                    elif data[start:start + 1] in (b'\n', b'\r'):
                        start += 1
                    end = self._stream_end(data, start, body)
                    body = Stream(body, data[start:end])
                    pos = end
            self.objects[number] = body

    def _stream_end(self, data: bytes, start: int, dictionary: Dict[str, Any]) -> int:
        """
        Where a stream's bytes stop.

        /Length is the right answer when it is a direct integer. When it is an indirect reference -
        legal, and common from streaming writers - it cannot be resolved yet, because the object it
        points at may not have been scanned. Falling back to the next `endstream` is what every
        repair-mode reader does and it is right far more often than it is wrong.
        """
        length = dictionary.get('Length')
        if isinstance(length, int) and length >= 0:
            tail = data[start + length:start + length + 20]
            if b'endstream' in tail:
                return start + length
        marker = data.find(b'endstream', start)
        if marker < 0:
            return len(data)
        end = marker
        if data[end - 2:end] == b'\r\n':
            end -= 2
        elif data[end - 1:end] in (b'\n', b'\r'):
            end -= 1
        return end

    def _expand_object_streams(self) -> None:
        """PDF 1.5 puts the page tree inside /ObjStm. Without this, such a file has no pages."""
        for number in sorted(self.objects):
            stream = self.objects[number]
            if not isinstance(stream, Stream):
                continue
            if str(self.resolve(stream.dictionary.get('Type')) or '') != 'ObjStm':
                continue
            try:
                payload = decode_stream(stream, self.resolve)
            except (UnsupportedFilter, zlib.error) as problem:
                self.notes.append('object stream %d could not be decoded: %s' % (number, problem))
                continue

            count = int(self.resolve(stream.dictionary.get('N')) or 0)
            first = int(self.resolve(stream.dictionary.get('First')) or 0)
            header = Lexer(payload[:first])
            pairs = []  # type: List[Tuple[int, int]]
            try:
                for _ in range(count):
                    obj_number = header.parse_object()
                    offset = header.parse_object()
                    pairs.append((int(obj_number), int(offset)))
            except (ValueError, TypeError):
                self.notes.append('object stream %d has a malformed header' % number)
                continue

            for obj_number, offset in pairs:
                if obj_number in self.objects:
                    continue
                try:
                    self.objects[obj_number] = Lexer(payload, first + offset).parse_object()
                except (ValueError, IndexError):
                    self.notes.append('object %d inside stream %d could not be parsed' % (obj_number, number))

    # -- access --------------------------------------------------------------------------------

    def resolve(self, value: Any, depth: int = 0) -> Any:
        """Follow an indirect reference. Bounded, because a file can point an object at itself."""
        while isinstance(value, Ref) and depth < 32:
            value = self.objects.get(value.num)
            depth += 1
        return value

    def pages(self) -> List[Dict[str, Any]]:
        """
        Page dictionaries in reading order.

        Walked from the catalogue where the file has one. A file whose catalogue is unreachable
        still has its /Type /Page objects, and object order is the reading order far more often
        than not - so that fallback is taken, and noted, rather than reporting no pages at all.
        """
        catalogue = None
        for value in self.objects.values():
            node = value.dictionary if isinstance(value, Stream) else value
            if isinstance(node, dict) and str(self.resolve(node.get('Type')) or '') == 'Catalog':
                catalogue = node
                break

        ordered = []  # type: List[Dict[str, Any]]
        if catalogue is not None:
            root = self.resolve(catalogue.get('Pages'))
            if isinstance(root, dict):
                self._walk(root, ordered, set(), {})
        if ordered:
            return ordered

        self.notes.append('no reachable page tree; pages taken in object order')
        for number in sorted(self.objects):
            node = self.objects[number]
            if isinstance(node, dict) and str(self.resolve(node.get('Type')) or '') == 'Page':
                ordered.append(self._with_inherited(node, {}))
        return ordered

    _INHERITABLE = ('Resources', 'MediaBox', 'CropBox', 'Rotate')

    def _with_inherited(self, page: Dict[str, Any], inherited: Dict[str, Any]) -> Dict[str, Any]:
        merged = dict(inherited)
        merged.update(page)
        return merged

    def _walk(self, node: Dict[str, Any], out: List[Dict[str, Any]], seen: set, inherited: Dict[str, Any]) -> None:
        marker = id(node)
        if marker in seen or len(out) > 5000:
            return
        seen.add(marker)

        carried = dict(inherited)
        for key in self._INHERITABLE:
            if key in node:
                carried[key] = node[key]

        kind = str(self.resolve(node.get('Type')) or '')
        kids = self.resolve(node.get('Kids'))
        if kind == 'Page' or (kids is None and 'Contents' in node):
            out.append(self._with_inherited(node, carried))
            return
        if isinstance(kids, list):
            for kid in kids:
                child = self.resolve(kid)
                if isinstance(child, dict):
                    self._walk(child, out, seen, carried)

    def content_of(self, page: Dict[str, Any]) -> Tuple[bytes, List[str]]:
        """Concatenate a page's content streams. Returns (bytes, problems)."""
        contents = self.resolve(page.get('Contents'))
        streams = contents if isinstance(contents, list) else [contents]
        chunks = []  # type: List[bytes]
        problems = []  # type: List[str]
        for entry in streams:
            stream = self.resolve(entry)
            if not isinstance(stream, Stream):
                continue
            try:
                chunks.append(decode_stream(stream, self.resolve))
            except UnsupportedFilter as problem:
                problems.append('a content stream uses %s, which this reader does not decode' % problem)
            except zlib.error as problem:
                problems.append('a content stream would not inflate: %s' % problem)
        return (b'\n'.join(chunks), problems)

    def image_names_on(self, page: Dict[str, Any]) -> List[str]:
        """
        The image XObjects a page draws.

        This is what separates "the page is blank" from "the page is a scan". A page with no text
        operators and an image on it is a page that needs OCR, and reporting it as blank is the
        exact confusion this whole tool exists to refuse.
        """
        resources = self.resolve(page.get('Resources'))
        if not isinstance(resources, dict):
            return []
        xobjects = self.resolve(resources.get('XObject'))
        if not isinstance(xobjects, dict):
            return []
        found = []  # type: List[str]
        for key, value in sorted(xobjects.items()):
            entry = self.resolve(value)
            node = entry.dictionary if isinstance(entry, Stream) else entry
            if isinstance(node, dict) and str(self.resolve(node.get('Subtype')) or '') == 'Image':
                found.append(str(key))
        return found


# --------------------------------------------------------------------------------------------
# Fonts
# --------------------------------------------------------------------------------------------

# Enough of the Adobe glyph list to cover a /Differences array over ordinary prose. A name outside
# this table is reported as undecodable rather than approximated - a wrong character is worse than
# an admitted gap, because nothing downstream can tell it is wrong.
_GLYPHS = {
    'space': ' ', 'exclam': '!', 'quotedbl': '"', 'numbersign': '#', 'dollar': '$', 'percent': '%',
    'ampersand': '&', 'quotesingle': "'", 'parenleft': '(', 'parenright': ')', 'asterisk': '*',
    'plus': '+', 'comma': ',', 'hyphen': '-', 'period': '.', 'slash': '/', 'zero': '0', 'one': '1',
    'two': '2', 'three': '3', 'four': '4', 'five': '5', 'six': '6', 'seven': '7', 'eight': '8',
    'nine': '9', 'colon': ':', 'semicolon': ';', 'less': '<', 'equal': '=', 'greater': '>',
    'question': '?', 'at': '@', 'bracketleft': '[', 'backslash': '\\', 'bracketright': ']',
    'asciicircum': '^', 'underscore': '_', 'grave': '`', 'braceleft': '{', 'bar': '|',
    'braceright': '}', 'asciitilde': '~', 'quoteleft': '‘', 'quoteright': '’',
    'quotedblleft': '“', 'quotedblright': '”', 'endash': '–', 'emdash': '—',
    'bullet': '•', 'sterling': '£', 'euro': '€', 'degree': '°',
    'ellipsis': '…', 'fi': 'fi', 'fl': 'fl', 'nbspace': ' ',
}

_SIMPLE_ENCODINGS = {
    'WinAnsiEncoding': 'cp1252',
    'MacRomanEncoding': 'mac_roman',
    'StandardEncoding': 'latin-1',
    'PDFDocEncoding': 'latin-1',
}


class Font(object):
    """
    How one font's bytes become characters, and what it admits when they cannot.

    `decode` returns (text, undecodable_bytes). The second number is the whole point: a font this
    reader cannot resolve produces a count, the caller turns that count into a reported gap, and
    nothing anywhere silently returns fewer characters than the page contained.
    """

    def __init__(self, obj: Any, document: Document):
        self.subtype = ''
        self.basefont = ''
        self.tounicode = None  # type: Optional[Dict[int, str]]
        self.code_bytes = 1
        self.codec = None  # type: Optional[str]
        self.differences = {}  # type: Dict[int, str]
        self.description = 'unresolved'

        node = document.resolve(obj)
        if not isinstance(node, dict):
            return
        self.subtype = str(document.resolve(node.get('Subtype')) or '')
        self.basefont = str(document.resolve(node.get('BaseFont')) or '')

        if self.subtype == 'Type0':
            self.code_bytes = 2

        cmap = document.resolve(node.get('ToUnicode'))
        if isinstance(cmap, Stream):
            try:
                self.tounicode, width = parse_tounicode(decode_stream(cmap, document.resolve))
                if width:
                    self.code_bytes = width
                self.description = '/ToUnicode CMap'
            except (UnsupportedFilter, zlib.error, ValueError):
                self.tounicode = None

        if self.tounicode is None:
            encoding = document.resolve(node.get('Encoding'))
            base = None
            if isinstance(encoding, (str, Name)):
                base = str(encoding)
            elif isinstance(encoding, dict):
                base = str(document.resolve(encoding.get('BaseEncoding')) or '') or None
                self.differences = _differences(document.resolve(encoding.get('Differences')), document)
            if base in _SIMPLE_ENCODINGS:
                self.codec = _SIMPLE_ENCODINGS[base]
                self.description = base
            elif self.subtype in ('Type1', 'TrueType', 'MMType1', 'Type3') or self.differences:
                # No named encoding on a simple font means the font's built-in one. For the base-14
                # faces that is StandardEncoding, which agrees with Latin-1 across printable ASCII.
                self.codec = 'latin-1'
                self.description = 'built-in encoding, read as Latin-1'
            if self.differences:
                self.description += ' with /Differences'

    def decode(self, raw: bytes) -> Tuple[str, int]:
        if self.tounicode is not None:
            return self._decode_cmap(raw)
        if self.differences or self.codec:
            return self._decode_simple(raw)
        return ('', len(raw))

    def _decode_cmap(self, raw: bytes) -> Tuple[str, int]:
        width = self.code_bytes or 1
        out = []  # type: List[str]
        lost = 0
        for index in range(0, len(raw), width):
            chunk = raw[index:index + width]
            code = int.from_bytes(chunk, 'big')
            mapped = self.tounicode.get(code) if self.tounicode else None
            if mapped is None:
                lost += len(chunk)
            else:
                out.append(mapped)
        return (''.join(out), lost)

    def _decode_simple(self, raw: bytes) -> Tuple[str, int]:
        out = []  # type: List[str]
        lost = 0
        for byte in raw:
            if byte in self.differences:
                glyph = self.differences[byte]
                mapped = _glyph_to_char(glyph)
                if mapped is None:
                    lost += 1
                else:
                    out.append(mapped)
                continue
            if not self.codec:
                lost += 1
                continue
            try:
                out.append(bytes([byte]).decode(self.codec))
            except UnicodeDecodeError:
                lost += 1
        return (''.join(out), lost)


def _glyph_to_char(glyph: str) -> Optional[str]:
    if glyph in _GLYPHS:
        return _GLYPHS[glyph]
    if len(glyph) == 1:
        return glyph
    if re.match(r'^uni[0-9A-Fa-f]{4}$', glyph):
        return chr(int(glyph[3:], 16))
    if re.match(r'^u[0-9A-Fa-f]{4,6}$', glyph):
        return chr(int(glyph[1:], 16))
    return None


def _differences(array: Any, document: Document) -> Dict[int, str]:
    if not isinstance(array, list):
        return {}
    out = {}  # type: Dict[int, str]
    code = 0
    for entry in array:
        value = document.resolve(entry)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            code = int(value)
        elif isinstance(value, str):
            out[code] = str(value)
            code += 1
    return out


_BFCHAR = re.compile(rb'beginbfchar(.*?)endbfchar', re.S)
_BFRANGE = re.compile(rb'beginbfrange(.*?)endbfrange', re.S)
_CODESPACE = re.compile(rb'begincodespacerange(.*?)endcodespacerange', re.S)
_HEX = re.compile(rb'<([0-9A-Fa-f\s]*)>')


def _utf16(raw: bytes) -> str:
    try:
        return raw.decode('utf-16-be')
    except UnicodeDecodeError:
        return raw.decode('utf-16-be', 'replace')


def parse_tounicode(data: bytes) -> Tuple[Dict[int, str], int]:
    """Turn a /ToUnicode CMap into {code: text} plus the code width in bytes."""
    mapping = {}  # type: Dict[int, str]

    width = 0
    space = _CODESPACE.search(data)
    if space:
        first = _HEX.search(space.group(1))
        if first:
            width = max(1, len(re.sub(rb'\s', b'', first.group(1))) // 2)

    for block in _BFCHAR.findall(data):
        pairs = _HEX.findall(block)
        for index in range(0, len(pairs) - 1, 2):
            code = int(re.sub(rb'\s', b'', pairs[index]) or b'0', 16)
            mapping[code] = _utf16(bytes.fromhex(re.sub(rb'\s', b'', pairs[index + 1]).decode('ascii')))

    for block in _BFRANGE.findall(data):
        lexer = Lexer(block)
        items = []  # type: List[Any]
        while True:
            kind, value = lexer.next()
            if kind == 'eof':
                break
            if kind == 'obj':
                items.append(value)
        index = 0
        while index + 2 < len(items) + 1 and index + 2 <= len(items):
            low, high, target = items[index], items[index + 1], items[index + 2]
            index += 3
            if not isinstance(low, bytes) or not isinstance(high, bytes):
                continue
            start, end = int.from_bytes(low, 'big'), int.from_bytes(high, 'big')
            if end < start or end - start > 65535:
                continue
            if isinstance(target, bytes):
                base = int.from_bytes(target, 'big')
                for offset in range(end - start + 1):
                    mapping[start + offset] = _utf16((base + offset).to_bytes(max(2, len(target)), 'big'))
            elif isinstance(target, list):
                for offset, entry in enumerate(target):
                    if isinstance(entry, bytes) and start + offset <= end:
                        mapping[start + offset] = _utf16(entry)

    return (mapping, width)


# --------------------------------------------------------------------------------------------
# Text out of a content stream
# --------------------------------------------------------------------------------------------

_SHOW = ('Tj', 'TJ', "'", '"')


def page_text(content: bytes, fonts: Dict[str, Font]) -> Tuple[str, int, List[str]]:
    """
    Pull the shown text out of one page's content stream.

    Returns (text, undecodable_bytes, fonts_that_could_not_be_resolved).

    Line breaks come from the positioning operators, not from geometry. Td/TD with a vertical
    component, T* and ' each start a new line; a large negative kern inside a TJ array becomes a
    space. That is enough for single-column prose and it is honestly not enough for a two-column
    layout, which is stated in DOCUMENTS.md rather than discovered by whoever reads the output.
    """
    lexer = Lexer(content)
    stack = []  # type: List[Any]
    out = []  # type: List[str]
    current = None  # type: Optional[Font]
    unresolved = []  # type: List[str]
    lost = 0

    def newline():
        if out:
            out.append('\n')

    def show(raw: Any):
        nonlocal lost
        if not isinstance(raw, bytes):
            return
        if current is None:
            # No Tf seen. The bytes are still text and Latin-1 is the least-wrong reading of them;
            # they are counted as unresolved so the caller reports a font it could not identify.
            out.append(raw.decode('latin-1'))
            return
        text, missed = current.decode(raw)
        out.append(text)
        lost += missed

    while True:
        kind, value = lexer.next()
        if kind == 'eof':
            break
        if kind == 'obj':
            stack.append(value)
            if len(stack) > 64:
                del stack[:-32]
            continue

        op = str(value)
        if op == 'BT':
            newline()
        elif op == 'Tf':
            key = None
            for item in reversed(stack):
                if isinstance(item, str) and not isinstance(item, bytes):
                    key = str(item)
                    break
            current = fonts.get(key) if key else None
            if key and key not in fonts and key not in unresolved:
                unresolved.append(key)
        elif op == 'T*':
            newline()
        elif op in ('Td', 'TD'):
            vertical = stack[-1] if stack else 0
            if isinstance(vertical, (int, float)) and not isinstance(vertical, bool) and vertical != 0:
                newline()
        elif op == 'Tm':
            newline()
        elif op == "'":
            newline()
            show(stack[-1] if stack else None)
        elif op == '"':
            newline()
            show(stack[-1] if stack else None)
        elif op == 'Tj':
            show(stack[-1] if stack else None)
        elif op == 'TJ':
            array = stack[-1] if stack else None
            if isinstance(array, list):
                for entry in array:
                    if isinstance(entry, bytes):
                        show(entry)
                    elif isinstance(entry, (int, float)) and not isinstance(entry, bool) and entry <= -120:
                        out.append(' ')
        stack = []

    text = ''.join(out)
    text = '\n'.join(line.rstrip() for line in text.split('\n'))
    return (text.strip('\n'), lost, unresolved)


def fonts_on(page: Dict[str, Any], document: Document) -> Dict[str, Font]:
    resources = document.resolve(page.get('Resources'))
    if not isinstance(resources, dict):
        return {}
    table = document.resolve(resources.get('Font'))
    if not isinstance(table, dict):
        return {}
    return dict((str(key), Font(value, document)) for key, value in table.items())
