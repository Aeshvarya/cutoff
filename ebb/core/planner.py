"""The smallest amount of studying that gets you to a target on exam day.

Every other tool answers "what is due today". That question has no exam in it.
Ebb asks the inverse: you want to hold 90% of this syllabus on 20 November, and
you would like to spend as few minutes as possible getting there -- which cards,
on which days?

Method: greedy marginal gain. Repeatedly schedule the single review that buys the
most exam-day retention per minute spent, until the target is met or the budget
runs out.

One result worth stating plainly, because it surprised us and it shapes the
whole design: with no constraints, this planner schedules everything the night
before. That is not a bug. Under a retrievability model, massed practice
maximises performance on ONE fixed date -- spacing wins for long-term retention,
not for a single deadline. Anyone who claims "spacing beats cramming for your
exam" without qualification is overselling.

What makes the problem real is capacity. Nobody reviews eight hundred cards the
night before an exam. Once each day holds only as many reviews as you will
actually sit through, the cheapest way to reach a target on exam day stops being
a pile at the end and becomes a schedule -- and that schedule is what Ebb sells.

Two further honest caveats, stated here because they belong in the code and not
only in a slide:

  1. Greedy is not optimal. The principled version of this problem is stochastic
     optimal control -- Tabibian et al., PNAS 2019, "Enhancing human learning via
     spaced repetition optimization". Greedy is what fits in a hackathon and it
     is well behaved here because each review's benefit shrinks as the card gets
     stronger, so early picks stay good picks.
  2. The plan assumes you will grade yourself "good". Reviews are scored in
     expectation over recall and lapse (see forecast.review_outcome), so the
     schedule is an expected-case plan, not a worst-case guarantee.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from ebb.core.forecast import CardState, review_outcome
from ebb.model.dsr import _next_difficulty, _next_stability, retrievability


@dataclass
class ScheduledReview:
    day: int
    card_id: str
    concept: str
    recall_before: float
    recall_after: float

    @property
    def gain(self) -> float:
        return self.recall_after - self.recall_before


@dataclass
class StudyPlan:
    exam_day: int
    target_recall: float
    minutes_per_review: float
    reviews: list[ScheduledReview]
    recall_before: float
    recall_after: float
    target_met: bool

    @property
    def total_minutes(self) -> float:
        return len(self.reviews) * self.minutes_per_review

    def by_day(self) -> dict[int, list[ScheduledReview]]:
        sessions: dict[int, list[ScheduledReview]] = {}
        for review in self.reviews:
            sessions.setdefault(review.day, []).append(review)
        return dict(sorted(sessions.items()))

    def session_minutes(self) -> dict[int, float]:
        return {day: len(rs) * self.minutes_per_review for day, rs in self.by_day().items()}


def _candidate_days(exam_day: int, resolution: int) -> list[int]:
    """Days we are willing to schedule on.

    Reviewing on exam day itself is excluded -- you cannot revise during the
    paper, and a review that lands the same morning would let the planner cheat
    by driving retrievability to 1.0 for free.
    """
    if exam_day <= 1:
        return [0]
    days = list(range(0, exam_day, max(1, resolution)))
    return days or [0]


def plan(
    cards: list[CardState],
    exam_day: int,
    parameters: np.ndarray,
    target_recall: float = 0.90,
    minutes_per_review: float = 0.5,
    max_reviews: int = 2000,
    day_resolution: int = 1,
    max_reviews_per_day: int = 40,
) -> StudyPlan:
    """Build the minimum-time schedule to reach `target_recall` on `exam_day`.

    `max_reviews_per_day` is the honest constraint: how many cards you will
    genuinely sit through in one sitting. Without it the answer is always
    "cram", and the tool has nothing to say.

    The search is a matrix, not a loop. At every step we score EVERY card against
    EVERY remaining day at once and take the single best move, which is what
    makes a full-semester syllabus plannable in about a second.
    """
    if not cards:
        raise ValueError("nothing to plan")

    decay = parameters[15]
    days = np.array(_candidate_days(exam_day, day_resolution), dtype=np.float64)

    stability = np.array([c.stability for c in cards], dtype=np.float64)
    difficulty = np.array([c.difficulty for c in cards], dtype=np.float64)
    last_review = np.array([c.last_review_day for c in cards], dtype=np.float64)
    remaining = np.full(len(days), float(max_reviews_per_day))

    def exam_recall(stab, last):
        return retrievability(np.maximum(exam_day - last, 0.0), stab, decay)

    starting = float(exam_recall(stability, last_review).mean())
    current = starting
    scheduled: list[ScheduledReview] = []

    grid_days = days[None, :]                       # (1, D)
    while current < target_recall and len(scheduled) < max_reviews:
        elapsed = np.maximum(grid_days - last_review[:, None], 0.0)          # (C, D)
        r = retrievability(elapsed, stability[:, None], decay)

        # Expected state after reviewing card c on day d, graded "good".
        good = np.full_like(r, 3.0)
        stab_ok = _next_stability(stability[:, None], difficulty[:, None], r, good, parameters)
        stab_bad = _next_stability(stability[:, None], difficulty[:, None], r, np.ones_like(r), parameters)
        expected_stability = r * stab_ok + (1.0 - r) * stab_bad

        after = retrievability(np.maximum(exam_day - grid_days, 0.0), expected_stability, decay)
        before = exam_recall(stability, last_review)[:, None]
        gain = after - before

        # Illegal moves: before the card's last review, or on a day already full.
        gain = np.where(grid_days < last_review[:, None], -np.inf, gain)
        gain = np.where(remaining[None, :] <= 0, -np.inf, gain)
        gain = np.where(before >= target_recall, -np.inf, gain)

        flat = int(np.argmax(gain))
        best_gain = gain.flat[flat]
        if not np.isfinite(best_gain) or best_gain <= 1e-9:
            break

        card_index, day_index = divmod(flat, len(days))
        chosen_day = float(days[day_index])

        scheduled.append(
            ScheduledReview(
                day=int(chosen_day),
                card_id=cards[card_index].card_id,
                concept=cards[card_index].concept,
                recall_before=float(before[card_index, 0]),
                recall_after=float(after[card_index, day_index]),
            )
        )

        stability[card_index] = expected_stability[card_index, day_index]
        difficulty[card_index] = _next_difficulty(
            np.array([difficulty[card_index]]), np.array([3.0]), parameters
        )[0]
        last_review[card_index] = chosen_day
        remaining[day_index] -= 1
        current = float(exam_recall(stability, last_review).mean())

    scheduled.sort(key=lambda r: (r.day, r.concept, r.card_id))

    return StudyPlan(
        exam_day=exam_day,
        target_recall=target_recall,
        minutes_per_review=minutes_per_review,
        reviews=scheduled,
        recall_before=starting,
        recall_after=current,
        target_met=current >= target_recall,
    )


def compare_to_cramming(
    cards: list[CardState],
    exam_day: int,
    parameters: np.ndarray,
    n_reviews: int,
    max_reviews_per_day: int = 40,
    cram_day: int | None = None,
) -> dict[str, float]:
    """Spend the identical number of reviews the way a student actually does:
    as late as possible, weakest cards first, filling each night to capacity and
    spilling backwards only when a night is full.

    This is the control the headline claim has to beat. Same minutes, same cards,
    different placement.
    """
    last_day = exam_day - 1 if cram_day is None else cram_day
    states = {c.card_id: c for c in cards}

    order = sorted(states.values(), key=lambda c: c.recall_on(exam_day, parameters))
    day, used, days_used = last_day, 0, set()
    for card in order[:n_reviews]:
        if used >= max_reviews_per_day:
            day -= 1
            used = 0
        if day < 0:
            break
        states[card.card_id] = review_outcome(card, day, parameters)
        days_used.add(day)
        used += 1

    return {
        "reviews": float(n_reviews),
        "nights_needed": float(len(days_used)),
        "earliest_day": float(min(days_used)) if days_used else float("nan"),
        "recall": float(np.mean([c.recall_on(exam_day, parameters) for c in states.values()])),
    }
