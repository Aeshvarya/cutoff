"""Is the forecast honest?

A model can rank well and still lie about magnitude. Cutoff tells a student a
number -- "68% on exam morning" -- so the property that actually matters is
calibration: of every card it calls 70%, roughly 70% should be recalled.

This writes a reliability curve over the held-out future reviews, plus the
same curve for the predict-the-mean baseline, so the difference is visible
rather than asserted.

    python scripts/calibration.py --collections 40
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from cutoff.eval.benchmark import flatten                      # noqa: E402
from cutoff.model import anki                                  # noqa: E402
from cutoff.model.dsr import DSRModel                          # noqa: E402


def reliability(p: np.ndarray, y: np.ndarray, edges: np.ndarray) -> list[dict]:
    """Group predictions into bins and compare the mean prediction with the
    mean outcome. Perfect calibration puts every point on the diagonal."""
    out = []
    index = np.digitize(p, edges) - 1
    for b in range(len(edges) - 1):
        sel = index == b
        n = int(sel.sum())
        if n < 200:      # too few to be a meaningful rate
            continue
        out.append({
            "bin_low": float(edges[b]),
            "bin_high": float(edges[b + 1]),
            "predicted": float(p[sel].mean()),
            "actual": float(y[sel].mean()),
            "n": n,
        })
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--collections", type=int, default=40)
    args = parser.parse_args()

    model = DSRModel.load(ROOT / "artifacts" / "dsr.json")
    _, test = anki.load(max_collections=args.collections)
    p, y, intervals, counts, lapses = flatten(test, model.predict(test))
    print(f"{len(p):,} held-out future reviews")

    edges = np.array([0, .5, .6, .7, .75, .8, .84, .88, .91, .94, .96, .98, 1.0])
    ours = reliability(p, y, edges)
    base_rate = float(y.mean())
    baseline = [{"bin_low": 0.0, "bin_high": 1.0, "predicted": base_rate,
                 "actual": base_rate, "n": int(len(y))}]

    # Expected calibration error: how far off the forecast is, weighted by how
    # often it makes each kind of claim.
    ece = sum(b["n"] * abs(b["predicted"] - b["actual"]) for b in ours) / sum(b["n"] for b in ours)

    print(f"\n{'predicted':>11}{'actual':>10}{'gap':>9}{'n':>10}")
    print("-" * 40)
    for b in ours:
        print(f"{b['predicted']:>11.3f}{b['actual']:>10.3f}{b['predicted'] - b['actual']:>+9.3f}{b['n']:>10,}")
    print(f"\nexpected calibration error: {ece:.4f}")
    print(f"base recall rate in the held-out set: {base_rate:.4f}")

    # How far ahead does the forecast still hold up? This is the number Cutoff's
    # whole premise rests on -- it forecasts months out, not days.
    horizons = []
    for lo, hi, label in [(0, 7, "under a week"), (7, 30, "1-4 weeks"),
                          (30, 90, "1-3 months"), (90, 1e9, "3 months+")]:
        sel = (intervals >= lo) & (intervals < hi)
        if sel.sum() < 500:
            continue
        horizons.append({"label": label, "n": int(sel.sum()),
                         "predicted": float(p[sel].mean()), "actual": float(y[sel].mean())})
    print(f"\n{'horizon':>14}{'predicted':>11}{'actual':>9}{'gap':>8}{'n':>10}")
    print("-" * 52)
    for h in horizons:
        print(f"{h['label']:>14}{h['predicted']:>11.3f}{h['actual']:>9.3f}"
              f"{h['predicted'] - h['actual']:>+8.3f}{h['n']:>10,}")

    (ROOT / "artifacts" / "calibration.json").write_text(json.dumps(
        {"reviews": int(len(p)), "base_rate": base_rate, "ece": ece,
         "curve": ours, "baseline": baseline, "by_horizon": horizons}, indent=1))
    print("\nwrote artifacts/calibration.json")


if __name__ == "__main__":
    main()
