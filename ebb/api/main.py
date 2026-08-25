"""Ebb's HTTP surface.

Deliberately stateless: the client holds its own cards and posts them with each
request. No database, nothing to migrate, and nothing to lose when a free-tier
host puts the process to sleep. The server's job is arithmetic.

The app also serves the built frontend from the same origin, so there is no API
base URL to configure and no CORS to get wrong in production.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from ebb.core.forecast import CardState, review_outcome
from ebb.core.planner import plan
from ebb.model.dsr import DSRModel

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = ROOT / "artifacts"
WEB = ROOT / "web"   # hand-written, no build step

MODEL = DSRModel.load(ARTIFACTS / "dsr.json") if (ARTIFACTS / "dsr.json").exists() else DSRModel()
W = MODEL.parameters

app = FastAPI(title="Ebb", description="Exam-day retention forecasting")


# --------------------------------------------------------------------------
# request / response shapes
# --------------------------------------------------------------------------

class CardIn(BaseModel):
    card_id: str
    concept: str
    stability: float = Field(gt=0, description="days until recall falls to 90%")
    difficulty: float = Field(ge=1, le=10)
    last_review_day: float = Field(description="today is 0; -3 means three days ago")


class SelfTestItem(BaseModel):
    """One item from the onboarding self-test.

    A brand-new user has no review history, so no stability. The honest fix is
    that the first review IS the calibration -- exactly what the model's initial
    state parameters are for. You grade yourself 1-4 and that seeds the card.
    """

    card_id: str
    concept: str
    rating: int = Field(ge=1, le=4, description="1 again, 2 hard, 3 good, 4 easy")


class ForecastRequest(BaseModel):
    cards: list[CardIn]
    days_to_exam: int = Field(gt=0)


class PlanRequest(ForecastRequest):
    target_recall: float = Field(default=0.90, gt=0, lt=1)
    minutes_per_review: float = Field(default=0.5, gt=0)
    max_reviews_per_day: int = Field(default=40, gt=0)


def _to_states(cards: list[CardIn]) -> list[CardState]:
    if not cards:
        raise HTTPException(400, "no cards supplied")
    return [
        CardState(c.card_id, c.concept, c.stability, c.difficulty, c.last_review_day)
        for c in cards
    ]


# --------------------------------------------------------------------------
# endpoints
# --------------------------------------------------------------------------

@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "model_parameters": len(W)}


@app.post("/api/calibrate")
def calibrate(items: list[SelfTestItem]) -> dict:
    """Turn self-test grades into card states.

    Uses the model's own initial-state parameters -- the same ones it uses for
    anybody's first review of anything -- so nothing here is invented for the
    demo.
    """
    if not items:
        raise HTTPException(400, "no items supplied")

    cards = []
    for item in items:
        stability = float(W[item.rating - 1])
        difficulty = float(np.clip(W[4] - np.exp(W[5] * (item.rating - 1)) + 1.0, 1.0, 10.0))
        cards.append(
            {
                "card_id": item.card_id,
                "concept": item.concept,
                "stability": stability,
                "difficulty": difficulty,
                "last_review_day": 0.0,
            }
        )
    return {"cards": cards}


@app.post("/api/forecast")
def forecast(request: ForecastRequest) -> dict:
    cards = _to_states(request.cards)
    days = request.days_to_exam
    per_card = {c.card_id: c.recall_on(days, W) for c in cards}

    by_concept: dict[str, list[float]] = {}
    for card in cards:
        by_concept.setdefault(card.concept, []).append(per_card[card.card_id])

    concepts = sorted(
        (
            {"concept": name, "n_cards": len(values), "recall": float(np.mean(values))}
            for name, values in by_concept.items()
        ),
        key=lambda c: c["recall"],
    )

    return {
        "days_to_exam": days,
        "overall_recall": float(np.mean(list(per_card.values()))),
        "per_concept": concepts,
        "per_card": per_card,
        "weakest_concept": concepts[0]["concept"] if concepts else None,
    }


@app.post("/api/curves")
def curves(request: ForecastRequest) -> dict:
    """Decay curves to draw, one per concept, out to exam day."""
    cards = _to_states(request.cards)
    by_concept: dict[str, list[CardState]] = {}
    for card in cards:
        by_concept.setdefault(card.concept, []).append(card)

    series = []
    for name, group in sorted(by_concept.items()):
        points = []
        for day in np.linspace(0, request.days_to_exam, 48):
            points.append(
                {"day": float(day), "recall": float(np.mean([c.recall_on(float(day), W) for c in group]))}
            )
        series.append({"concept": name, "points": points})
    return {"series": series}


@app.post("/api/plan")
def study_plan(request: PlanRequest) -> dict:
    cards = _to_states(request.cards)
    result = plan(
        cards,
        request.days_to_exam,
        W,
        target_recall=request.target_recall,
        minutes_per_review=request.minutes_per_review,
        max_reviews_per_day=request.max_reviews_per_day,
    )
    return {
        "target_recall": result.target_recall,
        "target_met": result.target_met,
        "recall_before": result.recall_before,
        "recall_after": result.recall_after,
        "total_reviews": len(result.reviews),
        "total_minutes": result.total_minutes,
        "sessions": [
            {"day": day, "cards": len(reviews), "minutes": len(reviews) * result.minutes_per_review,
             "concepts": sorted({r.concept for r in reviews})}
            for day, reviews in result.by_day().items()
        ],
    }


@app.post("/api/ceiling")
def ceiling(request: PlanRequest) -> dict:
    """The point of no return.

    For every possible start day, study as hard as physically possible from then
    on -- every night filled to capacity, always the weakest card -- and report
    the best exam-day retention still achievable. The last day whose ceiling
    clears the target is the deadline that actually matters.
    """
    cards = _to_states(request.cards)
    days = request.days_to_exam
    cap = request.max_reviews_per_day

    def best_possible(start_day: int) -> float:
        states = {c.card_id: CardState(c.card_id, c.concept, c.stability, c.difficulty, c.last_review_day)
                  for c in cards}
        for day in range(start_day, days):
            order = sorted(states.values(), key=lambda c: c.recall_on(days, W))
            for card in order[:cap]:
                states[card.card_id] = review_outcome(card, day, W)
        return float(np.mean([c.recall_on(days, W) for c in states.values()]))

    step = max(1, days // 24)
    sampled = {d: best_possible(d) for d in range(0, days, step)}

    # The ceiling falls as you start later, so the deadline is the last sampled
    # start day whose ceiling still clears the target.
    clearing = [d for d in sorted(sampled) if sampled[d] >= request.target_recall]
    deadline = clearing[-1] if clearing else None

    last_night = max(sampled)
    return {
        "target_recall": request.target_recall,
        "max_reviews_per_day": cap,
        "latest_start_day": deadline,
        "days_you_can_still_wait": None if deadline is None else deadline,
        "target_already_unreachable": deadline is None,
        "ceiling_if_you_start_today": sampled[min(sampled)],
        "ceiling_if_you_wait_until_day": {"day": last_night, "best_possible": sampled[last_night]},
        "curve": [{"start_day": d, "best_possible": v} for d, v in sorted(sampled.items())],
    }


@app.get("/api/proof")
def proof() -> dict:
    """The evaluation numbers, read straight off the committed artifact."""
    import json
    path = ARTIFACTS / "benchmark.json"
    if not path.exists():
        raise HTTPException(404, "no benchmark artifact; run scripts/benchmark.py")
    return json.loads(path.read_text())


# The frontend, same origin. Mounted last so it never shadows /api.
# No bundler: a build step is deployment risk we do not need, and the charts
# are hand-drawn SVG rather than a chart library.
if WEB.exists():
    @app.get("/app.js")
    def app_js() -> FileResponse:
        return FileResponse(WEB / "app.js", media_type="application/javascript")

    @app.get("/")
    def index() -> FileResponse:
        return FileResponse(WEB / "index.html")
