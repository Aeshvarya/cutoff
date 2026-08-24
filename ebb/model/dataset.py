"""Loading the Duolingo learning traces.

Source: Settles & Meeder (2016), Harvard Dataverse doi:10.7910/DVN/N8XJME,
12,854,226 rows, MIT licensed.

We split by LEARNER, not by row. A row-level split would put the same person's
earlier and later reviews on both sides of the wall, and the model would be
graded on people it had already met. Splitting by user means every evaluation
number is measured on learners the model has never seen.
"""

from __future__ import annotations

import csv
import gzip
import hashlib
from pathlib import Path
from typing import Iterator

from ebb.model.features import Instance, instance_from_row

DEFAULT_PATH = Path(__file__).resolve().parents[2] / "data" / "raw" / "learning_traces.13m.csv.gz"


def _user_bucket(user_id: str, buckets: int = 100) -> int:
    """Stable hash so the split is identical on every machine and every run."""
    digest = hashlib.md5(user_id.encode()).hexdigest()
    return int(digest, 16) % buckets


def stream(
    path: Path = DEFAULT_PATH,
    limit: int | None = None,
    holdout_buckets: int = 10,
    split: str = "train",
) -> Iterator[Instance]:
    """Yield instances from one side of the learner-level split.

    holdout_buckets=10 means 10% of learners are reserved for evaluation.
    """
    if split not in {"train", "test"}:
        raise ValueError("split must be 'train' or 'test'")

    kept = 0
    with gzip.open(path, "rt", newline="") as handle:
        for row in csv.DictReader(handle):
            in_holdout = _user_bucket(row["user_id"]) < holdout_buckets
            if in_holdout != (split == "test"):
                continue

            instance = instance_from_row(row)
            if instance is None:
                continue

            yield instance
            kept += 1
            if limit is not None and kept >= limit:
                return
