"""Two exams, one set of nights, and no schedule that wins both.

Every published scheduler we could find optimises either unbounded retention
(Reddy et al., KDD 2016 -- explicitly "unbounded"), retention today (FSRS), or
the minimum cost to remember something permanently (SSP-MMC, KDD 2022, which
assumes a card is learned forever once its stability passes a threshold). None
of them takes two calendar dates and a nightly limit.

A student does. Mid-sems land in September and end-sems in November, the nights
in between are finite, and revising for one costs you the other. So the honest
output is not a single plan -- it is the FRONTIER: every schedule that is not
beaten at both exams simultaneously. You pick where on it you want to stand.

The weight lambda runs from 0 (care only about the later exam) to 1 (care only
about the earlier one). Each value yields one plan and one point on the curve.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from cutoff.core.forecast import CardState, review_outcome
from cutoff.model.dsr import _next_difficulty, _next_stability, retrievability


@dataclass
class FrontierPoint:
    weight: float
    recall_first: float
    recall_second: float
    reviews_before_first: int
    reviews_after_first: int

    @property
    def average(self) -> float:
        return (self.recall_first + self.recall_second) / 2.0


def plan_two_exams(
    cards: list[CardState],
    first_exam: int,
    second_exam: int,
    parameters: np.ndarray,
    weight: float,
    budget: int,
    max_reviews_per_day: int = 40,
) -> FrontierPoint:
    """Greedily spend `budget` reviews to maximise a weighted blend of the two
    exam-day retentions.

    Two parallel sets of card states are carried: one that has seen only the
    reviews falling on or before the first exam, and one that has seen all of
    them. That is what stops a November revision from flattering a September
    result -- the bug this module exists to make impossible.

    Scored as a matrix over every card against every remaining day, because the
    scalar version took minutes per weight and the frontier needs eight of them.
    """
    if not 0.0 <= weight <= 1.0:
        raise ValueError("weight must be between 0 and 1")
    if not cards:
        raise ValueError("nothing to plan")

    decay = parameters[15]
    days = np.arange(0, second_exam, dtype=np.float64)
    grid = days[None, :]

    # Two parallel worlds: what you know at the first exam, and at the second.
    early_s = np.array([c.stability for c in cards], dtype=np.float64)
    early_d = np.array([c.difficulty for c in cards], dtype=np.float64)
    early_t = np.array([c.last_review_day for c in cards], dtype=np.float64)
    late_s, late_d, late_t = early_s.copy(), early_d.copy(), early_t.copy()

    remaining = np.full(len(days), float(max_reviews_per_day))
    before = after = 0

    def expected(stab, diff, r):
        good = np.full_like(r, 3.0)
        ok = _next_stability(stab, diff, r, good, parameters)
        bad = _next_stability(stab, diff, r, np.ones_like(r), parameters)
        return r * ok + (1.0 - r) * bad

    for _ in range(budget):
        # Gain at the second exam, from a review on any day.
        elapsed_late = np.maximum(grid - late_t[:, None], 0.0)
        r_late = retrievability(elapsed_late, late_s[:, None], decay)
        s_late_new = expected(late_s[:, None], late_d[:, None], r_late)
        after_late = retrievability(np.maximum(second_exam - grid, 0.0), s_late_new, decay)
        now_late = retrievability(np.maximum(second_exam - late_t, 0.0), late_s, decay)[:, None]
        gain_late = after_late - now_late

        # Gain at the first exam -- only reviews that happen before it count.
        elapsed_early = np.maximum(grid - early_t[:, None], 0.0)
        r_early = retrievability(elapsed_early, early_s[:, None], decay)
        s_early_new = expected(early_s[:, None], early_d[:, None], r_early)
        after_early = retrievability(np.maximum(first_exam - grid, 0.0), s_early_new, decay)
        now_early = retrievability(np.maximum(first_exam - early_t, 0.0), early_s, decay)[:, None]
        gain_early = np.where(grid <= first_exam, after_early - now_early, 0.0)

        score = weight * gain_early + (1.0 - weight) * gain_late
        score = np.where(grid < late_t[:, None], -np.inf, score)
        score = np.where(remaining[None, :] <= 0, -np.inf, score)

        flat = int(np.argmax(score))
        if not np.isfinite(score.flat[flat]) or score.flat[flat] <= 1e-12:
            break
        ci, di = divmod(flat, len(days))
        day = days[di]

        late_s[ci] = s_late_new[ci, di]
        late_d[ci] = _next_difficulty(late_d[ci : ci + 1], np.array([3.0]), parameters)[0]
        late_t[ci] = day
        if day <= first_exam:
            early_s[ci] = s_early_new[ci, di]
            early_d[ci] = _next_difficulty(early_d[ci : ci + 1], np.array([3.0]), parameters)[0]
            early_t[ci] = day
            before += 1
        else:
            after += 1
        remaining[di] -= 1

    return FrontierPoint(
        weight=weight,
        recall_first=float(retrievability(np.maximum(first_exam - early_t, 0.0), early_s, decay).mean()),
        recall_second=float(retrievability(np.maximum(second_exam - late_t, 0.0), late_s, decay).mean()),
        reviews_before_first=before,
        reviews_after_first=after,
    )


def frontier(
    cards: list[CardState],
    first_exam: int,
    second_exam: int,
    parameters: np.ndarray,
    budget: int,
    weights: list[float] | None = None,
    max_reviews_per_day: int = 40,
) -> list[FrontierPoint]:
    weights = weights if weights is not None else [0.0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1.0]
    return [
        plan_two_exams(cards, first_exam, second_exam, parameters, w, budget, max_reviews_per_day)
        for w in weights
    ]


def dominated(points: list[FrontierPoint]) -> list[bool]:
    """A point is dominated if another is at least as good at BOTH exams and
    strictly better at one. Those are the schedules nobody should ever pick."""
    flags = []
    for a in points:
        flags.append(any(
            b is not a
            and b.recall_first >= a.recall_first - 1e-9
            and b.recall_second >= a.recall_second - 1e-9
            and (b.recall_first > a.recall_first + 1e-9 or b.recall_second > a.recall_second + 1e-9)
            for b in points
        ))
    return flags
