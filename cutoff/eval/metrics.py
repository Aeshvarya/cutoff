"""Scoring a recall model.

Three numbers, because they fail in different ways:

  MAE(p)      how far off the recall probability is. The headline.
  AUC         can it rank a remembered item above a forgotten one? A model can
              have low MAE by predicting the mean forever; AUC catches that.
  Spearman(h) does the predicted half-life track the observed one? This is the
              number that decides whether SCHEDULING works, which is what Cutoff
              actually sells.
"""

from __future__ import annotations


def mean_absolute_error(predicted: list[float], actual: list[float]) -> float:
    return sum(abs(a - b) for a, b in zip(predicted, actual)) / len(predicted)


def auc(scores: list[float], labels: list[int]) -> float:
    """Rank-based AUC (Mann-Whitney U), with ties credited half."""
    pairs = sorted(zip(scores, labels))
    positives = sum(labels)
    negatives = len(labels) - positives
    if positives == 0 or negatives == 0:
        return float("nan")

    rank_sum = 0.0
    i = 0
    while i < len(pairs):
        j = i
        while j < len(pairs) and pairs[j][0] == pairs[i][0]:
            j += 1
        average_rank = (i + j + 1) / 2.0        # 1-indexed average rank of the tie group
        rank_sum += sum(average_rank for k in range(i, j) if pairs[k][1] == 1)
        i = j

    return (rank_sum - positives * (positives + 1) / 2.0) / (positives * negatives)


def _ranks(values: list[float]) -> list[float]:
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j < len(order) and values[order[j]] == values[order[i]]:
            j += 1
        average = (i + j + 1) / 2.0
        for k in range(i, j):
            ranks[order[k]] = average
        i = j
    return ranks


def spearman(a: list[float], b: list[float]) -> float:
    ra, rb = _ranks(a), _ranks(b)
    n = len(ra)
    mean_a, mean_b = sum(ra) / n, sum(rb) / n
    cov = sum((x - mean_a) * (y - mean_b) for x, y in zip(ra, rb))
    var_a = sum((x - mean_a) ** 2 for x in ra) ** 0.5
    var_b = sum((y - mean_b) ** 2 for y in rb) ** 0.5
    return cov / (var_a * var_b) if var_a and var_b else float("nan")


def evaluate(model, instances) -> dict[str, float]:
    p_pred, p_true, h_pred, h_true, labels = [], [], [], [], []
    for inst in instances:
        p, h = model.predict_recall(inst.features, inst.t)
        p_pred.append(p)
        p_true.append(inst.p)
        h_pred.append(h)
        h_true.append(inst.h)
        labels.append(1 if inst.p >= 0.5 else 0)

    return {
        "n": len(p_pred),
        "mae_p": mean_absolute_error(p_pred, p_true),
        "auc": auc(p_pred, labels),
        "spearman_h": spearman(h_pred, h_true),
    }
