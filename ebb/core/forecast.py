"""What will you actually remember on exam day?

Every spaced-repetition tool answers "what should I review today". Ebb answers a
different question: given everything you have studied and a date in the future,
what is the probability you still hold each concept on THAT MORNING -- and what
does the whole syllabus average out to.

Anki's FSRS reports average predicted retention for *today* and can simulate
future *workload*. Neither it nor Duolingo projects a body of material to a fixed
calendar date. That projection is what Ebb computes, and it is the only thing
here a language model has no part in.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, timedelta

import numpy as np

from ebb.model.dsr import (
    MAX_STABILITY,
    MIN_STABILITY,
    _next_difficulty,
    _next_stability,
    retrievability,
)


@dataclass
class CardState:
    """One thing you are trying to remember, and how strongly you hold it."""

    card_id: str
    concept: str
    stability: float        # days until recall falls to 90%
    difficulty: float       # 1..10
    last_review_day: float  # position on a timeline where today is 0.
                            # -3 means "reviewed three days ago";
                            # +14 means "a review is planned in a fortnight".

    def recall_on(self, day: float, parameters: np.ndarray) -> float:
        """Probability of recalling this card on `day`, where today is day 0."""
        elapsed = max(day - self.last_review_day, 0.0)
        return float(retrievability(elapsed, self.stability, parameters[15]))


@dataclass
class ConceptForecast:
    concept: str
    n_cards: int
    recall: float
    weakest_card: str


@dataclass
class Forecast:
    """The answer, at three resolutions."""

    exam_date: date
    days_away: int
    overall_recall: float
    per_concept: list[ConceptForecast]
    per_card: dict[str, float] = field(default_factory=dict)

    @property
    def expected_marks_lost(self) -> float:
        """If the paper sampled your syllabus uniformly, this is the share of it
        you would not be able to produce."""
        return 1.0 - self.overall_recall


def project(
    cards: list[CardState],
    exam_date: date,
    parameters: np.ndarray,
    today: date | None = None,
) -> Forecast:
    """Project every card forward to the exam and aggregate by concept."""
    today = today or date.today()
    days_away = (exam_date - today).days
    if not cards:
        raise ValueError("nothing to forecast")

    per_card = {c.card_id: c.recall_on(days_away, parameters) for c in cards}

    by_concept: dict[str, list[CardState]] = {}
    for card in cards:
        by_concept.setdefault(card.concept, []).append(card)

    per_concept = []
    for concept, group in sorted(by_concept.items()):
        recalls = [per_card[c.card_id] for c in group]
        weakest = min(group, key=lambda c: per_card[c.card_id])
        per_concept.append(
            ConceptForecast(
                concept=concept,
                n_cards=len(group),
                recall=float(np.mean(recalls)),
                weakest_card=weakest.card_id,
            )
        )

    per_concept.sort(key=lambda c: c.recall)

    return Forecast(
        exam_date=exam_date,
        days_away=days_away,
        overall_recall=float(np.mean(list(per_card.values()))),
        per_concept=per_concept,
        per_card=per_card,
    )


def curve(card: CardState, until_days: int, parameters: np.ndarray, points: int = 60):
    """The decay curve to draw: (day, recall) pairs, today being day 0."""
    xs = np.linspace(0, max(until_days, 1), points)
    return [(float(x), card.recall_on(float(x), parameters)) for x in xs]


def review_outcome(
    card: CardState,
    day: float,
    parameters: np.ndarray,
    assumed_rating: int = 3,
) -> CardState:
    """The card's expected state after being reviewed on `day` (today is 0).

    A review has two outcomes and we do not know which will happen, so we take
    the expectation over them, weighted by the model's own recall probability.
    Averaging the two states is an approximation -- the honest name for it is a
    mean-field step -- but it keeps the planner deterministic and fast, and it is
    the same assumption FSRS's own workload simulator makes.
    """
    r = card.recall_on(day, parameters)

    arr = lambda v: np.array([v], dtype=np.float64)
    stability_if_recalled = float(
        _next_stability(arr(card.stability), arr(card.difficulty), arr(r), arr(assumed_rating), parameters)[0]
    )
    stability_if_lapsed = float(
        _next_stability(arr(card.stability), arr(card.difficulty), arr(r), arr(1), parameters)[0]
    )
    expected_stability = r * stability_if_recalled + (1 - r) * stability_if_lapsed

    difficulty_if_recalled = float(_next_difficulty(arr(card.difficulty), arr(assumed_rating), parameters)[0])
    difficulty_if_lapsed = float(_next_difficulty(arr(card.difficulty), arr(1), parameters)[0])
    expected_difficulty = r * difficulty_if_recalled + (1 - r) * difficulty_if_lapsed

    return CardState(
        card_id=card.card_id,
        concept=card.concept,
        stability=float(np.clip(expected_stability, MIN_STABILITY, MAX_STABILITY)),
        difficulty=expected_difficulty,
        last_review_day=day,
    )
