"""Train Cutoff's model and score it against HLR and the trivial baseline.

    python scripts/benchmark.py --collections 20

Everything is scored on each learner's FUTURE reviews -- the last 20% of every
card's history, which the model never saw.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cutoff.eval.benchmark import PUBLISHED, flatten, score          # noqa: E402
from cutoff.model import anki                                        # noqa: E402
from cutoff.model.dsr import DSRModel                                # noqa: E402
from cutoff.model.features import MAX_P, MIN_P, Instance, build_features, clamp, observed_half_life  # noqa: E402
from cutoff.model.hlr import HalfLifeRegression                      # noqa: E402


def hlr_instances(sequences):
    """Recast padded sequences as HLR training instances.

    HLR sees exactly what our model sees: how many times you got this card right,
    how many times you got it wrong, and how long the gap was. No card identity --
    an Anki card is reviewed a handful of times by one person, so a per-card
    indicator would memorise rather than generalise.
    """
    ratings, gaps, mask = sequences.ratings, sequences.gaps, sequences.mask
    score_mask = getattr(sequences, "score_mask", None)
    for i in range(ratings.shape[0]):
        right = wrong = 0
        for k in range(ratings.shape[1]):
            if mask[i, k] == 0:
                break
            if k > 0 and (score_mask is None or score_mask[i, k] > 0):
                p = clamp(1.0 if ratings[i, k] > 1 else 0.0, MIN_P, MAX_P)
                t = max(float(gaps[i, k]), 1e-3)
                yield Instance(
                    p=p, t=t, h=observed_half_life(p, t),
                    features=build_features(right, wrong, "_"),
                    item_id="_", user_id=str(i),
                )
            if ratings[i, k] > 1:
                right += 1
            else:
                wrong += 1


def predict_with(model, sequences) -> np.ndarray:
    out = np.zeros_like(sequences.gaps)
    ratings, gaps, mask = sequences.ratings, sequences.gaps, sequences.mask
    for i in range(ratings.shape[0]):
        right = wrong = 0
        for k in range(ratings.shape[1]):
            if mask[i, k] == 0:
                break
            if k > 0:
                p, _ = model.predict_recall(build_features(right, wrong, "_"), max(float(gaps[i, k]), 1e-3))
                out[i, k] = p
            if ratings[i, k] > 1:
                right += 1
            else:
                wrong += 1
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--collections", type=int, default=20)
    parser.add_argument("--max-cards", type=int, default=120_000)
    parser.add_argument("--iterations", type=int, default=120)
    args = parser.parse_args()

    print(f"loading {args.collections} Anki collections...")
    started = time.time()
    train, test = anki.load(max_collections=args.collections)
    print(f"  {train.n_cards:,} cards / {train.n_reviews:,} training reviews")
    print(f"  {test.n_cards:,} cards / {int(getattr(test,'score_mask').sum()):,} held-out future reviews")
    print(f"  loaded in {time.time() - started:.1f}s")

    fit_set = train
    if train.n_cards > args.max_cards:
        rng = np.random.default_rng(0)
        keep = rng.choice(train.n_cards, args.max_cards, replace=False)
        fit_set = anki.Sequences(
            ratings=train.ratings[keep], gaps=train.gaps[keep],
            labels=train.labels[keep], mask=train.mask[keep],
        )
        print(f"  fitting on a {args.max_cards:,}-card subsample")

    print("\nfitting Cutoff's DSR model...")
    started = time.time()
    dsr = DSRModel().fit(fit_set, max_iterations=args.iterations)
    print(f"  fitted in {time.time() - started:.1f}s")

    print("training HLR for comparison...")
    hlr = HalfLifeRegression(warm_start_half_life=30.0).fit(list(hlr_instances(fit_set)), log_every=0)

    results = {}
    results["Cutoff (DSR, fitted)"] = score(test, dsr.predict(test))
    results["Cutoff (DSR, unfitted defaults)"] = score(test, DSRModel().predict(test))
    results["HLR (ACL 2016, ours)"] = score(test, predict_with(hlr, test))

    p, y, *_ = flatten(test, np.zeros_like(test.gaps))
    base_rate = float(flatten(train, np.zeros_like(train.gaps))[1].mean())
    results["AVG (predict the mean)"] = score(test, np.full_like(test.gaps, base_rate))

    print(f"\nscored on {results['Cutoff (DSR, fitted)']['n']:,} held-out future reviews")
    print(f"base recall rate in training data: {base_rate:.4f}\n")
    header = f"{'model':<30}{'log loss':>10}{'RMSE(bins)':>12}{'AUC':>8}"
    print(header); print("-" * len(header))
    for name, s in results.items():
        print(f"{name:<30}{s['log_loss']:>10.4f}{s['rmse_bins']:>12.4f}{s['auc']:>8.4f}")
    print()
    print("NOTE: the table below is measured on ~350M reviews from 9,999 collections.")
    print("Ours is measured on a small sample, so absolute values are NOT directly")
    print("comparable -- read it for the ordering, not the decimals.")
    print("\npublished, for reference (~350M reviews):")
    for name, s in PUBLISHED.items():
        print(f"{name:<30}{s['log_loss']:>10.4f}{s['rmse_bins']:>12.4f}{s['auc']:>8.4f}")

    dsr.save(ROOT / "artifacts" / "dsr.json")
    (ROOT / "artifacts" / "benchmark.json").write_text(json.dumps(
        {"collections": args.collections, "base_rate": base_rate,
         "ours": results, "published": PUBLISHED}, indent=1))
    print("\nwrote artifacts/dsr.json and artifacts/benchmark.json")


if __name__ == "__main__":
    main()
