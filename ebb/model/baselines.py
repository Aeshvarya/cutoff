"""Baselines that Ebb has to beat.

These are the comparison set from Settles & Meeder (2016) section 4.1. If our
trained model cannot beat a 1960s index-card heuristic on real learner data,
the model is not the moat and we should know that on night one.

Every baseline exposes the same interface as HalfLifeRegression:
    predict_recall(features, t) -> (probability, half_life)
so the evaluation harness never special-cases anything.
"""

from __future__ import annotations

import math

from ebb.model.features import MAX_HALF_LIFE, MAX_P, MIN_HALF_LIFE, MIN_P, clamp


def _feature(features, name: str, default: float = 0.0) -> float:
    for key, value in features:
        if key == name:
            return value
    return default


def _counts(features) -> tuple[int, int]:
    """Recover (right, wrong) from the sqrt(1+n) encoding."""
    right = round(_feature(features, "right", 1.0) ** 2 - 1)
    wrong = round(_feature(features, "wrong", 1.0) ** 2 - 1)
    return right, wrong


class _Scheduler:
    def half_life(self, features) -> float:
        raise NotImplementedError

    def predict_recall(self, features, t: float) -> tuple[float, float]:
        h = clamp(self.half_life(features), MIN_HALF_LIFE, MAX_HALF_LIFE)
        return clamp(2.0 ** (-t / h), MIN_P, MAX_P), h


class Leitner(_Scheduler):
    """The physical index-card box, 1972. Get it right, the card moves one box
    further and the interval doubles. Get it wrong, it moves back."""

    def half_life(self, features) -> float:
        right, wrong = _counts(features)
        return 2.0 ** clamp(float(right - wrong), -20.0, 20.0)


class Pimsleur(_Scheduler):
    """Pimsleur's graduated-interval recall, 1967 -- a fixed schedule, identical
    for every learner and every item.

    Pimsleur published eleven intervals. We fit log2(interval) linearly in the
    repetition number here rather than quoting constants from memory, so the
    numbers in this file are derived and checkable.
    """

    # Pimsleur (1967), in seconds: 5s, 25s, 2m, 10m, 1h, 5h, 1d, 5d, 25d, 4mo, 2y
    PUBLISHED_SECONDS = [5, 25, 120, 600, 3600, 18000, 86400, 432000,
                         2160000, 10512000, 63072000]

    def __init__(self) -> None:
        days = [s / 86400.0 for s in self.PUBLISHED_SECONDS]
        n = list(range(1, len(days) + 1))
        y = [math.log2(d) for d in days]
        n_bar = sum(n) / len(n)
        y_bar = sum(y) / len(y)
        num = sum((a - n_bar) * (b - y_bar) for a, b in zip(n, y))
        den = sum((a - n_bar) ** 2 for a in n)
        self.slope = num / den
        self.intercept = y_bar - self.slope * n_bar

    def half_life(self, features) -> float:
        right, wrong = _counts(features)
        # Learners in this dataset review some items thousands of times, and
        # Pimsleur's schedule is exponential, so clamp before exponentiating.
        exponent = self.slope * (right + wrong) + self.intercept
        return 2.0 ** clamp(exponent, -20.0, 20.0)


class ConstantHalfLife(_Scheduler):
    """Everything decays at the same rate. The floor: any model that cannot
    beat this has learned nothing about individual items or learners."""

    def __init__(self, half_life_days: float = 1.0) -> None:
        self.half_life_days = half_life_days

    def fit(self, instances) -> "ConstantHalfLife":
        values = [inst.h for inst in instances]
        values.sort()
        self.half_life_days = values[len(values) // 2]   # median, robust to the clamps
        return self

    def half_life(self, features) -> float:
        return self.half_life_days


class LogisticRecall(_Scheduler):
    """Predict recall probability directly with logistic regression on the same
    features plus time, then invert to a half-life.

    This is the honest "just throw ML at it" comparison. It is the baseline that
    matters: it has the same information HLR has. If HLR wins, the win comes
    from the half-life term in the objective, not from having better features.
    """

    def __init__(self, learning_rate: float = 0.01) -> None:
        self.learning_rate = learning_rate
        self.weights: dict[str, float] = {}
        self._counts: dict[str, int] = {}

    def _with_time(self, features, t: float):
        return tuple(features) + (("sqrt_t", math.sqrt(t)),)

    def _probability(self, features) -> float:
        z = sum(self.weights.get(k, 0.0) * v for k, v in features)
        z = clamp(z, -30.0, 30.0)
        return 1.0 / (1.0 + math.exp(-z))

    def fit(self, instances, epochs: int = 1) -> "LogisticRecall":
        for _ in range(epochs):
            for inst in instances:
                feats = self._with_time(inst.features, inst.t)
                error = self._probability(feats) - inst.p
                for name, value in feats:
                    self._counts[name] = self._counts.get(name, 0) + 1
                    rate = self.learning_rate / math.sqrt(1 + self._counts[name])
                    self.weights[name] = self.weights.get(name, 0.0) - rate * error * value
        return self

    def predict_recall(self, features, t: float) -> tuple[float, float]:
        p = clamp(self._probability(self._with_time(features, t)), MIN_P, MAX_P)
        h = clamp(-t / math.log2(p), MIN_HALF_LIFE, MAX_HALF_LIFE)
        return p, h
