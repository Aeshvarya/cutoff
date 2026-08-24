"""Half-Life Regression.

The model: an item's memory half-life is h = 2 ** (theta . x), and the chance
you still recall it t days later is p = 2 ** (-t / h).

Training minimises, per the paper:

    loss = (p_hat - p)^2  +  alpha * (h_hat - h)^2  +  lambda * ||theta||^2

The second term is what makes this work. Fitting recall probability alone is
under-determined -- many half-lives explain one observation. Fitting the
half-life the learner just revealed pins it down.

Settles & Meeder (2016), ACL, pp. 1848-1858. DOI 10.18653/v1/P16-1174
"""

from __future__ import annotations

import json
import math
from collections import defaultdict
from pathlib import Path

from ebb.model.features import (
    MAX_HALF_LIFE,
    MIN_HALF_LIFE,
    MAX_P,
    MIN_P,
    Instance,
    clamp,
)

LN2 = math.log(2.0)


class HalfLifeRegression:
    """Sparse SGD trainer. Weights live in a dict because the item indicators
    are high-cardinality and almost entirely zero."""

    def __init__(
        self,
        learning_rate: float = 0.001,
        half_life_weight: float = 0.01,   # alpha
        l2_weight: float = 0.1,           # lambda
    ) -> None:
        self.learning_rate = learning_rate
        self.half_life_weight = half_life_weight
        self.l2_weight = l2_weight
        self.weights: dict[str, float] = defaultdict(float)
        self._feature_counts: dict[str, int] = defaultdict(int)
        self._seen = 0

    # ---- prediction -------------------------------------------------------

    def predict_half_life(self, features) -> float:
        dot = sum(self.weights[name] * value for name, value in features)
        return clamp(2.0 ** dot, MIN_HALF_LIFE, MAX_HALF_LIFE)

    def predict_recall(self, features, t: float) -> tuple[float, float]:
        """Return (probability of recall after t days, predicted half-life)."""
        h = self.predict_half_life(features)
        p = clamp(2.0 ** (-t / h), MIN_P, MAX_P)
        return p, h

    # ---- training ---------------------------------------------------------

    def _step(self, inst: Instance) -> None:
        p_hat, h_hat = self.predict_recall(inst.features, inst.t)

        # d/dtheta of (p_hat - p)^2, using dp/dtheta = p * ln2^2 * (t/h)
        d_loss_p = 2.0 * (p_hat - inst.p) * (LN2 ** 2) * p_hat * (inst.t / h_hat)
        # d/dtheta of (h_hat - h)^2, using dh/dtheta = h * ln2
        d_loss_h = 2.0 * (h_hat - inst.h) * LN2 * h_hat

        self._seen += 1
        for name, value in inst.features:
            self._feature_counts[name] += 1
            # AdaGrad-style per-feature rate: features we have seen a lot move
            # in smaller steps, so a rare item indicator can still learn.
            rate = (1.0 / (1.0 + inst.p)) * self.learning_rate / math.sqrt(
                1 + self._feature_counts[name]
            )
            self.weights[name] -= rate * d_loss_p * value
            self.weights[name] -= rate * self.half_life_weight * d_loss_h * value
            self.weights[name] -= rate * self.l2_weight * self.weights[name] / self._seen

    def fit(self, instances, epochs: int = 1, log_every: int = 250_000) -> "HalfLifeRegression":
        for epoch in range(epochs):
            for i, inst in enumerate(instances, start=1):
                self._step(inst)
                if log_every and i % log_every == 0:
                    print(f"  epoch {epoch + 1}  {i:,} instances  |theta| = {len(self.weights):,}")
        return self

    # ---- persistence ------------------------------------------------------

    def save(self, path: str | Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "hyperparameters": {
                        "learning_rate": self.learning_rate,
                        "half_life_weight": self.half_life_weight,
                        "l2_weight": self.l2_weight,
                    },
                    "instances_seen": self._seen,
                    "weights": dict(self.weights),
                },
                indent=1,
            )
        )

    @classmethod
    def load(cls, path: str | Path) -> "HalfLifeRegression":
        blob = json.loads(Path(path).read_text())
        model = cls(**blob["hyperparameters"])
        model.weights = defaultdict(float, blob["weights"])
        model._seen = blob["instances_seen"]
        return model
