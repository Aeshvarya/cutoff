"""Feature extraction for Half-Life Regression.

Follows Settles & Meeder (ACL 2016), "A Trainable Spaced Repetition Model for
Language Learning". Each training instance is one review of one item by one
learner. The model learns a weight vector theta such that the item's memory
half-life is h = 2 ** (theta . x).

Features, exactly as in the paper:
    right   sqrt(1 + times they recalled this item before)
    wrong   sqrt(1 + times they failed this item before)
    item    a per-item indicator, so the model can learn "this one is hard"
    bias    intercept
"""

from __future__ import annotations

import math
from dataclasses import dataclass

# Half-lives outside this range are physically meaningless for study planning.
# 15 minutes to 9 months, in days -- the paper's own clamps.
MIN_HALF_LIFE = 15.0 / (24 * 60)
MAX_HALF_LIFE = 274.0

# A recall probability of exactly 0 or 1 makes the observed half-life infinite,
# so pull them just inside the open interval.
MIN_P = 0.0001
MAX_P = 0.9999

SECONDS_PER_DAY = 60 * 60 * 24


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


@dataclass(frozen=True)
class Instance:
    """One review, ready for training."""

    p: float                    # observed recall rate in that session
    t: float                    # days since the item was last seen
    h: float                    # observed half-life implied by (p, t)
    features: tuple[tuple[str, float], ...]
    item_id: str
    user_id: str


def observed_half_life(p: float, t: float) -> float:
    """Invert p = 2 ** (-t / h) to get the half-life the learner just revealed.

    If you recalled it with probability p after t days, then the half-life that
    would have predicted exactly that is -t / log2(p).
    """
    return clamp(-t / math.log(p, 2), MIN_HALF_LIFE, MAX_HALF_LIFE)


def build_features(
    history_correct: int,
    history_wrong: int,
    item_id: str,
    prior_interval_days: float | None = None,
) -> tuple[tuple[str, float], ...]:
    """The paper's feature set, plus one optional extra.

    `prior_interval_days` is the total spacing the item has already survived. The
    paper does not use it, but under an adaptive scheduler it is the only thing
    in reach that stands in for how STABLE the memory is -- and without some
    such proxy a model cannot tell "long gap because it is easy" apart from
    "long gap because it was neglected". Passing it lets us measure exactly how
    much of the gap between HLR and a DSR model is explained by that one idea.
    """
    features = [
        ("right", math.sqrt(1 + history_correct)),
        ("wrong", math.sqrt(1 + history_wrong)),
        (f"item:{item_id}", 1.0),
        ("bias", 1.0),
    ]
    if prior_interval_days is not None:
        features.append(("prior_interval", math.sqrt(1.0 + max(prior_interval_days, 0.0))))
    return tuple(features)


def instance_from_row(row: dict[str, str]) -> Instance | None:
    """Turn one raw Duolingo trace row into a training instance, or None if unusable."""
    try:
        p = clamp(float(row["p_recall"]), MIN_P, MAX_P)
        t = float(row["delta"]) / SECONDS_PER_DAY
    except (KeyError, ValueError):
        return None

    if t <= 0:
        # Same-session repeats carry no spacing signal.
        return None

    seen = int(row["history_seen"])
    correct = int(row["history_correct"])
    wrong = seen - correct
    item_id = row["lexeme_id"]

    return Instance(
        p=p,
        t=t,
        h=observed_half_life(p, t),
        features=build_features(correct, wrong, item_id),
        item_id=item_id,
        user_id=row["user_id"],
    )
