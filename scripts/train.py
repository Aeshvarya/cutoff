"""Train Cutoff's recall model and score it against the baselines.

    python scripts/train.py --train 1000000 --test 200000

Writes artifacts/weights.json and artifacts/evaluation.json. Every number Cutoff
ever shows a user traces back to these two files.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cutoff.eval.metrics import evaluate                      # noqa: E402
from cutoff.model.baselines import ConstantHalfLife, Leitner, LogisticRecall, Pimsleur  # noqa: E402
from cutoff.model.dataset import DEFAULT_PATH, _user_bucket    # noqa: E402
from cutoff.model.features import instance_from_row            # noqa: E402
from cutoff.model.hlr import HalfLifeRegression                # noqa: E402


def load(path: Path, n_train: int, n_test: int, holdout_buckets: int = 10):
    """One pass over the file, filling both sides of the learner split."""
    train, test = [], []
    scanned = 0
    started = time.time()

    with gzip.open(path, "rt", newline="") as handle:
        for row in csv.DictReader(handle):
            scanned += 1
            target = test if _user_bucket(row["user_id"]) < holdout_buckets else train
            cap = n_test if target is test else n_train
            if len(target) >= cap:
                if len(train) >= n_train and len(test) >= n_test:
                    break
                continue

            instance = instance_from_row(row)
            if instance is not None:
                target.append(instance)

    print(f"scanned {scanned:,} rows in {time.time() - started:.1f}s")
    print(f"  train {len(train):,} instances   test {len(test):,} instances (disjoint learners)")
    return train, test


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--train", type=int, default=1_000_000)
    parser.add_argument("--test", type=int, default=200_000)
    parser.add_argument("--epochs", type=int, default=1)
    parser.add_argument("--lr", type=float, default=0.001)
    parser.add_argument("--data", type=Path, default=DEFAULT_PATH)
    args = parser.parse_args()

    train, test = load(args.data, args.train, args.test)

    median_half_life = statistics.median(inst.h for inst in train)
    print(f"\ntraining half-life regression (warm start at median h = {median_half_life:.1f} days)...")
    started = time.time()
    hlr = HalfLifeRegression(
        learning_rate=args.lr, warm_start_half_life=median_half_life
    ).fit(train, epochs=args.epochs)
    print(f"  done in {time.time() - started:.1f}s, {len(hlr.weights):,} weights")

    print("training logistic baseline...")
    logistic = LogisticRecall().fit(train)
    constant = ConstantHalfLife().fit(train)

    models = {
        "Cutoff (half-life regression)": hlr,
        "Logistic regression": logistic,
        "Leitner (1972)": Leitner(),
        "Pimsleur (1967)": Pimsleur(),
        "Constant half-life": constant,
    }

    print(f"\nevaluating on {len(test):,} reviews by learners never seen in training\n")
    header = f"{'model':<28} {'MAE(p)':>9} {'AUC':>8} {'Spearman(h)':>13}"
    print(header)
    print("-" * len(header))

    results = {}
    for name, model in models.items():
        scores = evaluate(model, test)
        results[name] = scores
        print(f"{name:<28} {scores['mae_p']:>9.4f} {scores['auc']:>8.4f} {scores['spearman_h']:>13.4f}")

    hlr.save(ROOT / "artifacts" / "weights.json")
    (ROOT / "artifacts" / "evaluation.json").write_text(
        json.dumps(
            {
                "dataset": "Duolingo 13M learning traces (doi:10.7910/DVN/N8XJME)",
                "split": "by learner, 10% of users held out",
                "train_instances": len(train),
                "test_instances": len(test),
                "epochs": args.epochs,
                "results": results,
            },
            indent=1,
        )
    )
    print(f"\nwrote artifacts/weights.json and artifacts/evaluation.json")


if __name__ == "__main__":
    main()
