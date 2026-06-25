"""
Smart Inventory Replenishment AI — FastAPI Backend
Endpoints: /predict, /replenishment-plan, /ai-insight, /dashboard-summary
"""

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import Optional, List
import pandas as pd
import numpy as np
import joblib
import os
import json
import httpx
from datetime import datetime

# ── Import training module ─────────────────────────────────────────────────────
import sys
sys.path.append(os.path.dirname(__file__))
from train_model import (
    generate_synthetic_data,
    build_features,
    train_and_evaluate,
    generate_replenishment_plan,
    calculate_replenishment,
)

app = FastAPI(
    title="Smart Inventory Replenishment AI",
    description="XGBoost demand forecasting + Groq LLM replenishment insights",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Globals (loaded on startup) ────────────────────────────────────────────────
MODEL_STATE = {}

@app.on_event("startup")
async def startup():
    """Train model on startup if not cached, load replenishment plan."""
    print("[startup] Initialising model...")
    model_path = "inventory_model.pkl"
    plan_path  = "replenishment_plan.csv"
    feat_path  = "features_dataset.csv"

    if os.path.exists(model_path) and os.path.exists(plan_path):
        state = joblib.load(model_path)
        MODEL_STATE["model"]    = state["model"]
        MODEL_STATE["features"] = state["features"]
        MODEL_STATE["plan"]     = pd.read_csv(plan_path)
        MODEL_STATE["feat_df"]  = pd.read_csv(feat_path, parse_dates=["date"])
        print("[startup] Loaded cached model.")
    else:
        print("[startup] Training fresh model...")
        raw_df  = generate_synthetic_data()
        feat_df = build_features(raw_df)
        model, feature_cols, _ = train_and_evaluate(feat_df)
        plan = generate_replenishment_plan(feat_df, model, feature_cols)

        joblib.dump({"model": model, "features": feature_cols}, model_path)
        plan.to_csv(plan_path, index=False)
        feat_df.to_csv(feat_path, index=False)

        MODEL_STATE["model"]    = model
        MODEL_STATE["features"] = feature_cols
        MODEL_STATE["plan"]     = plan
        MODEL_STATE["feat_df"]  = feat_df
        print("[startup] Model ready.")


# ── Schemas ────────────────────────────────────────────────────────────────────
class ReplenishmentRequest(BaseModel):
    store_id:       str   = Field(..., example="STORE-A")
    product_id:     str   = Field(..., example="SKU-001")
    current_stock:  int   = Field(..., ge=0)
    lead_time_days: int   = Field(7, ge=1, le=30)
    safety_stock:   int   = Field(20, ge=0)
    reorder_point:  int   = Field(40, ge=0)
    is_promoted:    int   = Field(0, ge=0, le=1)

class AIInsightRequest(BaseModel):
    store_id:    str
    product_id:  str
    urgency:     str
    stockout_risk_pct: float
    forecast_demand_next_4w: float
    recommended_order_qty:   int
    current_stock: int
    days_of_stock_remaining: float


# ── Helpers ────────────────────────────────────────────────────────────────────
def _get_groq_api_key() -> str:
    key = os.getenv("GROQ_API_KEY", "")
    if not key:
        raise HTTPException(status_code=500, detail="GROQ_API_KEY not set in environment.")
    return key


async def _call_groq(prompt: str, system: str) -> str:
    """Call Groq Cloud API (Llama 3.3 70B) and return text response."""
    api_key = _get_groq_api_key()
    payload = {
        "model": "llama-3.3-70b-versatile",
        "messages": [
            {"role": "system", "content": system},
            {"role": "user",   "content": prompt},
        ],
        "temperature": 0.4,
        "max_tokens":  512,
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=payload,
        )
        if resp.status_code != 200:
            raise HTTPException(status_code=502, detail=f"Groq API error: {resp.text}")
        return resp.json()["choices"][0]["message"]["content"].strip()


# ── Routes ─────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok", "model_loaded": "model" in MODEL_STATE, "timestamp": datetime.utcnow().isoformat()}


@app.get("/dashboard-summary")
async def dashboard_summary():
    """High-level KPIs for the React dashboard hero section."""
    plan = MODEL_STATE.get("plan")
    if plan is None:
        raise HTTPException(status_code=503, detail="Model not ready yet.")

    urgency_counts = plan["urgency"].value_counts().to_dict()
    total_skus      = len(plan)
    total_order_val = (plan["recommended_order_qty"] * 25).sum()  # ~$25 avg unit cost

    return {
        "total_skus":          total_skus,
        "critical_items":      int(urgency_counts.get("CRITICAL", 0)),
        "high_items":          int(urgency_counts.get("HIGH", 0)),
        "medium_items":        int(urgency_counts.get("MEDIUM", 0)),
        "low_items":           int(urgency_counts.get("LOW", 0)),
        "reorder_triggered":   int(plan["reorder_triggered"].sum()),
        "avg_stockout_risk":   round(float(plan["stockout_risk_pct"].mean()), 1),
        "total_order_value_usd": round(float(total_order_val), 2),
        "stores":              sorted(plan["store_id"].unique().tolist()),
        "categories":          sorted(plan["category"].unique().tolist()),
    }


@app.get("/replenishment-plan")
async def replenishment_plan(
    store_id:  Optional[str] = Query(None),
    category:  Optional[str] = Query(None),
    urgency:   Optional[str] = Query(None),
    limit:     int           = Query(50, ge=1, le=500),
):
    """Return filtered replenishment plan, sorted by urgency."""
    plan = MODEL_STATE.get("plan", pd.DataFrame()).copy()
    if plan.empty:
        raise HTTPException(status_code=503, detail="Model not ready.")

    if store_id:
        plan = plan[plan["store_id"] == store_id]
    if category:
        plan = plan[plan["category"] == category]
    if urgency:
        plan = plan[plan["urgency"] == urgency.upper()]

    # Replace NaN/inf for JSON serialisation
    plan = plan.replace([np.inf, -np.inf], 0).fillna(0)
    return plan.head(limit).to_dict(orient="records")


@app.get("/forecast/{store_id}/{product_id}")
async def get_forecast(store_id: str, product_id: str):
    """Return 12-week historical sales + 4-week forecast for a store-product pair."""
    feat_df = MODEL_STATE.get("feat_df")
    model   = MODEL_STATE.get("model")
    feats   = MODEL_STATE.get("features")

    if feat_df is None:
        raise HTTPException(status_code=503, detail="Model not ready.")

    subset = feat_df[(feat_df["store_id"] == store_id) & (feat_df["product_id"] == product_id)]
    if subset.empty:
        raise HTTPException(status_code=404, detail=f"No data for {store_id}/{product_id}.")

    history = subset.tail(12)[["date", "weekly_sales"]].copy()
    history["date"] = history["date"].dt.strftime("%Y-%m-%d")

    # Pseudo-forecast: take last row and project 4 weeks with decay noise
    last_row       = subset.iloc[-1:].copy()
    base_forecast  = float(model.predict(last_row[feats])[0])
    forecast_weeks = []
    last_date      = pd.to_datetime(history["date"].iloc[-1])
    for w in range(1, 5):
        noise = np.random.normal(1.0, 0.06)
        forecast_weeks.append({
            "date":         (last_date + pd.Timedelta(weeks=w)).strftime("%Y-%m-%d"),
            "weekly_sales": None,
            "forecast":     round(base_forecast * noise, 1),
        })

    history_records = history.rename(columns={"weekly_sales": "weekly_sales"}).to_dict(orient="records")
    for r in history_records:
        r["forecast"] = None

    return {
        "store_id":   store_id,
        "product_id": product_id,
        "history":    history_records,
        "forecast":   forecast_weeks,
    }


@app.get("/feature-importance")
async def feature_importance():
    model  = MODEL_STATE.get("model")
    feats  = MODEL_STATE.get("features")
    if not model:
        raise HTTPException(status_code=503, detail="Model not ready.")
    importance = dict(zip(feats, model.feature_importances_.tolist()))
    top10 = dict(sorted(importance.items(), key=lambda x: x[1], reverse=True)[:10])
    return {"feature_importance": top10}


@app.post("/predict")
async def predict_replenishment(req: ReplenishmentRequest):
    """Single SKU replenishment prediction."""
    feat_df = MODEL_STATE.get("feat_df")
    model   = MODEL_STATE.get("model")
    feats   = MODEL_STATE.get("features")
    if feat_df is None:
        raise HTTPException(status_code=503, detail="Model not ready.")

    subset = feat_df[
        (feat_df["store_id"] == req.store_id) & (feat_df["product_id"] == req.product_id)
    ]
    if subset.empty:
        raise HTTPException(status_code=404, detail=f"No historical data for {req.store_id}/{req.product_id}.")

    row = subset.iloc[-1:].copy()
    row["current_stock"]  = req.current_stock
    row["lead_time_days"] = req.lead_time_days
    row["safety_stock"]   = req.safety_stock
    row["reorder_point"]  = req.reorder_point
    row["is_promoted"]    = req.is_promoted

    forecast_demand = float(model.predict(row[feats])[0])
    rep = calculate_replenishment(row.iloc[0], forecast_demand)
    return {"store_id": req.store_id, "product_id": req.product_id, **rep}


@app.post("/ai-insight")
async def ai_insight(req: AIInsightRequest):
    """Call Groq Llama 3.3-70B to explain the replenishment recommendation in plain English."""
    system = (
        "You are an expert supply chain analyst. Given inventory data, "
        "provide a concise (3-4 sentences), actionable replenishment insight. "
        "Be specific about urgency, risk, and the business rationale. "
        "Do not use bullet points. Write for a store operations manager."
    )
    prompt = f"""
Store: {req.store_id} | Product: {req.product_id}
Current Stock: {req.current_stock} units
Days of Stock Remaining: {req.days_of_stock_remaining:.1f} days
Urgency Level: {req.urgency}
Stockout Risk: {req.stockout_risk_pct:.0f}%
Forecasted Demand (next 4 weeks): {req.forecast_demand_next_4w:.0f} units
Recommended Order Quantity: {req.recommended_order_qty} units

Explain why this replenishment action is needed and what happens if it is delayed.
"""
    insight = await _call_groq(prompt, system)
    return {"store_id": req.store_id, "product_id": req.product_id, "insight": insight}


@app.get("/sales-trend")
async def sales_trend(store_id: Optional[str] = Query(None)):
    """Aggregate weekly sales trend for chart visualisation."""
    feat_df = MODEL_STATE.get("feat_df")
    if feat_df is None:
        raise HTTPException(status_code=503, detail="Model not ready.")

    df = feat_df.copy()
    if store_id:
        df = df[df["store_id"] == store_id]

    trend = (
        df.groupby("date")["weekly_sales"]
        .sum()
        .reset_index()
        .tail(26)
    )
    trend["date"] = pd.to_datetime(trend["date"]).dt.strftime("%Y-%m-%d")
    return trend.to_dict(orient="records")
