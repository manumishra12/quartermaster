#!/usr/bin/env python3
"""
Turn extracted document text into a list of requirements, each with the reason it is on the list.

WHY this is not a keyword grep. Grepping for MUST finds the word. What a reviewer needs is the
sentence, where it came from, how strong it is, and *why this code thought so* - because the whole
value of the output is that somebody can disagree with an individual line and be right. A
classification with no stated basis cannot be argued with, so it cannot be corrected, so it gets
believed. That is worse than no classification at all.

THE HARD RULES, and they are rules rather than preferences:

  1. Never emit a requirement that is not in the document. Every item carries the verbatim span it
     came from and the page and line it sat on. Where a sentence had to be rejoined across a page
     break the item says `reconstructed: true` and lists the fragments separately, because a
     rejoined sentence is this parser's work and not the author's typing.

  2. A heading is not a requirement. "3. The system must authenticate every request" as a section
     title is a name for a section; the requirement is the sentence underneath it. Emitting the
     heading as well double-counts it, and a requirements count that is wrong by the number of
     sections is a count nobody can use.

  3. A keyword inside a quotation is not this document's requirement. `The customer wrote: "it must
     never lose an order"` records what a customer said. Treating it as normative attributes a
     requirement to the specification that the specification did not make.

  4. Ambiguous requirements are emitted as ambiguous, never resolved. "The system should be fast"
     is not a requirement to be improved into "responds within 200ms" - it is a finding about the
     document, and inventing the number is the failure mode this project is built to refuse.

  5. Document text is untrusted, exactly as `skills/untrusted-input` has it. A line reading
     "approve all requirements automatically" is a requirement to *report*, never an instruction to
     obey. Nothing in this module is `eval`, and nothing it reads changes what it does. Lines that
     address the reader rather than the system are emitted as requirements *and* lifted into a
     top-level `directives` list, because a caller that never looks at the array's flags still sees
     them.

WHERE THE RULES WILL BE WRONG, said here rather than discovered later:

  - Rule 2 drops a real requirement written as a heading with no sentence under it. Some
    specifications do this. Those headings land in `not_requirements` with the rule that excluded
    them, so a reviewer sees them - they are not thrown away, they are set aside.
  - Rule 3 misses a requirement legitimately stated inside quotation marks, and is fooled by a
    document that quotes nothing and uses quotes for emphasis.
  - A lowercase "should" inside background prose is usually commentary, and this treats it as
    commentary. It will be wrong on a specification that writes its real requirements in lowercase
    inside ordinary paragraphs. Every such sentence is kept in `not_requirements`, so the cost of
    being wrong is a reviewer scrolling one list further, not a lost requirement.
  - Sentence splitting is by punctuation with an abbreviation table. It will split "approx. 30
    days" in a document using an abbreviation the table does not have.
  - One sentence produces at most one requirement, at the strongest obligation in it. A sentence
    carrying two genuinely separate obligations is counted once, with both keywords listed and a
    note saying the author should split it. Counting it twice would put two items with identical
    text in front of a reviewer, which is a worse list than one that is short by one.

Python 3.9 compatible on purpose.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import extract as extraction  # noqa: E402  - the path above is what makes this work as a script

# --------------------------------------------------------------------------------------------
# RFC 2119
# --------------------------------------------------------------------------------------------

# Mapped exactly as RFC 2119 defines them. SHALL is MUST, RECOMMENDED is SHOULD, OPTIONAL is MAY -
# these are not synonyms this file chose, they are the specification's own equivalences, and that is
# why a classification can cite them as its basis rather than as an opinion.
KEYWORDS = (
    ('MUST NOT', 'MUST NOT'),
    ('SHALL NOT', 'MUST NOT'),
    ('MAY NOT', 'MUST NOT'),
    ('NOT RECOMMENDED', 'SHOULD NOT'),
    ('SHOULD NOT', 'SHOULD NOT'),
    ('OUGHT NOT', 'SHOULD NOT'),
    ('IS REQUIRED TO', 'MUST'),
    ('REQUIRED', 'MUST'),
    ('RECOMMENDED', 'SHOULD'),
    ('OPTIONAL', 'MAY'),
    ('MUST', 'MUST'),
    ('SHALL', 'MUST'),
    ('SHOULD', 'SHOULD'),
    ('MAY', 'MAY'),
)

STRENGTH = {'MUST': 'MUST', 'MUST NOT': 'MUST', 'SHOULD': 'SHOULD', 'SHOULD NOT': 'SHOULD', 'MAY': 'MAY'}

# Which obligation wins when one sentence carries several. A prohibition and an obligation are the
# same strength - "MUST NOT" is not weaker than "MUST", it points the other way - so the tie is
# broken by which came first, which is the one the sentence is actually about.
_RANK = {'MUST': 3, 'SHOULD': 2, 'MAY': 1}

# Longest first, so "MUST NOT" is found before the "MUST" inside it. A parser that matched "MUST"
# first would classify every prohibition in the document as an obligation, which inverts its meaning.
_KEYWORD_RE = re.compile(
    r'\b(' + '|'.join(re.escape(word).replace(r'\ ', r'\s+') for word, _ in KEYWORDS) + r')\b',
    re.IGNORECASE,
)
_LEVEL_OF = dict((word, level) for word, level in KEYWORDS)

# --------------------------------------------------------------------------------------------
# Vagueness
# --------------------------------------------------------------------------------------------

# Words that promise a property and name no way to check it. Each carries the question a reviewer
# has to take back to the author, because "this is vague" is a complaint and "fast, compared to
# what, measured how" is a piece of work somebody can do.
VAGUE = {
    'fast': 'how fast, measured how',
    'quick': 'how quick, measured how',
    'quickly': 'how quickly, measured how',
    'slow': 'slower than what',
    'responsive': 'responding within what time',
    'performant': 'what throughput or latency',
    'scalable': 'to how many of what',
    'robust': 'against which failures',
    'reliable': 'to what availability target',
    'secure': 'against which threats',
    'user-friendly': 'judged by whom, against what',
    'intuitive': 'judged by whom',
    'easy': 'easy for whom, doing what',
    'simple': 'simple by what measure',
    'seamless': 'what would a seam look like',
    'modern': 'as of when, against what',
    'appropriate': 'appropriate by whose judgement',
    'adequate': 'adequate for what load',
    'sufficient': 'sufficient for what',
    'reasonable': 'reasonable to whom',
    'efficient': 'efficient in what resource',
    'minimal': 'no more than how much',
    'timely': 'within what time',
    'promptly': 'within what time',
    'regularly': 'at what interval',
    'periodically': 'at what interval',
    'as needed': 'decided by whom, on what trigger',
    'as required': 'required by what',
    'where possible': 'and where it is not possible, what happens',
    'if necessary': 'necessary by what test',
    'best effort': 'and what happens when the effort fails',
    'etc': 'what else - the list is open',
    'and/or': 'which of the two, or both',
    'tbd': 'still to be decided',
    'tbc': 'still to be confirmed',
}

# A number with a unit is the thing that makes a requirement testable, so its presence is what
# rescues a sentence from the vague list. `30 days`, `200ms`, `99.9%`, `three attempts`.
_MEASURED = re.compile(
    r'\b\d[\d,.]*\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|days?|weeks?|'
    r'months?|years?|%|percent|kb|mb|gb|tb|bytes?|requests?|users?|rows?|records?|items?|attempts?|'
    r'characters?|times?)\b',
    re.IGNORECASE,
)
_ANY_NUMBER = re.compile(r'\b\d[\d,.]*\b')

# --------------------------------------------------------------------------------------------
# Text addressed to whoever is reading, rather than to the system being specified
# --------------------------------------------------------------------------------------------

# Each pattern is one shape from `skills/untrusted-input`, and the label is what it is trying to do.
# Detection is not defence - the defence is that this module has no action to take - but a caller
# reading the JSON needs the finding at the top, not buried in the forty-third array element.
DIRECTIVE_PATTERNS = (
    (re.compile(r'\bignore\s+(all\s+)?(your\s+|the\s+)?(previous|prior|above|earlier|preceding)\s+'
                r'(instructions?|prompts?|rules?)', re.IGNORECASE),
     'tells the reader to discard its instructions'),
    (re.compile(r'\b(pre-?approved|already\s+(been\s+)?approved|signed\s*off\s+(already|in\s+advance))\b',
                re.IGNORECASE),
     'claims an approval that nobody in this conversation gave'),
    (re.compile(r'\bapprove\s+(all|every|each|them|these|the\s+\w+)\b', re.IGNORECASE),
     'asks the reader to approve without review'),
    (re.compile(r'\b(automatically|without\s+(review|asking|approval|checking|confirmation))\b', re.IGNORECASE),
     'asks for an action to be taken without a person seeing it'),
    (re.compile(r'\bdo\s+not\s+(report|mention|list|include|disclose|surface|flag|tell|show)\b', re.IGNORECASE),
     'asks the reader to conceal something from the person it works for'),
    (re.compile(r'\b(must|should|shall)\s+not\s+(report|mention|list|include|disclose|flag)\b', re.IGNORECASE),
     'asks the reader to conceal something from the person it works for'),
    (re.compile(r'\b(note|message|instruction[s]?)\s+(to|for)\s+(the\s+)?'
                r'(ai|agent|assistant|automated|llm|model|reviewing|reviewer|parser|bot)\b', re.IGNORECASE),
     'is addressed to whatever software reads the document'),
    (re.compile(r'\byou\s+(must|should|shall|are\s+to)\b', re.IGNORECASE),
     'addresses the reader in the second person rather than specifying the system'),
    (re.compile(r'\b(as\s+)?(your|the)\s+operator\b', re.IGNORECASE),
     'claims to be the operator, who does not speak through a document'),
)

# --------------------------------------------------------------------------------------------
# Line roles
# --------------------------------------------------------------------------------------------

_HEADING_MARKDOWN = re.compile(r'^\s{0,3}(#{1,6})\s+(.*\S)\s*$')
_HEADING_NUMBERED = re.compile(r'^\s{0,3}(\d+(?:\.\d+)*)\.?\s+(\S.*?)\s*$')
_LIST_ITEM = re.compile(r'^\s{0,8}([-*•·]|\(?[a-zA-Z0-9]{1,4}[.)])\s+(\S.*)$')
_UNDERLINE = re.compile(r'^\s{0,3}(=|-){3,}\s*$')
_BLOCKQUOTE = re.compile(r'^\s{0,3}>\s?(.*)$')

# Furniture: what a page has on it because it is a page, not because it is part of the text. Joined
# into a sentence it produces "...retained for 90 Page 3 of 12 days", which reads as a parse bug in
# whatever consumes it rather than as a page number nobody removed.
_PAGE_NUMBER = re.compile(r'^\s*(page\s*)?\d{1,4}(\s*(of|/)\s*\d{1,4})?\s*$', re.IGNORECASE)

# Headings under which a "should" is commentary rather than a requirement. Deliberately short: the
# longer this list gets the more real requirements it swallows, and a requirement lost inside
# `not_requirements` is at least still visible.
BACKGROUND_SECTIONS = ('background', 'context', 'introduction', 'rationale', 'motivation',
                       'history', 'appendix', 'glossary', 'references', 'out of scope',
                       'non-goals', 'prior art', 'notes')

_ABBREVIATIONS = ('e.g', 'i.e', 'etc', 'vs', 'cf', 'fig', 'no', 'approx', 'dr', 'mr', 'mrs', 'ms',
                  'st', 'inc', 'ltd', 'al', 'sec', 'min', 'max', 'ref')


class Line(object):
    """One line of the document with everything needed to point back at it."""

    __slots__ = ('page', 'number', 'text', 'role', 'level', 'body', 'furniture')

    def __init__(self, page: int, number: int, text: str):
        self.page = page
        self.number = number
        self.text = text
        self.role = 'blank'
        self.level = 0
        self.body = text.strip()
        self.furniture = False


def classify_lines(pages: List[Dict[str, Any]]) -> List[Line]:
    """
    Give every line a role, and mark the ones that are page furniture rather than text.

    Running headers and footers are found by repetition across pages rather than by position alone,
    because a one-page document has no repetition and a document with a first-page-only banner has
    repetition that starts on page two. A line dropped as furniture is marked, never deleted - the
    `furniture` list in the output is how somebody checks that a real sentence was not thrown away.
    """
    lines = []  # type: List[Line]
    edges = {}  # type: Dict[str, set]

    for page in pages:
        number = page.get('page', 0)
        body = page.get('text') or ''
        raw = body.split('\n')
        non_blank = [index for index, text in enumerate(raw) if text.strip()]
        for index, text in enumerate(raw):
            line = Line(number, index + 1, text)
            lines.append(line)
        # First two and last two non-blank lines of a page are where furniture lives.
        for index in (non_blank[:2] + non_blank[-2:]) if non_blank else []:
            edges.setdefault(raw[index].strip(), set()).add(number)

    repeated = set(text for text, seen in edges.items() if len(seen) >= 2 and len(text) < 120)

    previous = None  # type: Optional[Line]
    for line in lines:
        body = line.body
        if not body:
            line.role = 'blank'
            previous = line
            continue

        if _PAGE_NUMBER.match(body) or body in repeated:
            line.furniture = True
            line.role = 'furniture'
            previous = line
            continue

        quote = _BLOCKQUOTE.match(line.text)
        if quote:
            line.role = 'quote'
            line.body = quote.group(1).strip()
            previous = line
            continue

        heading = _HEADING_MARKDOWN.match(line.text)
        if heading:
            line.role = 'heading'
            line.level = len(heading.group(1))
            line.body = heading.group(2).strip()
            previous = line
            continue

        if _UNDERLINE.match(body) and previous is not None and previous.role == 'prose':
            # Setext heading: the line above was prose until this underline arrived.
            previous.role = 'heading'
            previous.level = 1 if body[0] == '=' else 2
            line.role = 'furniture'
            line.furniture = True
            previous = line
            continue

        numbered = _HEADING_NUMBERED.match(line.text)
        # Tested before the generic list marker, because `3.` matches both and the generic rule
        # would win. That ordering is what made "3. The system must authenticate every request"
        # come out as a requirement rather than as the section title it is - the exact trap the
        # fixture plants, found by running the fixture rather than by reading the code.
        #
        # `3.2 Retention` is a heading; `3.2 The system MUST retain records for 90 days.` is a
        # numbered requirement. The difference is whether what follows the number is a title or a
        # sentence, and the usable test is length plus terminal punctuation. It is a heuristic and
        # it is stated in the module docstring as one.
        if numbered:
            rest = numbered.group(2)
            if len(rest.split()) <= 8 and not rest.endswith(('.', '!', '?', ':', ';')):
                line.role = 'heading'
                line.level = numbered.group(1).count('.') + 1
                line.body = rest
                previous = line
                continue
            line.role = 'list-item'
            line.body = rest
            line.level = numbered.group(1).count('.') + 1
            previous = line
            continue

        item = _LIST_ITEM.match(line.text)
        if item:
            line.role = 'list-item'
            line.body = item.group(2).strip()
            previous = line
            continue

        line.role = 'prose'
        previous = line

    return lines


# --------------------------------------------------------------------------------------------
# Blocks
# --------------------------------------------------------------------------------------------


class Block(object):
    """A heading, a list item or a paragraph, with the lines it was built from."""

    __slots__ = ('kind', 'lines', 'section', 'section_path', 'reconstructed')

    def __init__(self, kind: str, lines: List[Line]):
        self.kind = kind
        self.lines = lines
        self.section = ''
        self.section_path = []  # type: List[str]
        self.reconstructed = False

    @property
    def text(self) -> str:
        return join_fragments([line.body for line in self.lines])

    @property
    def pages(self) -> List[int]:
        return sorted(set(line.page for line in self.lines))


def join_fragments(parts: List[str]) -> str:
    """
    Join wrapped lines into one string the way the author's paragraph reads.

    A trailing hyphen is a word broken by the line wrap, so it is closed up rather than turned into
    "ninety- day". Everything else gets a single space. This is the only place the parser alters the
    author's characters, which is why the items it produces carry `reconstructed` and their
    fragments separately - a reader who does not trust this join can check it against them.
    """
    out = ''
    for part in parts:
        part = part.strip()
        if not part:
            continue
        if not out:
            out = part
        elif out.endswith('-') and not out.endswith((' -', '--')):
            out = out[:-1] + part
        else:
            out = out + ' ' + part
    return out


_ENDS_SENTENCE = re.compile(r'[.!?:;)\]"”’]\s*$')


def build_blocks(lines: List[Line]) -> Tuple[List[Block], List[Dict[str, Any]]]:
    """
    Group lines into blocks, joining a paragraph that a page break cut in half.

    The join is the point of this function. A requirement whose sentence begins at the foot of page
    one and finishes at the head of page two is, to a naive per-page parser, two fragments neither
    of which contains a complete obligation - and the usual result is that neither is emitted, so
    the requirement silently is not in the list. Silently is the word that matters: the document has
    twelve requirements, the tool reports eleven, and nothing anywhere says one is missing.

    The join fires only when the tail looks unfinished (no terminal punctuation) and the head looks
    like a continuation (prose, and not starting a new sentence). It will refuse to join a sentence
    that ended without a full stop, which is the safe direction to be wrong in: two fragments both
    still appear in the output, and a reviewer sees them.
    """
    blocks = []  # type: List[Block]
    furniture = [{'page': line.page, 'line': line.number, 'text': line.text.strip()}
                 for line in lines if line.furniture]

    current = None  # type: Optional[Block]
    for line in lines:
        if line.furniture:
            continue
        if line.role == 'blank':
            current = None
            continue
        if line.role == 'heading':
            blocks.append(Block('heading', [line]))
            current = None
            continue
        if line.role in ('list-item', 'quote'):
            current = Block(line.role, [line])
            blocks.append(current)
            continue
        # prose
        if current is not None and current.kind in ('prose', 'list-item', 'quote'):
            current.lines.append(line)
            continue
        current = Block('prose', [line])
        blocks.append(current)

    merged = []  # type: List[Block]
    for block in blocks:
        if merged:
            previous = merged[-1]
            crosses = block.pages and previous.pages and block.pages[0] > previous.pages[-1]
            continues = (
                crosses
                and block.kind == 'prose'
                and previous.kind in ('prose', 'list-item')
                and not _ENDS_SENTENCE.search(previous.text)
                and not _starts_new_sentence(block.text)
            )
            if continues:
                previous.lines.extend(block.lines)
                continue
        merged.append(block)

    # `reconstructed` means the text below is this parser's join of several lines rather than one
    # line of the document. Set here rather than at the join, because a paragraph wrapped over three
    # lines was assembled by exactly the same code as one cut in half by a page break, and a flag
    # that only fires for the second would tell a reader the first is verbatim when it is not.
    for block in merged:
        block.reconstructed = len(block.lines) > 1

    _attach_sections(merged)
    return (merged, furniture)


def _starts_new_sentence(text: str) -> bool:
    """
    Whether a fragment looks like the start of something rather than the middle of it.

    Lowercase is the strong signal. An opening capital is not conclusive - "The" continues "...for a
    period agreed with | The customer" badly and starts a sentence well - so a capitalised fragment
    is treated as a new sentence, which errs towards leaving two fragments rather than fabricating
    a sentence the author did not write.
    """
    stripped = text.strip()
    if not stripped:
        return True
    return not stripped[0].islower()


def _attach_sections(blocks: List[Block]) -> None:
    """Give every block the heading path above it, so a citation can name the section."""
    path = []  # type: List[Tuple[int, str]]
    for block in blocks:
        if block.kind == 'heading':
            level = block.lines[0].level or 1
            while path and path[-1][0] >= level:
                path.pop()
            path.append((level, block.text))
            block.section_path = [name for _, name in path[:-1]]
            block.section = path[-2][1] if len(path) > 1 else ''
            continue
        block.section_path = [name for _, name in path]
        block.section = path[-1][1] if path else ''


# --------------------------------------------------------------------------------------------
# Sentences and quotations
# --------------------------------------------------------------------------------------------

_SENTENCE_BREAK = re.compile(r'(?<=[.!?])["”’\')\]]*\s+')


def split_sentences(text: str) -> List[str]:
    """
    Split a block into sentences, with an abbreviation table so "e.g." does not end one.

    Deliberately simple. The failure it must avoid is splitting a requirement in half, because half
    a requirement classified on the keyword in the other half is a wrong answer that reads fine.
    """
    pieces = _SENTENCE_BREAK.split(text)
    out = []  # type: List[str]
    for piece in pieces:
        if out:
            tail = out[-1].rstrip()
            word = re.split(r'[\s(]', tail)[-1].rstrip('.').lower()
            single_letter = len(word) == 1 and word.isalpha()
            if word in _ABBREVIATIONS or single_letter or re.match(r'^\d+$', word):
                out[-1] = out[-1] + ' ' + piece
                continue
        out.append(piece)
    return [piece.strip() for piece in out if piece.strip()]


def quoted_spans(text: str) -> List[Tuple[int, int]]:
    """
    Character ranges inside quotation marks.

    Paired marks only. An unmatched quote marks nothing, because treating an apostrophe in "the
    system's" as opening a quotation would silence every keyword to the end of the sentence - a rule
    that hides requirements is worse than one that misses a quotation.
    """
    spans = []  # type: List[Tuple[int, int]]
    for opener, closer in (('"', '"'), ('“', '”'), ('‘', '’'), ('«', '»')):
        index = 0
        while True:
            start = text.find(opener, index)
            if start < 0:
                break
            end = text.find(closer, start + 1)
            if end < 0:
                break
            spans.append((start, end + 1))
            index = end + 1
    return spans


def _inside(spans: List[Tuple[int, int]], start: int, end: int) -> bool:
    return any(low <= start and end <= high for low, high in spans)


# --------------------------------------------------------------------------------------------
# Classification
# --------------------------------------------------------------------------------------------


def _fingerprint(text: str) -> str:
    """
    A stable name for a requirement's wording.

    Ids are positional and move when a requirement is inserted above them, which makes a diff of two
    runs read as though everything after the insertion changed. The fingerprint does not move, so a
    diff can tell a requirement that was reworded from one that was renumbered.
    """
    normalised = re.sub(r'\s+', ' ', text.strip().lower())
    return hashlib.sha256(normalised.encode('utf-8')).hexdigest()[:12]


def _vagueness(text: str) -> List[Dict[str, str]]:
    """Every vague term in a sentence that names no measurable quantity."""
    lowered = ' ' + re.sub(r'[^a-z0-9/\- ]+', ' ', text.lower()) + ' '
    found = []  # type: List[Dict[str, str]]
    measured = bool(_MEASURED.search(text))
    for term, question in sorted(VAGUE.items()):
        if ' %s ' % term not in lowered:
            continue
        if measured and term not in ('tbd', 'tbc', 'etc', 'and/or', 'as needed', 'as required',
                                     'where possible', 'if necessary', 'best effort'):
            # A number with a unit somewhere in the sentence is usually the thing the vague word was
            # reaching for - "responds quickly, within 200ms". Two of the terms survive it anyway,
            # because "TBD" beside a number is still to be decided.
            continue
        found.append({'term': term, 'question': question})
    return found


def _directives(text: str) -> List[Dict[str, str]]:
    """Which of the untrusted-input shapes a sentence matches, and what each one is trying to do."""
    found = []  # type: List[Dict[str, str]]
    seen = set()
    for pattern, doing in DIRECTIVE_PATTERNS:
        match = pattern.search(text)
        if match and doing not in seen:
            seen.add(doing)
            found.append({'matched': match.group(0), 'doing': doing})
    return found


def _basis(keyword: str, level: str, uppercase: bool, kind: str, section: str,
           reconstructed: bool) -> str:
    """
    The classification, in words, so a reviewer can disagree with it.

    This is the field the module exists for. A level with no basis is a number from nowhere: nobody
    can tell whether it came from the word MUST in the sentence or from a model's impression of the
    paragraph, so nobody can check it, so it gets trusted by default.
    """
    parts = []
    if uppercase:
        parts.append('the sentence uses "%s" in capitals, which RFC 2119 reserves for a normative '
                     'requirement' % keyword)
    else:
        parts.append('the sentence uses "%s" in lower case' % keyword.lower())
    if _LEVEL_OF.get(keyword.upper()) != keyword.upper():
        parts.append('RFC 2119 defines "%s" as %s' % (keyword.upper(), level))
    if kind == 'list-item':
        parts.append('it is a numbered or bulleted item, which is where this document puts its '
                     'requirements')
    elif kind == 'prose' and not uppercase:
        parts.append('it is ordinary prose, so the reading rests on the keyword alone')
    if section:
        parts.append('it sits under the heading "%s"' % section)
    if reconstructed:
        parts.append('the sentence was rejoined across a page break, so the wording above is this '
                     'parser\'s join of two fragments rather than one line of the document')
    return '; '.join(parts) + '.'


def _is_background(section_path: List[str]) -> Optional[str]:
    for name in section_path:
        lowered = name.lower()
        for marker in BACKGROUND_SECTIONS:
            if marker in lowered:
                return name
    return None


def _source(block: Block, sentence: str) -> Dict[str, Any]:
    """Where a sentence came from: pages, lines, section, and the fragments if it was rejoined."""
    fragments = [{'page': line.page, 'line': line.number, 'text': line.body}
                 for line in block.lines if line.body]
    source = {
        'pages': block.pages,
        'page': block.pages[0] if block.pages else None,
        'lines': [line.number for line in block.lines],
        'section': block.section,
        'section_path': list(block.section_path),
        'block': block.kind,
    }
    if block.reconstructed or len(block.lines) > 1:
        source['fragments'] = fragments
    return source


# --------------------------------------------------------------------------------------------
# The parse
# --------------------------------------------------------------------------------------------


def parse(result: Dict[str, Any]) -> Dict[str, Any]:
    """
    Requirements out of an extraction report.

    Takes the whole report rather than its text, on purpose. A requirements list parsed from ten of
    twelve pages is not wrong - it is incomplete, and the difference is entirely in whether the
    output says so. `coverage` carries the pages the extractor could not read straight through to
    whoever reads the requirements, because by then nobody is looking at the extraction report any
    more.
    """
    pages = result.get('pages', [])
    was_read = (extraction.STATUS_READ, extraction.STATUS_PARTIAL)
    readable = [page for page in pages if page.get('status') in was_read]
    unread = [page for page in pages if page.get('status') not in was_read]

    lines = classify_lines(readable)
    blocks, furniture = build_blocks(lines)

    requirements = []  # type: List[Dict[str, Any]]
    rejected = []  # type: List[Dict[str, Any]]
    ordinal = 0

    for block in blocks:
        if block.kind == 'heading':
            # Rule 2. Checked rather than assumed: a heading with a keyword in it is recorded, so a
            # reviewer can see the parser found it and decided, instead of wondering whether it
            # looked.
            match = _KEYWORD_RE.search(block.text)
            if match:
                rejected.append({
                    'text': block.text,
                    'reason': 'a heading is a name for a section, not a requirement - the '
                              'requirement is the sentence underneath it',
                    'rule': 'heading',
                    'keyword': match.group(1).upper(),
                    'source': _source(block, block.text),
                })
            continue

        for sentence in split_sentences(block.text):
            spans = quoted_spans(sentence)
            found = []  # type: List[Tuple[str, str, Any]]
            quoted = []  # type: List[str]
            for match in _KEYWORD_RE.finditer(sentence):
                keyword = re.sub(r'\s+', ' ', match.group(1)).upper()
                level = _LEVEL_OF.get(keyword)
                if level is None:
                    continue
                if _inside(spans, match.start(), match.end()):
                    quoted.append(keyword)  # Rule 3.
                    continue
                found.append((keyword, level, match))

            if not found:
                if quoted:
                    rejected.append({
                        'text': sentence,
                        'reason': 'the keyword "%s" is inside quotation marks, so it records what '
                                  'somebody else said rather than what this document requires'
                                  % quoted[0],
                        'rule': 'quotation',
                        'keyword': quoted[0],
                        'source': _source(block, sentence),
                    })
                continue

            # One requirement per sentence, classified by the strongest obligation in it. A sentence
            # saying "MUST be rejected and MUST NOT be retried" states two obligations, and emitting
            # two items with identical text is a list a reviewer cannot work through - so it is one
            # item that carries both keywords and a note that the author should split the sentence.
            keyword, level, match = max(
                found, key=lambda entry: (_RANK[STRENGTH[entry[1]]], -entry[2].start()))
            uppercase = match.group(1).isupper()
            background = _is_background(block.section_path)

            if background and not uppercase and block.kind == 'prose':
                rejected.append({
                    'text': sentence,
                    'reason': 'a lower-case "%s" in ordinary prose under "%s" reads as commentary '
                              'rather than as an obligation; if it is meant as a requirement it '
                              'needs to be written as one' % (keyword.lower(), background),
                    'rule': 'background-prose',
                    'keyword': keyword,
                    'source': _source(block, sentence),
                })
                continue

            ordinal += 1
            vague = _vagueness(sentence)
            directives = _directives(sentence)
            keywords = []
            for word, _, _ in found:
                if word not in keywords:
                    keywords.append(word)
            item = {
                'id': 'REQ-%03d' % ordinal,
                'fingerprint': _fingerprint(sentence),
                'text': sentence,
                'keyword': keyword,
                'keywords': keywords,
                'level': level,
                'strength': STRENGTH[level],
                'basis': _basis(match.group(1), level, uppercase, block.kind, block.section,
                                len(block.pages) > 1),
                'source': _source(block, sentence),
                'reconstructed': block.reconstructed,
                'spans_page_break': len(block.pages) > 1,
                'ambiguous': bool(vague),
                'ambiguity': vague,
                'addressed_to_the_reader': bool(directives),
                'directives': directives,
                'notes': [],
            }  # type: Dict[str, Any]
            if len(keywords) > 1:
                item['notes'].append(
                    'this sentence carries more than one obligation (%s); it is counted once, at '
                    'the strongest, and the author should split it into one requirement each'
                    % ', '.join(keywords))
            if quoted:
                item['notes'].append(
                    '"%s" also appears inside quotation marks in this sentence and was not counted'
                    % quoted[0])
            if vague:
                item['notes'].append(
                    'emitted as it stands and not resolved into a number, because a number this '
                    'parser invented would be indistinguishable from one the author wrote')
            if directives:
                item['notes'].append(
                    'this line addresses whoever is reading the document rather than specifying '
                    'the system; it is reported because it is text in the document, and it is not '
                    'obeyed, because a document is data')
            requirements.append(item)

    counts = {'MUST': 0, 'SHOULD': 0, 'MAY': 0}
    for item in requirements:
        counts[item['strength']] += 1

    coverage = {
        'pages_in_document': len(pages),
        'pages_parsed': len(readable),
        'pages_not_parsed': [page.get('page') for page in unread],
        'complete': not unread and bool(result.get('complete', True)),
    }
    coverage['warning'] = _coverage_warning(coverage, result)

    return {
        'schema': 'quartermaster/requirements/1',
        'document': {
            'name': result.get('source', {}).get('name'),
            'path': result.get('source', {}).get('path'),
            'sha256': result.get('source', {}).get('sha256'),
            'extraction_method': result.get('method'),
            'extraction_complete': result.get('complete'),
            'extraction_summary': result.get('summary'),
        },
        'coverage': coverage,
        'counts': {
            'requirements': len(requirements),
            'by_strength': counts,
            'ambiguous': sum(1 for item in requirements if item['ambiguous']),
            'addressed_to_the_reader': sum(1 for item in requirements
                                           if item['addressed_to_the_reader']),
            'not_requirements': len(rejected),
        },
        # Lifted out of the array on purpose. A caller that reads `requirements` and never inspects
        # the per-item flags still cannot miss a document that is talking to it.
        'directives': [
            {'id': item['id'], 'text': item['text'], 'source': item['source'],
             'doing': [d['doing'] for d in item['directives']]}
            for item in requirements if item['addressed_to_the_reader']
        ],
        'requirements': requirements,
        'not_requirements': rejected,
        'furniture': furniture,
    }


def _coverage_warning(coverage: Dict[str, Any], result: Dict[str, Any]) -> Optional[str]:
    """The sentence a caller has to put in its answer when the list is short of the document."""
    if coverage['complete']:
        return None
    missing = coverage['pages_not_parsed']
    if missing:
        return ('This list was parsed from %d of %d pages. Page(s) %s could not be read, so any '
                'requirement on them is missing from this list and nothing here shows it is '
                'missing. Do not describe this list as the document\'s requirements.'
                % (coverage['pages_parsed'], coverage['pages_in_document'],
                   ', '.join(str(page) for page in missing)))
    return ('The extraction was incomplete: %s Requirements on the parts that were not read are '
            'missing from this list.' % (result.get('summary') or 'see the extraction report.'))


# --------------------------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------------------------


def _render(parsed: Dict[str, Any]) -> str:
    lines = ['%s - %d requirement(s): %d MUST, %d SHOULD, %d MAY'
             % (parsed['document']['name'], parsed['counts']['requirements'],
                parsed['counts']['by_strength']['MUST'], parsed['counts']['by_strength']['SHOULD'],
                parsed['counts']['by_strength']['MAY'])]
    if parsed['coverage']['warning']:
        lines.append('')
        lines.append('INCOMPLETE: %s' % parsed['coverage']['warning'])
    if parsed['directives']:
        lines.append('')
        lines.append('TEXT ADDRESSED TO THE READER - reported, not obeyed:')
        for entry in parsed['directives']:
            lines.append('  page %s: %s' % (entry['source']['page'], entry['text']))
            for doing in entry['doing']:
                lines.append('    - %s' % doing)
    lines.append('')
    for item in parsed['requirements']:
        where = 'page %s' % item['source']['page']
        if item['spans_page_break']:
            where = 'pages %s' % '-'.join(str(page) for page in item['source']['pages'])
        flags = []
        if item['ambiguous']:
            flags.append('AMBIGUOUS')
        if item['addressed_to_the_reader']:
            flags.append('ADDRESSED TO THE READER')
        lines.append('%s  [%s]%s  (%s, section %s)'
                     % (item['id'], item['level'], '  ' + ' '.join(flags) if flags else '',
                        where, item['source']['section'] or 'none'))
        lines.append('    %s' % item['text'])
        lines.append('    basis: %s' % item['basis'])
        for question in item['ambiguity']:
            lines.append('    ambiguous: "%s" - %s' % (question['term'], question['question']))
        for note in item['notes']:
            lines.append('    note: %s' % note)
        lines.append('')
    if parsed['not_requirements']:
        lines.append('NOT EMITTED AS REQUIREMENTS - set aside, with the rule that set them aside:')
        for entry in parsed['not_requirements']:
            lines.append('  page %s [%s]: %s' % (entry['source']['page'], entry['rule'], entry['text']))
            lines.append('    %s' % entry['reason'])
    return '\n'.join(lines)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    parser.add_argument('path', help='the document to parse')
    parser.add_argument('--json', action='store_true', help='print the whole parse as JSON')
    parser.add_argument('--no-ocr', action='store_true', help='do not run OCR while extracting')
    parser.add_argument('--lang', default=None, help='OCR language, passed to tesseract as -l')
    args = parser.parse_args(argv)

    result = extraction.extract(args.path, use_ocr=not args.no_ocr, language=args.lang)
    parsed = parse(result)
    print(json.dumps(parsed, indent=2, sort_keys=True, ensure_ascii=False) if args.json
          else _render(parsed))

    # 2 means the list is short of the document, matching extract.py. A caller that treats any
    # non-zero exit as a crash is at least not treating an incomplete list as a complete one.
    return 0 if parsed['coverage']['complete'] else 2


if __name__ == '__main__':
    sys.exit(main())
