"""Loading real Anki review logs.

Source: open-spaced-repetition/fsrs-dataset on Hugging Face -- the corpus behind
the community SRS benchmark. Each file is one anonymised user's collection.

Why this data and not Duolingo's: Anki users genuinely forget. Roughly 6% of
reviews are lapses, intervals run past a year, and the log records a hard binary
outcome instead of a within-session success rate.

Columns: review_time, card_id, i, delta_t, review_rating, y, t_history, r_history

We follow the benchmark's conventions:
  - same-day reviews (delta_t <= 0) are dropped; they measure short-term memory,
    not retention, and the benchmark's headline table excludes them
  - the split is chronological across the whole collection, matching the
    benchmark's TimeSeriesSplit: every review before a wall-clock cutoff trains,
    every review after it is scored. Splitting per-card instead would quietly
    select for maturity -- a card's last reviews are its easiest -- and inflate
    the held-out recall rate.
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from pathlib import Path

import numpy as np

DEFAULT_DIR = Path(__file__).resolve().parents[2] / "data" / "anki"


@dataclass
class Sequences:
    """Padded review histories, ready for a vectorised forward pass.

    ratings[c, k]  rating given at step k of card c   (1..4, 0 = padding)
    gaps[c, k]     days since the previous review of that card
    labels[c, k]   1 if recalled (rating > 1), else 0
    mask[c, k]     1 where a real, predictable review sits
    """

    ratings: np.ndarray
    gaps: np.ndarray
    labels: np.ndarray
    mask: np.ndarray

    @property
    def n_reviews(self) -> int:
        # Step 0 initialises state and is never predicted.
        return int(self.mask[:, 1:].sum())

    @property
    def n_cards(self) -> int:
        return int(self.ratings.shape[0])


def _read_collection(path: Path, max_len: int) -> tuple[list[list[tuple[float, int]]], list[list[int]]]:
    """Return per-card (gap_days, rating) sequences plus each review's timestamp."""
    by_card: dict[str, list[tuple[int, float, int]]] = {}
    with path.open(newline="") as handle:
        for row in csv.DictReader(handle, delimiter="\t"):
            try:
                gap = float(row["delta_t"])
                rating = int(row["review_rating"])
                order = int(row["review_time"])
            except (KeyError, ValueError):
                continue
            if rating not in (1, 2, 3, 4):
                continue
            by_card.setdefault(row["card_id"], []).append((order, gap, rating))

    sequences, timestamps = [], []
    for reviews in by_card.values():
        reviews.sort()
        # Keep the first review (it seeds the state) plus every later review that
        # actually spans a day boundary.
        kept = [(0.0, reviews[0][2])]
        times = [reviews[0][0]]
        for order, gap, rating in reviews[1:]:
            if gap > 0:
                kept.append((gap, rating))
                times.append(order)
        if len(kept) >= 2:
            sequences.append(kept[:max_len])
            timestamps.append(times[:max_len])
    return sequences, timestamps


def load(
    directory: Path = DEFAULT_DIR,
    max_collections: int | None = None,
    max_len: int = 64,
    test_fraction: float = 0.2,
) -> tuple[Sequences, Sequences]:
    """Load collections and split each card's history chronologically.

    The last `test_fraction` of every card's reviews is held out, so we are always
    predicting a learner's future from their past.
    """
    files = sorted(directory.glob("*.tsv"))
    if max_collections is not None:
        files = files[:max_collections]
    if not files:
        raise FileNotFoundError(f"no .tsv collections in {directory}")

    train_seqs, test_seqs = [], []
    for path in files:
        sequences, timestamps = _read_collection(path, max_len)
        if not sequences:
            continue

        # One wall-clock cutoff for the whole collection.
        every_time = sorted(t for times in timestamps for t in times)
        cutoff = every_time[int(len(every_time) * (1 - test_fraction))]

        for seq, times in zip(sequences, timestamps):
            n_before = sum(1 for t in times if t < cutoff)
            if n_before >= 2:
                train_seqs.append(seq[:n_before])
            if n_before < len(seq) and n_before >= 1:
                # Replay the card from its first review so the state is warm,
                # but score only what happened after the cutoff.
                test_seqs.append((seq, max(n_before, 1)))

    return _pack(train_seqs), _pack_test(test_seqs)


def _pack(sequences: list[list[tuple[float, int]]]) -> Sequences:
    if not sequences:
        raise ValueError("no sequences to pack")
    width = max(len(s) for s in sequences)
    n = len(sequences)
    gaps = np.zeros((n, width), dtype=np.float64)
    ratings = np.zeros((n, width), dtype=np.int64)
    mask = np.zeros((n, width), dtype=np.float64)

    for i, seq in enumerate(sequences):
        for k, (gap, rating) in enumerate(seq):
            gaps[i, k] = gap
            ratings[i, k] = rating
            mask[i, k] = 1.0

    return Sequences(ratings=ratings, gaps=gaps, labels=(ratings > 1).astype(np.float64), mask=mask)


def _pack_test(entries: list[tuple[list[tuple[float, int]], int]]) -> Sequences:
    """Pack full histories but mask out the training prefix, so state is warm
    and only the future is scored."""
    if not entries:
        raise ValueError("no test sequences")
    width = max(len(seq) for seq, _ in entries)
    n = len(entries)
    gaps = np.zeros((n, width), dtype=np.float64)
    ratings = np.zeros((n, width), dtype=np.int64)
    mask = np.zeros((n, width), dtype=np.float64)
    score = np.zeros((n, width), dtype=np.float64)

    for i, (seq, cut) in enumerate(entries):
        for k, (gap, rating) in enumerate(seq):
            gaps[i, k] = gap
            ratings[i, k] = rating
            mask[i, k] = 1.0
            if k >= cut:
                score[i, k] = 1.0

    packed = Sequences(ratings=ratings, gaps=gaps, labels=(ratings > 1).astype(np.float64), mask=mask)
    packed.score_mask = score          # type: ignore[attr-defined]
    return packed
