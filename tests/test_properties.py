"""Properties that must hold, or Ebb is lying to a student about their exam.

These are not coverage tests. Each one encodes a claim the product makes out
loud, so that if the model drifts, the claim breaks loudly here instead of
quietly on stage.

    python3 -m pytest tests/ -q      (or: python3 tests/test_properties.py)
"""

from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ebb.core.forecast import CardState, project, review_outcome
from ebb.core.planner import compare_to_cramming, plan
from ebb.model.dsr import INITIAL_PARAMETERS as W
from ebb.model.dsr import retrievability
from ebb.model.features import observed_half_life

EXAM = 60


def a_card(stability=10.0, difficulty=5.0, last_review_day=0.0) -> CardState:
    return CardState("c", "Concept", stability, difficulty, last_review_day)


def test_stability_is_the_ninety_percent_interval():
    """Stability is defined as the interval at which recall hits 90%. If this
    drifts, every stability number Ebb displays becomes meaningless."""
    for s in (1.0, 10.0, 100.0, 365.0):
        assert abs(retrievability(s, s, W[15]) - 0.9) < 1e-12


def test_recall_is_one_at_zero_elapsed():
    assert abs(retrievability(0.0, 10.0, W[15]) - 1.0) < 1e-12


def test_recall_never_increases_with_time():
    card = a_card()
    values = [card.recall_on(d, W) for d in range(0, 200, 5)]
    assert all(b <= a + 1e-12 for a, b in zip(values, values[1:]))


def test_higher_stability_always_means_better_recall():
    weak, strong = a_card(stability=5.0), a_card(stability=50.0)
    for day in (1, 10, 30, 90):
        assert strong.recall_on(day, W) > weak.recall_on(day, W)


def test_a_review_never_hurts():
    card = a_card(stability=5.0, last_review_day=-10)
    before = card.recall_on(EXAM, W)
    assert review_outcome(card, 0, W).recall_on(EXAM, W) >= before


def test_a_later_review_helps_more_for_a_fixed_deadline():
    """This is the uncomfortable one. Under a retrievability model, reviewing
    closer to the exam is better for that exam. Ebb must not claim otherwise."""
    card = a_card(stability=5.0, last_review_day=-10)
    early = review_outcome(card, 0, W).recall_on(EXAM, W)
    late = review_outcome(card, EXAM - 1, W).recall_on(EXAM, W)
    assert late > early


def test_observed_half_life_inverts_the_curve():
    assert abs(observed_half_life(0.5, 10.0) - 10.0) < 1e-9


def test_forecast_aggregates_and_ranks_weakest_first():
    cards = [
        CardState("a", "Strong", 90.0, 3.0, 0.0),
        CardState("b", "Weak", 3.0, 9.0, -5.0),
        CardState("c", "Weak", 4.0, 8.0, -5.0),
    ]
    forecast = project(cards, date.today(), W)
    assert forecast.per_concept[0].concept == "Weak"
    assert forecast.per_concept[0].recall < forecast.per_concept[-1].recall
    assert 0.0 <= forecast.overall_recall <= 1.0


def test_planner_respects_daily_capacity():
    cards = [a_card(stability=3.0, last_review_day=-5) for _ in range(80)]
    for i, c in enumerate(cards):
        c.card_id = f"c{i}"
    result = plan(cards, EXAM, W, target_recall=0.95, max_reviews_per_day=7)
    assert all(len(rs) <= 7 for rs in result.by_day().values())


def test_planner_never_schedules_on_or_after_exam_day():
    cards = [a_card(stability=3.0, last_review_day=-5) for _ in range(20)]
    for i, c in enumerate(cards):
        c.card_id = f"c{i}"
    result = plan(cards, EXAM, W, target_recall=0.95, max_reviews_per_day=5)
    assert all(r.day < EXAM for r in result.reviews)


def test_planner_improves_on_doing_nothing():
    cards = [a_card(stability=4.0, last_review_day=-8) for _ in range(30)]
    for i, c in enumerate(cards):
        c.card_id = f"c{i}"
    result = plan(cards, EXAM, W, target_recall=0.9, max_reviews_per_day=10)
    assert result.recall_after > result.recall_before


def test_capacity_creates_a_point_of_no_return():
    """The claim the whole product rests on: with a daily cap, starting later
    lowers the ceiling on what is achievable at ANY effort."""
    def ceiling(start_day, cap=10):
        states = {f"c{i}": a_card(stability=4.0, last_review_day=-8) for i in range(120)}
        for key, card in states.items():
            card.card_id = key
        for day in range(start_day, EXAM):
            order = sorted(states.values(), key=lambda c: c.recall_on(EXAM, W))
            for card in order[:cap]:
                states[card.card_id] = review_outcome(card, day, W)
        return float(np.mean([c.recall_on(EXAM, W) for c in states.values()]))

    assert ceiling(EXAM - 30) > ceiling(EXAM - 10) > ceiling(EXAM - 2)


if __name__ == "__main__":
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"  PASS  {name}")
            except AssertionError:
                failures += 1
                print(f"  FAIL  {name}")
    print(f"\n{failures} failures")
    sys.exit(1 if failures else 0)
