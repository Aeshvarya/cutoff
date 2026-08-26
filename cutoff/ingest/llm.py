"""The one place in Cutoff where a language model is allowed to run.

It does exactly one job: read a student's messy notes and return the atomic
things they would have to recall, grouped by subject. It is an *extractor*.

It does not estimate how well anything is known, it does not schedule anything,
and it never sees the forecast. Every number the product shows -- the exam-day
recall, the cutoff day, the minutes in the plan -- is computed in
`cutoff/core/` from a fitted memory model, and would be identical if this file
were deleted. That is not a stylistic preference: a language model asked "how
much of this will you remember on November 20th" will produce a confident
number with nothing behind it, and the entire point of Cutoff is that the
number has something behind it.

If no key is configured, or the call fails for any reason, callers fall back to
`cutoff.ingest.syllabus.parse`, which needs no network at all.
"""

from __future__ import annotations

import json
import os

import httpx

from cutoff.ingest.syllabus import (
    MAX_ITEM_CHARS,
    MAX_ITEMS_PER_SUBJECT,
    Subject,
    _clean,
    _is_noise,
)

ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
DEFAULT_MODEL = "gemini-2.5-flash"
TIMEOUT_SECONDS = 45.0

# Long enough to cover a full semester's syllabus, short enough that one paste
# cannot run up a bill or stall a free-tier worker.
MAX_INPUT_CHARS = 24_000

INSTRUCTIONS = """You are given a student's course notes or syllabus.

Split it into subjects, and inside each subject list the atomic facts the
student would have to recall in an exam. One recallable idea per item.

Rules:
- Keep the student's own wording and terminology. Do not teach, expand or
  rephrase into full sentences.
- An item is a thing you could be examined on: a definition, a law, a
  derivation, a mechanism, a named result. Not a chapter title.
- Split lists into separate items. "Carnot, Rankine and Otto cycles" is three.
- Drop administrative text: credits, marks, attendance, textbook lists,
  instructor names, exam dates.
- If the notes are only about one subject, return one subject.
- Never invent material that is not in the input.
"""

SCHEMA = {
    "type": "object",
    "properties": {
        "subjects": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "items": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["name", "items"],
            },
        }
    },
    "required": ["subjects"],
}


class IngestUnavailable(RuntimeError):
    """No key, no network, or the model returned something unusable."""


def api_key() -> str | None:
    return os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or None


def available() -> bool:
    return api_key() is not None


def extract(text: str, *, model: str | None = None) -> list[Subject]:
    """Ask the model for subjects and atomic items. Raises IngestUnavailable."""
    key = api_key()
    if not key:
        raise IngestUnavailable("no GEMINI_API_KEY configured")

    body = text.strip()[:MAX_INPUT_CHARS]
    if not body:
        raise IngestUnavailable("nothing to read")

    model = model or os.environ.get("CUTOFF_GEMINI_MODEL", DEFAULT_MODEL)
    payload = {
        "system_instruction": {"parts": [{"text": INSTRUCTIONS}]},
        "contents": [{"role": "user", "parts": [{"text": body}]}],
        "generationConfig": {
            "temperature": 0.0,            # extraction, not writing
            "responseMimeType": "application/json",
            "responseSchema": SCHEMA,
        },
    }

    try:
        response = httpx.post(
            ENDPOINT.format(model=model),
            headers={"x-goog-api-key": key},
            json=payload,
            timeout=TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        raw = response.json()["candidates"][0]["content"]["parts"][0]["text"]
        parsed = json.loads(raw)
    except Exception as exc:  # network, quota, schema drift -- all the same to us
        raise IngestUnavailable(str(exc)) from exc

    subjects = _tidy(parsed.get("subjects", []))
    if not subjects:
        raise IngestUnavailable("model returned no usable items")
    return subjects


def _tidy(raw_subjects: list) -> list[Subject]:
    """Apply the same hygiene the rules path applies, to the model's output.

    The model is not trusted more than the parser is. Same length caps, same
    noise filter, same de-duplication -- otherwise a hallucinated blank item
    silently becomes a card the student is told to revise.
    """
    subjects: list[Subject] = []
    seen: set[tuple[str, str]] = set()

    for entry in raw_subjects:
        if not isinstance(entry, dict):
            continue
        name = _clean(str(entry.get("name", "")))
        if not name:
            continue
        subject = Subject(name=name[:80])
        for value in entry.get("items", []) or []:
            item = _clean(str(value))[:MAX_ITEM_CHARS].strip()
            if _is_noise(item):
                continue
            key = (subject.name.lower(), item.lower())
            if key in seen or len(subject.items) >= MAX_ITEMS_PER_SUBJECT:
                continue
            seen.add(key)
            subject.items.append(item)
        if subject.items:
            subjects.append(subject)
    return subjects
