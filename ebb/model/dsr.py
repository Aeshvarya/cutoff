"""Ebb's memory model: Difficulty, Stability, Retrievability.

Half-life regression treats memory as one number that grows with practice. That
is not enough, and the community benchmark shows it: HLR scores a log loss of
0.4694 on Anki data, which is *worse* than predicting the average (0.3945).

The DSR family fixes this by giving every card three quantities:

    Difficulty      how hard this card is for this person       (1..10)
    Stability       the interval at which recall drops to 90%   (days)
    Retrievability  the chance you recall it right now          (0..1)

and the forgetting curve is a power law rather than an exponential:

    R(t, S) = (1 + F * t/S) ** (-decay),   F = 0.9 ** (-1/decay) - 1

F is derived, not fitted, so that R(S, S) == 0.9 exactly. That makes stability
mean something concrete instead of being an arbitrary scale, which matters
because Ebb reports stability to users.

After each review, difficulty drifts toward or away from easy depending on the
grade, and stability jumps by an amount that shrinks as the card gets stronger
(you gain less from reviewing something you already know cold) and grows as
retrievability falls (reviewing right before you forget is worth the most).
That second effect is the spacing effect, and it is why scheduling works at all.

Structure follows the FSRS family (open-spaced-repetition). Implemented here
from the published formulation and fitted by L-BFGS on our own data.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

MIN_STABILITY = 0.01
MAX_STABILITY = 36500.0
MIN_DIFFICULTY = 1.0
MAX_DIFFICULTY = 10.0

# Sensible starting point, in the units each parameter lives in.
INITIAL_PARAMETERS = np.array(
    [
        0.40, 1.18, 3.17, 15.69,   # 0-3  initial stability per rating 1..4 (days)
        7.19, 0.46,                # 4-5  initial difficulty: intercept, rating exponent
        0.24,                      # 6    difficulty step size
        0.06,                      # 7    mean reversion toward easy
        -1.10,                     # 8    log of the stability growth scale
        0.55,                      # 9    stability saturation exponent
        1.50,                      # 10   retrievability gain exponent
        0.20,                      # 11   lapse: scale
        0.30,                      # 12   lapse: difficulty exponent
        1.30,                      # 13   lapse: stability exponent
        0.30,                      # 14   lapse: retrievability exponent
        0.50,                      # 15   forgetting curve decay
    ]
)

BOUNDS = [
    (0.05, 100.0), (0.05, 100.0), (0.05, 100.0), (0.05, 100.0),
    (1.0, 12.0), (0.01, 4.0),
    (0.01, 4.0),
    (0.0, 0.9),
    (-6.0, 3.0),
    (0.0, 1.0),
    (0.0, 6.0),
    (0.001, 2.0), (0.0, 2.0), (0.0, 3.0), (0.0, 3.0),
    (0.1, 0.9),
]


def retrievability(elapsed_days, stability, decay):
    """Chance of recall after `elapsed_days`, given the card's stability."""
    factor = 0.9 ** (-1.0 / decay) - 1.0
    return (1.0 + factor * elapsed_days / stability) ** (-decay)


def _initial_state(rating, w):
    stability = np.take(w[0:4], rating - 1)
    difficulty = w[4] - np.exp(w[5] * (rating - 1)) + 1.0
    return (
        np.clip(stability, MIN_STABILITY, MAX_STABILITY),
        np.clip(difficulty, MIN_DIFFICULTY, MAX_DIFFICULTY),
    )


def _next_difficulty(difficulty, rating, w):
    delta = -w[6] * (rating - 3.0)
    stepped = difficulty + delta * (10.0 - difficulty) / 9.0
    easy_anchor = np.clip(w[4] - np.exp(w[5] * 3.0) + 1.0, MIN_DIFFICULTY, MAX_DIFFICULTY)
    reverted = w[7] * easy_anchor + (1.0 - w[7]) * stepped
    return np.clip(reverted, MIN_DIFFICULTY, MAX_DIFFICULTY)


def _next_stability(stability, difficulty, r, rating, w):
    """Stability after a review. Two regimes: you remembered, or you lapsed."""
    # Remembered. Gain shrinks with stability (saturation) and with difficulty,
    # and grows as retrievability falls (the spacing effect).
    growth = (
        np.exp(w[8])
        * (11.0 - difficulty)
        * np.power(stability, -w[9])
        * (np.exp(w[10] * (1.0 - r)) - 1.0)
    )
    on_success = stability * (1.0 + np.maximum(growth, 0.0))

    # Lapsed. Stability collapses toward a much smaller value.
    on_lapse = (
        w[11]
        * np.power(difficulty, -w[12])
        * (np.power(stability + 1.0, w[13]) - 1.0)
        * np.exp(w[14] * (1.0 - r))
    )

    recalled = rating > 1
    return np.clip(np.where(recalled, on_success, on_lapse), MIN_STABILITY, MAX_STABILITY)


def forward(sequences, w):
    """Predicted recall probability at every review position.

    Returns an array shaped like sequences.ratings. Position 0 seeds the state
    and is never predicted, so its entry is left at zero.
    """
    ratings = sequences.ratings
    gaps = sequences.gaps
    mask = sequences.mask
    n_cards, width = ratings.shape
    decay = w[15]

    predictions = np.zeros((n_cards, width), dtype=np.float64)
    stability, difficulty = _initial_state(np.maximum(ratings[:, 0], 1), w)

    for k in range(1, width):
        live = mask[:, k] > 0
        if not live.any():
            break

        r = retrievability(gaps[:, k], stability, decay)
        predictions[:, k] = np.where(live, r, 0.0)

        rating_k = np.maximum(ratings[:, k], 1)
        new_stability = _next_stability(stability, difficulty, r, rating_k, w)
        new_difficulty = _next_difficulty(difficulty, rating_k, w)

        # Cards whose history has ended keep their state frozen.
        stability = np.where(live, new_stability, stability)
        difficulty = np.where(live, new_difficulty, difficulty)

    return predictions


def log_loss(sequences, w, score_mask=None) -> float:
    predictions = forward(sequences, w)
    weights = sequences.mask.copy()
    weights[:, 0] = 0.0
    if score_mask is not None:
        weights = weights * score_mask

    total = weights.sum()
    if total == 0:
        return float("nan")

    p = np.clip(predictions, 1e-7, 1 - 1e-7)
    y = sequences.labels
    losses = -(y * np.log(p) + (1 - y) * np.log(1 - p))
    return float((losses * weights).sum() / total)


class DSRModel:
    def __init__(self, parameters: np.ndarray | None = None) -> None:
        self.parameters = np.array(INITIAL_PARAMETERS if parameters is None else parameters, dtype=np.float64)

    def fit(self, sequences, max_iterations: int = 120, verbose: bool = True) -> "DSRModel":
        from scipy.optimize import minimize

        calls = {"n": 0}

        def objective(w):
            calls["n"] += 1
            value = log_loss(sequences, w)
            return 1e6 if not np.isfinite(value) else value

        start = log_loss(sequences, self.parameters)
        if verbose:
            print(f"  log loss at initial parameters: {start:.4f}")

        result = minimize(
            objective,
            self.parameters,
            method="L-BFGS-B",
            bounds=BOUNDS,
            options={"maxiter": max_iterations, "eps": 1e-6},
        )
        self.parameters = result.x
        if verbose:
            print(f"  log loss after fitting:         {result.fun:.4f}  ({calls['n']} evaluations)")
        return self

    def predict(self, sequences) -> np.ndarray:
        return forward(sequences, self.parameters)

    def save(self, path: str | Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"parameters": self.parameters.tolist()}, indent=1))

    @classmethod
    def load(cls, path: str | Path) -> "DSRModel":
        return cls(np.array(json.loads(Path(path).read_text())["parameters"]))
