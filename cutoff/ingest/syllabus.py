"""Turn a pasted syllabus into subjects and the facts inside them.

This is the only part of Cutoff that reads free text, and it is deliberately
the *dumb* part. Everything downstream -- the forecast, the cutoff day, the
plan -- is arithmetic on the items this file produces. Nothing here predicts
anything.

Two paths, same output shape:

  * these rules, which need no network and no key, and
  * `cutoff.ingest.llm`, which asks a language model to do the same job better
    when a key is present.

The rules path is not a fallback we are embarrassed by. A university syllabus
is already a structured document -- units, then comma-separated topic lists --
and a parser that respects that structure beats a model that paraphrases it.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field

# A heading looks like one of these. Order matters: the earlier a pattern is
# tried, the more confident we are that a line is a subject and not a topic.
_MARKDOWN_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+(?P<text>.+?)\s*#*\s*$")
_UNIT_HEADING = re.compile(
    r"^\s*(?:unit|module|chapter|week|part|section|topic)\s*[-–—:.]?\s*"
    r"(?:[0-9]+|[ivxlc]+)?\s*[-–—:.)]?\s*(?P<text>.*)$",
    re.IGNORECASE,
)
_COURSE_CODE = re.compile(
    r"^\s*(?P<code>[A-Z]{2,4}\s?[0-9]{3,4}[A-Z]?)\s*[-–—:.)]\s*(?P<text>.+)$"
)
_TRAILING_COLON = re.compile(r"^(?P<text>[^.!?]{3,80}):\s*$")

# Leading list furniture: "1.", "(a)", "iv)", "-", "*", "•".
_BULLET = re.compile(r"^\s*(?:[-*•·–—]|\(?\s*(?:[0-9]{1,2}|[ivxlc]{1,5}|[a-z])\s*[.)])\s+")

# Splitters inside one line of a topic list. Semicolons and commas separate
# topics in almost every syllabus ever written; sentence enders separate facts
# in almost every set of notes.
_HARD_SPLIT = re.compile(r"\s*[;•]\s*|\s+[-–—]\s+")
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9])")

_STOPWORD_ONLY = {
    "and", "or", "the", "of", "to", "in", "for", "with", "a", "an", "etc",
    "introduction", "overview", "contents", "syllabus", "references", "textbook",
    "text books", "reference books", "course outcomes", "prerequisites",
}

MIN_ITEM_CHARS = 3
MAX_ITEM_CHARS = 140
MAX_ITEMS_PER_SUBJECT = 400


@dataclass
class Subject:
    """One course, and the atomic things you would have to recall in it."""

    name: str
    items: list[str] = field(default_factory=list)

    @property
    def n_items(self) -> int:
        return len(self.items)

    def as_dict(self) -> dict:
        return {"name": self.name, "n_items": self.n_items, "items": self.items}


def _clean(text: str) -> str:
    text = unicodedata.normalize("NFKC", text)
    text = text.replace(" ", " ")
    text = _BULLET.sub("", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text.strip(" .;:,-–—")


def _is_noise(item: str) -> bool:
    if len(item) < MIN_ITEM_CHARS:
        return True
    if item.lower() in _STOPWORD_ONLY:
        return True
    # A fragment with no letters is a page number or a mark allocation.
    return not any(ch.isalpha() for ch in item)


def _heading(line: str) -> tuple[str, int] | None:
    """Return `(name, level)` if this line is a heading, else None.

    Level 0 opens a new subject. Level 1 is a unit *inside* the subject above
    it -- "Unit 2: Second law" does not make Second Law a course, and treating
    it as one is how a syllabus turns into forty phantom subjects.

    A heading is a *label*, not a sentence. The tests below run from most
    explicit (someone typed `## Thermodynamics`) to most inferred (a short line
    in title case with no verb-like punctuation).
    """
    raw = line.rstrip()
    if not raw.strip():
        return None

    m = _MARKDOWN_HEADING.match(raw)
    if m:
        text = _clean(m.group("text"))
        if not text:
            return None
        depth = len(raw) - len(raw.lstrip("# \t"))
        return text, 0 if raw.lstrip().count("#", 0, 3) <= 2 else 1

    stripped = raw.strip()

    m = _COURSE_CODE.match(stripped)
    if m:
        return (_clean(m.group("text")) or _clean(m.group("code"))), 0

    m = _UNIT_HEADING.match(stripped)
    if m and m.group("text"):
        text = _clean(m.group("text"))
        # "Unit 3: Distillation" is a heading. "Unit operations are used to..."
        # is prose that merely starts with the word unit.
        if text and len(text) <= 80 and "," not in text:
            return text, 1

    m = _TRAILING_COLON.match(stripped)
    if m:
        text = _clean(m.group("text"))
        if text and not _BULLET.match(raw):
            return text, 0

    return None


def _bare_title(line: str) -> str | None:
    """An unpunctuated short line in Title Case or ALL CAPS -- "Mass Transfer".

    This is the weakest signal in the file and it is deliberately not consulted
    unless the document has no explicit headings at all. A single capitalised
    topic sitting under a real heading is a topic, not a course.
    """
    raw = line.rstrip()
    stripped = raw.strip()
    if not stripped or _BULLET.match(raw):
        return None
    if len(stripped) > 60 or stripped.endswith((".", ",", ";")):
        return None
    words = stripped.split()
    if not 1 <= len(words) <= 7:
        return None
    alpha = [w for w in words if w[:1].isalpha()]
    if not alpha or not all(w[:1].isupper() for w in alpha):
        return None
    return _clean(stripped) or None


def _atoms(line: str) -> list[str]:
    """Split one content line into the smallest things worth remembering."""
    body = _clean(line)
    if not body:
        return []

    pieces: list[str] = []
    for chunk in _HARD_SPLIT.split(body):
        chunk = chunk.strip()
        if not chunk:
            continue
        # Sentences first: notes are prose. If there are none, the line is a
        # topic list and commas are the separator.
        sentences = _SENTENCE_SPLIT.split(chunk)
        if len(sentences) > 1:
            pieces.extend(sentences)
        elif chunk.count(",") >= 1 and len(chunk) <= 300 and not re.search(r"\b(is|are|was|were|the)\b.*,", chunk):
            pieces.extend(chunk.split(","))
        else:
            pieces.append(chunk)

    out = []
    for piece in pieces:
        item = _clean(piece)
        if _is_noise(item):
            continue
        out.append(item[:MAX_ITEM_CHARS].strip())
    return out


def parse(text: str, default_subject: str = "Untitled subject") -> list[Subject]:
    """Parse a pasted syllabus into subjects, each holding atomic items.

    Two passes. The first decides which lines are headings, because that
    decision needs to see the whole document: if the student's notes use
    markdown, unit numbers or colons, those are the headings and a capitalised
    topic line is just a topic. Only when a document has no explicit heading at
    all does a bare title-case line get promoted -- and then only if something
    actually follows it, since a heading with nothing under it was never a
    heading.

    Text before the first heading is kept under `default_subject` rather than
    dropped: silently losing a student's first paragraph is worse than an
    awkward name.
    """
    lines = [ln for ln in text.splitlines() if ln.strip()]
    explicit = [_heading(ln) for ln in lines]
    use_bare = not any(explicit)
    bare = [_bare_title(ln) if use_bare else None for ln in lines]

    if use_bare:
        # A bare title only counts as a heading when the next line is content.
        for i, name in enumerate(bare):
            if name is None:
                continue
            following = bare[i + 1] if i + 1 < len(bare) else None
            if i + 1 >= len(bare) or following is not None:
                bare[i] = None

    subjects: list[Subject] = []
    current: Subject | None = None
    seen: set[tuple[str, str]] = set()

    def open_subject(name: str) -> Subject:
        existing = next((s for s in subjects if s.name.lower() == name.lower()), None)
        if existing is not None:
            return existing
        fresh = Subject(name=name)
        subjects.append(fresh)
        return fresh

    for i, line in enumerate(lines):
        head = explicit[i]
        if head is not None:
            name, level = head
            if level == 1 and current is not None:
                # A unit label inside the subject we are already in. It names
                # the block that follows; it does not start a course.
                continue
            current = open_subject(name)
            continue

        if bare[i] is not None:
            current = open_subject(bare[i])
            continue

        if current is None:
            current = open_subject(default_subject)

        for item in _atoms(line):
            key = (current.name.lower(), item.lower())
            if key in seen or len(current.items) >= MAX_ITEMS_PER_SUBJECT:
                continue
            seen.add(key)
            current.items.append(item)

    # A heading with nothing under it is a heading we misread. Fold it back
    # into the subject above rather than dropping the student's words.
    merged: list[Subject] = []
    for subject in subjects:
        if not subject.items and merged:
            key = (merged[-1].name.lower(), subject.name.lower())
            if key not in seen:
                seen.add(key)
                merged[-1].items.append(subject.name)
            continue
        merged.append(subject)

    return [s for s in merged if s.items]
