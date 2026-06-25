"""
Smart Inventory Replenishment AI
Demand Forecasting Engine — XGBoost + Feature Engineering
Author: Aamina Nooraiyeen
"""

import pandas as pd
import numpy as np
from xgboost import XGBRegressor
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import mean_absolute_error, mean_squared_error
from sklearn.preprocessing import LabelEncoder
import joblib
import warnings
warnings.filterwarnings("ignore")

# ── 1. SYNTHETIC DATA GENERATOR (replace with Kaggle Walmart dataset) ──────────
def generate_synthetic_data(n_stores=5, n_products=10, n_weeks=104):
    """
    Generates realistic retail sales data with seasonality, trends, and noise.
    In production: load from Kaggle Walmart Sales Forecasting dataset.
    """
    np.random.seed(42)
    dates = pd.date_range("2022-01-03", periods=n_weeks, freq="W-MON")
    records = []

    PRODUCTS = [f"SKU-{str(i).zfill(3)}" for i in range(1, n_products + 1)]
    STORES   = [f"STORE-{chr(64 + i)}" for i in range(1, n_stores + 1)]
    CATEGORIES = {"SKU-001": "Electronics", "SKU-002": "Apparel",  "SKU-003": "Grocery",
                  "SKU-004": "Grocery",     "SKU-005": "Apparel",  "SKU-006": "Electronics",
                  "SKU-007": "Home",        "SKU-008": "Home",     "SKU-009": "Grocery",
                  "SKU-010": "Electronics"}

    base_demand = {p: np.random.randint(40, 200) for p in PRODUCTS}

    for store in STORES:
        store_multiplier = np.random.uniform(0.7, 1.4)
        for product in PRODUCTS:
            lead_time_days = np.random.choice([3, 5, 7, 10])
            safety_stock   = np.random.randint(10, 50)
            reorder_point  = np.random.randint(20, 80)
            current_stock  = np.random.randint(30, 300)

            for i, date in enumerate(dates):
                week      = date.isocalendar()[1]
                month     = date.month
                # Seasonality: peak in Nov-Dec, dip in Jan-Feb
                season_factor = 1 + 0.3 * np.sin(2 * np.pi * (month - 3) / 12)
                # Holiday spike: weeks 47-52
                holiday_bump  = 1.5 if 47 <= week <= 52 else 1.0
                trend         = 1 + 0.002 * i  # gentle upward trend
                noise         = np.random.normal(1.0, 0.12)

                demand = int(
                    base_demand[product]
                    * store_multiplier
                    * season_factor
                    * holiday_bump
                    * trend
                    * noise
                )
                demand = max(0, demand)

                records.append({
                    "date":          date,
                    "store_id":      store,
                    "product_id":    product,
                    "category":      CATEGORIES.get(product, "General"),
                    "weekly_sales":  demand,
                    "lead_time_days": lead_time_days,
                    "safety_stock":  safety_stock,
                    "reorder_point": reorder_point,
                    "current_stock": current_stock + np.random.randint(-10, 10),
                    "unit_cost":     round(np.random.uniform(5, 150), 2),
                    "selling_price": round(np.random.uniform(10, 300), 2),
                    "is_promoted":   int(np.random.random() < 0.15),
                })

    return pd.DataFrame(records)


# ── 2. FEATURE ENGINEERING ─────────────────────────────────────────────────────
def build_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.sort_values(["store_id", "product_id", "date"]).copy()

    grp = df.groupby(["store_id", "product_id"])

    # Lag features (demand signal history)
    for lag in [1, 2, 4, 8, 12]:
        df[f"lag_{lag}w"] = grp["weekly_sales"].shift(lag)

    # Rolling statistics
    for w in [4, 8, 12]:
        df[f"roll_mean_{w}w"] = grp["weekly_sales"].shift(1).transform(
            lambda x: x.rolling(w, min_periods=1).mean()
        )
        df[f"roll_std_{w}w"] = grp["weekly_sales"].shift(1).transform(
            lambda x: x.rolling(w, min_periods=1).std().fillna(0)
        )

    # Time features
    df["week_of_year"] = df["date"].dt.isocalendar().week.astype(int)
    df["month"]        = df["date"].dt.month
    df["quarter"]      = df["date"].dt.quarter
    df["is_q4"]        = (df["quarter"] == 4).astype(int)
    df["is_holiday_season"] = df["week_of_year"].between(47, 52).astype(int)

    # Encode categoricals
    le_store   = LabelEncoder()
    le_product = LabelEncoder()
    le_cat     = LabelEncoder()
    df["store_enc"]    = le_store.fit_transform(df["store_id"])
    df["product_enc"]  = le_product.fit_transform(df["product_id"])
    df["category_enc"] = le_cat.fit_transform(df["category"])

    # Inventory pressure feature
    df["stock_to_demand_ratio"] = df["current_stock"] / (df["roll_mean_4w"] + 1)
    df["days_of_stock"]         = (df["current_stock"] / ((df["roll_mean_4w"] / 7) + 0.01)).round(1)

    return df.dropna()


# ── 3. REPLENISHMENT CALCULATOR ────────────────────────────────────────────────
def calculate_replenishment(row: pd.Series, forecast_demand: float) -> dict:
    """
    Economic Order Quantity (EOQ) inspired replenishment logic.
    Returns recommended order quantity and urgency level.
    """
    lead_time_weeks    = row["lead_time_days"] / 7
    demand_during_lead = forecast_demand * lead_time_weeks
    safety_stock       = row["safety_stock"]
    reorder_point      = row["reorder_point"]
    current_stock      = row["current_stock"]

    # Target stock = demand_during_lead + safety_stock + 4-week buffer
    target_stock  = demand_during_lead + safety_stock + (forecast_demand * 4)
    order_qty     = max(0, round(target_stock - current_stock))

    # Urgency classification
    if current_stock <= 0:
        urgency = "CRITICAL"
    elif current_stock <= reorder_point:
        urgency = "HIGH"
    elif current_stock <= reorder_point * 1.5:
        urgency = "MEDIUM"
    else:
        urgency = "LOW"

    stockout_risk = max(0, min(100, round(
        100 * (1 - current_stock / max(demand_during_lead + safety_stock, 1))
    )))

    return {
        "forecast_demand_next_4w": round(forecast_demand * 4, 1),
        "recommended_order_qty":   order_qty,
        "days_of_stock_remaining": round(current_stock / max(forecast_demand / 7, 0.01), 1),
        "urgency":                 urgency,
        "stockout_risk_pct":       stockout_risk,
        "reorder_triggered":       current_stock <= reorder_point,
    }


# ── 4. TRAIN + EVALUATE ────────────────────────────────────────────────────────
def train_and_evaluate(df: pd.DataFrame):
    FEATURE_COLS = [
        "lag_1w", "lag_2w", "lag_4w", "lag_8w", "lag_12w",
        "roll_mean_4w", "roll_mean_8w", "roll_mean_12w",
        "roll_std_4w", "roll_std_8w", "roll_std_12w",
        "week_of_year", "month", "quarter", "is_q4", "is_holiday_season",
        "store_enc", "product_enc", "category_enc",
        "lead_time_days", "safety_stock", "reorder_point",
        "current_stock", "is_promoted", "stock_to_demand_ratio",
    ]
    TARGET = "weekly_sales"

    X = df[FEATURE_COLS]
    y = df[TARGET]

    # Time-series cross validation (no data leakage)
    tscv   = TimeSeriesSplit(n_splits=5)
    scores = {"mae": [], "rmse": []}

    model = XGBRegressor(
        n_estimators=400,
        max_depth=6,
        learning_rate=0.05,
        subsample=0.8,
        colsample_bytree=0.8,
        min_child_weight=5,
        reg_alpha=0.1,
        reg_lambda=1.0,
        random_state=42,
        n_jobs=-1,
    )

    for fold, (train_idx, val_idx) in enumerate(tscv.split(X)):
        X_tr, X_val = X.iloc[train_idx], X.iloc[val_idx]
        y_tr, y_val = y.iloc[train_idx], y.iloc[val_idx]
        model.fit(X_tr, y_tr, eval_set=[(X_val, y_val)], verbose=False)
        preds = model.predict(X_val)
        scores["mae"].append(mean_absolute_error(y_val, preds))
        scores["rmse"].append(np.sqrt(mean_squared_error(y_val, preds)))

    print("=== XGBoost Time-Series CV Results ===")
    print(f"  MAE  : {np.mean(scores['mae']):.2f} ± {np.std(scores['mae']):.2f}")
    print(f"  RMSE : {np.mean(scores['rmse']):.2f} ± {np.std(scores['rmse']):.2f}")

    # Final model on full data
    model.fit(X, y, verbose=False)

    # Feature importance
    importance = pd.Series(model.feature_importances_, index=FEATURE_COLS).sort_values(ascending=False)
    print("\nTop 10 Features:")
    print(importance.head(10).to_string())

    return model, FEATURE_COLS, importance


# ── 5. GENERATE PREDICTIONS + REPLENISHMENT PLAN ───────────────────────────────
def generate_replenishment_plan(df: pd.DataFrame, model, feature_cols: list) -> pd.DataFrame:
    # Use most recent week per store-product
    latest = df.sort_values("date").groupby(["store_id", "product_id"]).last().reset_index()

    latest["forecast_weekly_demand"] = model.predict(latest[feature_cols]).clip(0)

    replenishment_rows = []
    for _, row in latest.iterrows():
        rep = calculate_replenishment(row, row["forecast_weekly_demand"])
        replenishment_rows.append({
            "store_id":    row["store_id"],
            "product_id":  row["product_id"],
            "category":    row["category"],
            "current_stock": int(row["current_stock"]),
            **rep,
        })

    plan = pd.DataFrame(replenishment_rows)
    plan = plan.sort_values(["urgency", "stockout_risk_pct"],
                             key=lambda x: x.map({"CRITICAL":0,"HIGH":1,"MEDIUM":2,"LOW":3}) if x.name=="urgency" else x,
                             ascending=[True, False])
    return plan


# ── 6. MAIN ────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("Generating synthetic retail data...")
    raw_df = generate_synthetic_data(n_stores=5, n_products=10, n_weeks=104)
    print(f"  Rows: {len(raw_df):,}")

    print("\nBuilding features...")
    feat_df = build_features(raw_df)
    print(f"  Feature rows (after dropna): {len(feat_df):,}")

    print("\nTraining XGBoost model...")
    model, feature_cols, importance = train_and_evaluate(feat_df)

    print("\nGenerating replenishment plan...")
    plan = generate_replenishment_plan(feat_df, model, feature_cols)
    print(f"\n{'='*60}")
    print("REPLENISHMENT PLAN (Top 15 Priority Items)")
    print(f"{'='*60}")
    print(plan.head(15).to_string(index=False))

    # Save model + feature cols
    joblib.dump({"model": model, "features": feature_cols}, "inventory_model.pkl")
    plan.to_csv("replenishment_plan.csv", index=False)
    feat_df.to_csv("features_dataset.csv", index=False)
    print("\nSaved: inventory_model.pkl, replenishment_plan.csv, features_dataset.csv")
