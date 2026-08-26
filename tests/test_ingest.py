"""Properties the syllabus reader must hold.

A student pastes their syllabus once, and every number the product shows after
that is computed over whatever came out of this file. If the reader invents a
subject, drops a unit, or turns one topic into forty, the forecast is wrong in
a way no amount of good modelling can fix.

    python3 -m pytest tests/ -q
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cutoff.ingest.llm import _tidy
from cutoff.ingest.syllabus import MAX_ITEM_CHARS, parse

SYLLABUS = """\
# Thermodynamics
Unit 1: First law
Closed systems, open systems, control volumes; internal energy, enthalpy
- Carnot cycle, Rankine cycle, reversibility
Unit 2: Second law
Entropy, Clausius inequality, availability

## Fluid Mechanics
Continuity equation, Navier-Stokes, Bernoulli
Laminar and turbulent flow. Reynolds number decides which. Friction factor charts.
"""


def names(text):
    return [s.name for s in parse(text)]


def test_units_nest_inside_the_course_they_belong_to():
    """"Unit 2: Second law" is not a course. This is the failure that turns an
    eight-subject semester into a list of forty phantom subjects."""
    assert names(SYLLABUS) == ["Thermodynamics", "Fluid Mechanics"]


def test_every_item_comes_from_the_input():
    for subject in parse(SYLLABUS):
        for item in subject.items:
            assert item.lower() in SYLLABUS.lower()


def test_topic_lists_are_split_into_separate_items():
    items = parse("Cycles:\nCarnot cycle, Rankine cycle, Otto cycle\n")[0].items
    assert items == ["Carnot cycle", "Rankine cycle", "Otto cycle"]


def test_prose_is_split_on_sentences_not_commas():
    """Notes are prose; a comma inside a sentence is not a topic boundary."""
    items = parse("Flow\nReynolds number decides the regime. Below 2100, flow is laminar.\n")[0].items
    assert items == ["Reynolds number decides the regime", "Below 2100, flow is laminar"]


def test_nothing_before_the_first_heading_is_lost():
    subjects = parse("Bernoulli equation\n", default_subject="Untitled subject")
    assert sum(s.n_items for s in subjects) == 1


def test_duplicates_within_a_subject_collapse():
    subjects = parse("Thermo:\nEntropy\nEntropy\nentropy\n")
    assert subjects[0].items == ["Entropy"]


def test_the_same_heading_twice_is_one_subject():
    subjects = parse("Thermo:\nEntropy\n\nThermo:\nEnthalpy\n")
    assert len(subjects) == 1 and subjects[0].n_items == 2


def test_a_heading_with_nothing_under_it_is_not_a_subject():
    """A capitalised topic line looks exactly like a heading. If it turns out to
    have no content, it was a topic -- so it becomes one."""
    subjects = parse("Thermo:\nEntropy\nAdiabatic Flame Temperature\n")
    assert [s.name for s in subjects] == ["Thermo"]
    assert "Adiabatic Flame Temperature" in subjects[0].items


def test_empty_input_yields_no_subjects():
    assert parse("") == []
    assert parse("\n\n   \n") == []


def test_items_are_length_capped():
    long_line = "Topic:\n" + ("a" * 500) + "\n"
    assert all(len(i) <= MAX_ITEM_CHARS for s in parse(long_line) for i in s.items)


def test_model_output_gets_the_same_hygiene_as_the_parser():
    """The language model is not trusted more than the parser is: same noise
    filter, same de-duplication, same caps."""
    subjects = _tidy([{"name": " Thermo ", "items": ["Carnot cycle", "", "Carnot cycle", "12", "  entropy "]}])
    assert len(subjects) == 1
    assert subjects[0].name == "Thermo"
    assert subjects[0].items == ["Carnot cycle", "entropy"]


def test_a_model_subject_with_no_usable_items_is_dropped():
    assert _tidy([{"name": "Empty", "items": ["", "7", "  "]}]) == []


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-q"]))
