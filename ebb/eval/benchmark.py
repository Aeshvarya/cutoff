"""Scoring against the community SRS benchmark.

The benchmark (open-spaced-repetition/srs-benchmark) reports three numbers, and
we report the same three so our results can be read next to theirs:

    log loss     unambiguous. Directly comparable.
    AUC          unambiguous. Directly comparable.
    RMSE(bins)   depends on how you bin. The benchmark groups by interval
                 length, review count and lapse count; we do the same in spirit
                 but our bin edges are our own, so treat this one as indicative
                 rather than strictly comparable. Said out loud because a number
                 that looks comparable but isn't is worse than no number.

Published reference numbers, ~350M reviews, same-day reviews excluded:

    RWKV-P    log loss 0.2773   RMSE(bins) 0.02502   AUC 0.8329
    FSRS-6    log loss 0.3460   RMSE(bins) 0.0653    AUC 0.7034
    HLR       log loss 0.4694   RMSE(bins) 0.1275    AUC 0.6369
    AVG       log loss 0.3945   RMSE(bins) 0.1034    AUC 0.4997
"""

from __future__ import annotations

import numpy as np

PUBLISHED = {
    "RWKV-P (benchmark best)": {"log_loss": 0.2773, "rmse_bins": 0.02502, "auc": 0.8329},
    "FSRS-6 (ships in Anki)": {"log_loss": 0.3460, "rmse_bins": 0.0653, "auc": 0.7034},
    "HLR (Settles & Meeder 2016)": {"log_loss": 0.4694, "rmse_bins": 0.1275, "auc": 0.6369},
    "AVG (predict the mean)": {"log_loss": 0.3945, "rmse_bins": 0.1034, "auc": 0.4997},
}


def log_loss(p: np.ndarray, y: np.ndarray) -> float:
    p = np.clip(p, 1e-7, 1 - 1e-7)
    return float(np.mean(-(y * np.log(p) + (1 - y) * np.log(1 - p))))


def auc(p: np.ndarray, y: np.ndarray) -> float:
    """Mann-Whitney U, ties credited half."""
    order = np.argsort(p, kind="mergesort")
    scores, labels = p[order], y[order]

    ranks = np.empty(len(scores), dtype=np.float64)
    i = 0
    while i < len(scores):
        j = i
        while j < len(scores) and scores[j] == scores[i]:
            j += 1
        ranks[i:j] = (i + j + 1) / 2.0
        i = j

    positives = labels.sum()
    negatives = len(labels) - positives
    if positives == 0 or negatives == 0:
        return float("nan")
    return float((ranks[labels == 1].sum() - positives * (positives + 1) / 2.0) / (positives * negatives))


def rmse_bins(p: np.ndarray, y: np.ndarray, intervals: np.ndarray,
              review_counts: np.ndarray, lapse_counts: np.ndarray) -> float:
    """Calibration error, weighted by bin size.

    Log loss punishes confident mistakes; this asks a different question -- when
    Ebb says "85%", does 85% of that group actually recall? That is the property
    a forecast has to have, so it is the number that matters most for us.
    """
    def bucket(values, edges):
        return np.digitize(values, edges)

    keys = (
        bucket(intervals, [1, 2, 4, 8, 16, 32, 64, 128, 256, 512]),
        bucket(review_counts, [1, 2, 3, 4, 6, 9, 14, 21, 32]),
        bucket(lapse_counts, [1, 2, 3, 5, 8]),
    )
    combined = keys[0] * 100 + keys[1] * 10 + keys[2]

    total_weight = 0.0
    accumulated = 0.0
    for key in np.unique(combined):
        selection = combined == key
        n = int(selection.sum())
        if n < 1:
            continue
        gap = p[selection].mean() - y[selection].mean()
        accumulated += n * gap * gap
        total_weight += n

    return float(np.sqrt(accumulated / total_weight)) if total_weight else float("nan")


def flatten(sequences, predictions, use_score_mask: bool = True):
    """Collapse padded sequences into flat arrays of scored reviews only,
    carrying the per-review context that rmse_bins needs."""
    weights = sequences.mask.copy()
    weights[:, 0] = 0.0
    score_mask = getattr(sequences, "score_mask", None)
    if use_score_mask and score_mask is not None:
        weights = weights * score_mask
    selection = weights > 0

    review_index = np.tile(np.arange(sequences.ratings.shape[1]), (sequences.ratings.shape[0], 1))
    lapses = np.cumsum((sequences.ratings == 1) & (sequences.mask > 0), axis=1) - (
        (sequences.ratings == 1) & (sequences.mask > 0)
    )

    return (
        predictions[selection],
        sequences.labels[selection],
        sequences.gaps[selection],
        review_index[selection],
        lapses[selection],
    )


def score(sequences, predictions) -> dict[str, float]:
    p, y, intervals, counts, lapses = flatten(sequences, predictions)
    return {
        "n": int(len(p)),
        "log_loss": log_loss(p, y),
        "rmse_bins": rmse_bins(p, y, intervals, counts, lapses),
        "auc": auc(p, y),
    }
