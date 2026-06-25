import { useState, useEffect, useCallback } from "react";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend, Cell
} from "recharts";

// ── Mock data (replace with real API calls to FastAPI backend) ─────────────────
const STORES   = ["STORE-A", "STORE-B", "STORE-C", "STORE-D", "STORE-E"];
const CATS     = ["All", "Electronics", "Apparel", "Grocery", "Home"];
const URGENCY_ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

function randInt(lo, hi) { return Math.floor(Math.random() * (hi - lo + 1)) + lo; }
function seeded(n) { let x = Math.sin(n) * 10000; return x - Math.floor(x); }

function mockPlan() {
  const rows = [];
  const products = Array.from({ length: 10 }, (_, i) => `SKU-${String(i + 1).padStart(3, "0")}`);
  const cats = ["Electronics", "Apparel", "Grocery", "Home"];
  STORES.forEach((s, si) => {
    products.forEach((p, pi) => {
      const seed   = si * 100 + pi;
      const stock  = Math.floor(seeded(seed) * 300 + 10);
      const demand = Math.floor(seeded(seed + 1) * 120 + 40);
      const risk   = Math.min(100, Math.floor(seeded(seed + 2) * 100));
      const urgency = risk > 70 ? "CRITICAL" : risk > 45 ? "HIGH" : risk > 20 ? "MEDIUM" : "LOW";
      rows.push({
        store_id: s,
        product_id: p,
        category: cats[pi % cats.length],
        current_stock: stock,
        forecast_demand_next_4w: demand,
        recommended_order_qty: Math.max(0, demand - stock + randInt(10, 50)),
        days_of_stock_remaining: +(stock / (demand / 28)).toFixed(1),
        urgency,
        stockout_risk_pct: risk,
        reorder_triggered: stock < 60,
      });
    });
  });
  return rows;
}

function mockTrend() {
  return Array.from({ length: 26 }, (_, i) => {
    const base = 4500 + Math.sin(i / 3) * 800 + (i > 20 ? 600 : 0);
    return {
      date: new Date(2024, 0, 1 + i * 7).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      weekly_sales: Math.round(base + (seeded(i + 99) - 0.5) * 400),
    };
  });
}

function mockForecast(product) {
  return [
    ...Array.from({ length: 12 }, (_, i) => ({
      date: new Date(2023, 9, 1 + i * 7).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      actual: Math.round(80 + Math.sin(i / 2) * 30 + seeded(i + product.charCodeAt(4)) * 40),
      forecast: null,
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      date: new Date(2023, 11, 25 + i * 7).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      actual: null,
      forecast: Math.round(95 + Math.sin((12 + i) / 2) * 30 + seeded(12 + i) * 35),
    })),
  ];
}

// ── Colour system ──────────────────────────────────────────────────────────────
const C = {
  bg:       "#0d1117",
  surface:  "#161b22",
  border:   "#21262d",
  accent:   "#2563eb",
  accentLt: "#3b82f6",
  critical: "#ef4444",
  high:     "#f97316",
  medium:   "#eab308",
  low:      "#22c55e",
  text:     "#e6edf3",
  muted:    "#7d8590",
  groq:     "#8b5cf6",
};

const URGENCY_COLOR = { CRITICAL: C.critical, HIGH: C.high, MEDIUM: C.medium, LOW: C.low };

// ── Sub-components ─────────────────────────────────────────────────────────────
function KPICard({ label, value, sub, color = C.accent, icon }) {
  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.border}`,
      borderRadius: 10, padding: "18px 20px",
      borderTop: `3px solid ${color}`,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ color: C.muted, fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
          <div style={{ color: C.text, fontSize: 28, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{value}</div>
          {sub && <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>{sub}</div>}
        </div>
        <div style={{ fontSize: 22, opacity: 0.6 }}>{icon}</div>
      </div>
    </div>
  );
}

function UrgencyBadge({ urgency }) {
  return (
    <span style={{
      background: URGENCY_COLOR[urgency] + "22",
      color: URGENCY_COLOR[urgency],
      border: `1px solid ${URGENCY_COLOR[urgency]}44`,
      borderRadius: 4, padding: "2px 8px",
      fontSize: 11, fontWeight: 700, fontFamily: "monospace",
      letterSpacing: "0.06em",
    }}>
      {urgency}
    </span>
  );
}

function StockBar({ pct }) {
  const color = pct > 70 ? C.critical : pct > 45 ? C.high : pct > 20 ? C.medium : C.low;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3,
          transition: "width 0.4s ease" }} />
      </div>
      <span style={{ color, fontSize: 11, fontWeight: 700, fontFamily: "monospace", minWidth: 32 }}>{pct}%</span>
    </div>
  );
}

function GroqInsightPanel({ item, onClose }) {
  const [insight, setInsight] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Simulate Groq API call — replace with real fetch to /ai-insight
    const timer = setTimeout(() => {
      const urgencyMap = {
        CRITICAL: `${item.store_id}'s ${item.product_id} has only ${item.days_of_stock_remaining} days of stock remaining — well below the 14-day safety threshold. With a ${item.stockout_risk_pct}% stockout probability and ${item.forecast_demand_next_4w} units expected over the next 4 weeks, a stockout is imminent without immediate action. Ordering ${item.recommended_order_qty} units now will bridge the gap while accounting for lead time. Delaying by even 48 hours risks lost sales, customer attrition, and potential markdown pressure on substitutes.`,
        HIGH: `${item.product_id} at ${item.store_id} is approaching its reorder threshold with ${item.current_stock} units on hand and a ${item.stockout_risk_pct}% stockout risk. Forecasted demand of ${item.forecast_demand_next_4w} units over 4 weeks outpaces current inventory by a meaningful margin. Placing an order for ${item.recommended_order_qty} units ensures continuity through the lead time window. Deferring this order increases the likelihood of partial fulfilment and backorder costs.`,
        MEDIUM: `${item.product_id} at ${item.store_id} is within acceptable stock levels but trending toward a reorder trigger. With ${item.days_of_stock_remaining} days of stock and demand forecast at ${item.forecast_demand_next_4w} units, now is a good planning window to prepare a ${item.recommended_order_qty}-unit order. Proactive restocking at this stage avoids rush order premiums and keeps shelf availability above 95%.`,
        LOW: `${item.product_id} at ${item.store_id} is well-stocked with ${item.current_stock} units and a low stockout risk of ${item.stockout_risk_pct}%. No immediate action required. A routine order of ${item.recommended_order_qty} units can be scheduled in the next procurement cycle to maintain safety stock buffers ahead of the upcoming season.`,
      };
      setInsight(urgencyMap[item.urgency] || "Insight unavailable.");
      setLoading(false);
    }, 1400);
    return () => clearTimeout(timer);
  }, [item]);

  return (
    <div style={{
      position: "fixed", inset: 0, background: "#0009", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
    }} onClick={onClose}>
      <div style={{
        background: C.surface, border: `1px solid ${C.groq}44`,
        borderRadius: 12, padding: 28, maxWidth: 560, width: "100%",
        boxShadow: `0 0 40px ${C.groq}33`,
      }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <div style={{ color: C.groq, fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>
              ✦ Groq AI Insight — Llama 3.3 70B
            </div>
            <div style={{ color: C.text, fontWeight: 600, marginTop: 4 }}>
              {item.store_id} · {item.product_id}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: C.muted, fontSize: 20, cursor: "pointer" }}>✕</button>
        </div>

        <div style={{ borderBottom: `1px solid ${C.border}`, marginBottom: 16 }} />

        {loading ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12, color: C.muted }}>
            <div style={{
              width: 18, height: 18, border: `2px solid ${C.groq}44`,
              borderTop: `2px solid ${C.groq}`, borderRadius: "50%",
              animation: "spin 0.8s linear infinite",
            }} />
            Generating insight via Groq Cloud...
          </div>
        ) : (
          <p style={{ color: C.text, lineHeight: 1.7, margin: 0, fontSize: 14 }}>{insight}</p>
        )}

        <div style={{ marginTop: 20, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {[
            { l: "Stock Risk", v: `${item.stockout_risk_pct}%`, c: URGENCY_COLOR[item.urgency] },
            { l: "Order Qty", v: item.recommended_order_qty, c: C.accentLt },
            { l: "Days Left", v: item.days_of_stock_remaining, c: C.muted },
          ].map(({ l, v, c }) => (
            <div key={l} style={{ background: C.bg, borderRadius: 8, padding: "10px 14px" }}>
              <div style={{ color: C.muted, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>{l}</div>
              <div style={{ color: c, fontSize: 20, fontWeight: 700, fontFamily: "monospace", marginTop: 2 }}>{v}</div>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 16, fontSize: 11, color: C.muted, textAlign: "right" }}>
          Powered by Groq Cloud · Llama 3.3 70B Versatile · ~0.3s latency
        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ── Main App ───────────────────────────────────────────────────────────────────
export default function App() {
  const [activeTab, setActiveTab]       = useState("dashboard");
  const [selectedStore, setSelectedStore] = useState("All");
  const [selectedCat, setSelectedCat]   = useState("All");
  const [urgencyFilter, setUrgencyFilter] = useState("All");
  const [selectedItem, setSelectedItem] = useState(null);
  const [selectedProduct, setSelectedProduct] = useState("SKU-001");

  const allPlan  = mockPlan();
  const trendData = mockTrend();

  const plan = allPlan.filter(r =>
    (selectedStore === "All" || r.store_id === selectedStore) &&
    (selectedCat   === "All" || r.category   === selectedCat) &&
    (urgencyFilter === "All" || r.urgency    === urgencyFilter)
  ).sort((a, b) => URGENCY_ORDER.indexOf(a.urgency) - URGENCY_ORDER.indexOf(b.urgency));

  const kpis = {
    critical: allPlan.filter(r => r.urgency === "CRITICAL").length,
    high:     allPlan.filter(r => r.urgency === "HIGH").length,
    reorder:  allPlan.filter(r => r.reorder_triggered).length,
    avgRisk:  (allPlan.reduce((s, r) => s + r.stockout_risk_pct, 0) / allPlan.length).toFixed(1),
  };

  const urgencyDist = URGENCY_ORDER.map(u => ({
    name: u, count: allPlan.filter(r => r.urgency === u).length, color: URGENCY_COLOR[u],
  }));

  const forecastData = mockForecast(selectedProduct);

  const tabs = [
    { id: "dashboard", label: "Dashboard" },
    { id: "plan",      label: "Replenishment Plan" },
    { id: "forecast",  label: "Demand Forecast" },
    { id: "model",     label: "Model Info" },
  ];

  const TabBtn = ({ id, label }) => (
    <button onClick={() => setActiveTab(id)} style={{
      background: "none", border: "none", cursor: "pointer",
      padding: "10px 18px", borderRadius: 6,
      color: activeTab === id ? C.text : C.muted,
      fontWeight: activeTab === id ? 700 : 400,
      background: activeTab === id ? C.border : "none",
      fontSize: 14, transition: "all 0.15s",
    }}>{label}</button>
  );

  const Select = ({ value, onChange, options, style = {} }) => (
    <select value={value} onChange={e => onChange(e.target.value)} style={{
      background: C.surface, color: C.text, border: `1px solid ${C.border}`,
      borderRadius: 6, padding: "6px 10px", fontSize: 13, cursor: "pointer", ...style,
    }}>
      {options.map(o => <option key={o}>{o}</option>)}
    </select>
  );

  return (
    <div style={{ background: C.bg, minHeight: "100vh", fontFamily: "'Inter', system-ui, sans-serif", color: C.text }}>
      {/* Header */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.border}`, padding: "0 28px" }}>
        <div style={{ maxWidth: 1280, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", height: 56 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 8,
              background: `linear-gradient(135deg, ${C.accent}, ${C.groq})`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 16, fontWeight: 700,
            }}>📦</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em" }}>InventoryAI</div>
              <div style={{ color: C.muted, fontSize: 11 }}>Smart Replenishment · XGBoost + Groq</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {tabs.map(t => <TabBtn key={t.id} {...t} />)}
          </div>
          <div style={{
            background: `${C.low}22`, color: C.low, border: `1px solid ${C.low}44`,
            borderRadius: 20, padding: "4px 12px", fontSize: 12, fontWeight: 600,
          }}>
            ● Live · 50 SKUs · 5 Stores
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1280, margin: "0 auto", padding: "28px 28px" }}>

        {/* ── DASHBOARD TAB ── */}
        {activeTab === "dashboard" && (
          <div>
            <div style={{ marginBottom: 24 }}>
              <h1 style={{ fontSize: 24, fontWeight: 700, margin: 0 }}>Inventory Intelligence Overview</h1>
              <p style={{ color: C.muted, margin: "6px 0 0", fontSize: 14 }}>
                XGBoost demand forecasting · EOQ replenishment logic · Groq AI explanations
              </p>
            </div>

            {/* KPI Grid */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16, marginBottom: 28 }}>
              <KPICard label="Critical Items"   value={kpis.critical} sub="Immediate action needed" color={C.critical} icon="🔴" />
              <KPICard label="High Priority"    value={kpis.high}     sub="Reorder within 48h"      color={C.high}     icon="🟠" />
              <KPICard label="Reorder Triggered" value={kpis.reorder} sub="Below reorder point"     color={C.medium}   icon="⚠️" />
              <KPICard label="Avg Stockout Risk" value={`${kpis.avgRisk}%`} sub="Across all SKUs"   color={C.accentLt} icon="📊" />
            </div>

            {/* Charts row */}
            <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 20, marginBottom: 28 }}>
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20 }}>
                <div style={{ fontWeight: 600, marginBottom: 16, fontSize: 14 }}>Weekly Sales Trend (All Stores · 26 Weeks)</div>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={trendData}>
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                    <XAxis dataKey="date" stroke={C.muted} tick={{ fontSize: 11 }} interval={4} />
                    <YAxis stroke={C.muted} tick={{ fontSize: 11 }} />
                    <Tooltip contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6 }} />
                    <Line type="monotone" dataKey="weekly_sales" stroke={C.accentLt} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20 }}>
                <div style={{ fontWeight: 600, marginBottom: 16, fontSize: 14 }}>Urgency Distribution</div>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={urgencyDist} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" stroke={C.border} horizontal={false} />
                    <XAxis type="number" stroke={C.muted} tick={{ fontSize: 11 }} />
                    <YAxis dataKey="name" type="category" stroke={C.muted} tick={{ fontSize: 11 }} width={60} />
                    <Tooltip contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6 }} />
                    <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                      {urgencyDist.map((d) => <Cell key={d.name} fill={d.color} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Top critical items table */}
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20 }}>
              <div style={{ fontWeight: 600, marginBottom: 16, fontSize: 14 }}>Top 8 Critical Items — Immediate Action Required</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ color: C.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    {["Store", "SKU", "Category", "Stock", "Forecast 4W", "Order Qty", "Stockout Risk", ""].map(h => (
                      <th key={h} style={{ textAlign: "left", padding: "8px 12px", borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {allPlan.filter(r => r.urgency === "CRITICAL").slice(0, 8).map((row, i) => (
                    <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                      <td style={{ padding: "10px 12px", fontFamily: "monospace", fontSize: 12 }}>{row.store_id}</td>
                      <td style={{ padding: "10px 12px", fontFamily: "monospace", fontSize: 12 }}>{row.product_id}</td>
                      <td style={{ padding: "10px 12px" }}>{row.category}</td>
                      <td style={{ padding: "10px 12px", fontFamily: "monospace" }}>{row.current_stock}</td>
                      <td style={{ padding: "10px 12px", fontFamily: "monospace" }}>{row.forecast_demand_next_4w}</td>
                      <td style={{ padding: "10px 12px", fontFamily: "monospace", color: C.accentLt, fontWeight: 700 }}>{row.recommended_order_qty}</td>
                      <td style={{ padding: "10px 12px", width: 140 }}><StockBar pct={row.stockout_risk_pct} /></td>
                      <td style={{ padding: "10px 12px" }}>
                        <button onClick={() => setSelectedItem(row)} style={{
                          background: `${C.groq}22`, color: C.groq, border: `1px solid ${C.groq}44`,
                          borderRadius: 5, padding: "3px 10px", fontSize: 11, cursor: "pointer", fontWeight: 600,
                        }}>✦ AI Insight</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── REPLENISHMENT PLAN TAB ── */}
        {activeTab === "plan" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Full Replenishment Plan</h2>
                <p style={{ color: C.muted, margin: "4px 0 0", fontSize: 13 }}>{plan.length} items · sorted by urgency</p>
              </div>
              <div style={{ display: "flex", gap: 10 }}>
                <Select value={selectedStore} onChange={setSelectedStore} options={["All", ...STORES]} />
                <Select value={selectedCat}   onChange={setSelectedCat}   options={CATS} />
                <Select value={urgencyFilter} onChange={setUrgencyFilter} options={["All", ...URGENCY_ORDER]} />
              </div>
            </div>

            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ color: C.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", background: C.bg }}>
                    {["Store", "SKU", "Category", "Urgency", "Current Stock", "Days Left", "Forecast 4W", "Order Qty", "Stockout Risk", "AI"].map(h => (
                      <th key={h} style={{ textAlign: "left", padding: "10px 14px", borderBottom: `1px solid ${C.border}`, fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {plan.map((row, i) => (
                    <tr key={i} style={{
                      borderBottom: `1px solid ${C.border}`,
                      background: row.urgency === "CRITICAL" ? `${C.critical}08` : "none",
                    }}>
                      <td style={{ padding: "9px 14px", fontFamily: "monospace", fontSize: 12 }}>{row.store_id}</td>
                      <td style={{ padding: "9px 14px", fontFamily: "monospace", fontSize: 12 }}>{row.product_id}</td>
                      <td style={{ padding: "9px 14px" }}>{row.category}</td>
                      <td style={{ padding: "9px 14px" }}><UrgencyBadge urgency={row.urgency} /></td>
                      <td style={{ padding: "9px 14px", fontFamily: "monospace" }}>{row.current_stock}</td>
                      <td style={{ padding: "9px 14px", fontFamily: "monospace",
                        color: row.days_of_stock_remaining < 7 ? C.critical : row.days_of_stock_remaining < 14 ? C.high : C.text,
                      }}>{row.days_of_stock_remaining}d</td>
                      <td style={{ padding: "9px 14px", fontFamily: "monospace" }}>{row.forecast_demand_next_4w}</td>
                      <td style={{ padding: "9px 14px", fontFamily: "monospace", color: C.accentLt, fontWeight: 700 }}>{row.recommended_order_qty}</td>
                      <td style={{ padding: "9px 14px", width: 130 }}><StockBar pct={row.stockout_risk_pct} /></td>
                      <td style={{ padding: "9px 14px" }}>
                        <button onClick={() => setSelectedItem(row)} style={{
                          background: "none", border: `1px solid ${C.groq}55`, color: C.groq,
                          borderRadius: 4, padding: "2px 8px", fontSize: 11, cursor: "pointer",
                        }}>✦</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── FORECAST TAB ── */}
        {activeTab === "forecast" && (
          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>Demand Forecast</h2>
                <p style={{ color: C.muted, margin: "4px 0 0", fontSize: 13 }}>12-week actuals + 4-week XGBoost forecast</p>
              </div>
              <Select value={selectedProduct} onChange={setSelectedProduct}
                options={Array.from({ length: 10 }, (_, i) => `SKU-${String(i + 1).padStart(3, "0")}`)} />
            </div>

            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 24, marginBottom: 20 }}>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={forecastData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                  <XAxis dataKey="date" stroke={C.muted} tick={{ fontSize: 11 }} interval={2} />
                  <YAxis stroke={C.muted} tick={{ fontSize: 11 }} />
                  <Tooltip contentStyle={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 6 }} />
                  <Legend />
                  <Line type="monotone" dataKey="actual"   stroke={C.accentLt} strokeWidth={2} dot={{ r: 3 }} name="Actual Sales" connectNulls={false} />
                  <Line type="monotone" dataKey="forecast" stroke={C.groq} strokeWidth={2} strokeDasharray="6 3" dot={{ r: 3 }} name="XGBoost Forecast" connectNulls={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20 }}>
                <div style={{ color: C.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em" }}>Model</div>
                <div style={{ color: C.text, fontWeight: 700, marginTop: 6 }}>XGBoost Regressor</div>
                <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>400 estimators · depth 6</div>
              </div>
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20 }}>
                <div style={{ color: C.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em" }}>CV Strategy</div>
                <div style={{ color: C.text, fontWeight: 700, marginTop: 6 }}>TimeSeriesSplit (5 fold)</div>
                <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>No data leakage</div>
              </div>
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: 20 }}>
                <div style={{ color: C.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em" }}>Top Features</div>
                <div style={{ color: C.text, fontWeight: 700, marginTop: 6 }}>Lag 1W, Roll Mean 4W</div>
                <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>+ holiday flags, category</div>
              </div>
            </div>
          </div>
        )}

        {/* ── MODEL INFO TAB ── */}
        {activeTab === "model" && (
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 6 }}>System Architecture</h2>
            <p style={{ color: C.muted, marginBottom: 24, fontSize: 14 }}>How the forecasting and replenishment engine works end-to-end.</p>

            {[
              {
                title: "XGBoost Demand Forecasting", color: C.accentLt, icon: "🤖",
                desc: "Gradient boosted trees trained on 2 years of weekly sales data per store-SKU pair. Features include lag windows (1W–12W), rolling statistics, seasonality flags, holiday indicators, and inventory pressure signals. Validated with TimeSeriesSplit to prevent leakage.",
                tags: ["XGBoost", "Feature Engineering", "TimeSeriesSplit", "MAE/RMSE"],
              },
              {
                title: "EOQ-Inspired Replenishment Logic", color: C.medium, icon: "📦",
                desc: "Given the 4-week demand forecast, we compute: reorder trigger (current stock ≤ reorder point), recommended order qty (target stock − current stock), days of stock remaining, and stockout risk percentage. Urgency is classified as CRITICAL / HIGH / MEDIUM / LOW.",
                tags: ["Economic Order Quantity", "Safety Stock", "Lead Time", "Reorder Point"],
              },
              {
                title: "Groq AI Explanations", color: C.groq, icon: "✦",
                desc: "Each replenishment recommendation is passed to Llama 3.3 70B via Groq Cloud API. The model generates a plain-English explanation of why action is needed, quantifying the business risk of inaction. Groq's ultra-low latency (~0.3s) makes this viable in real-time dashboards.",
                tags: ["Llama 3.3 70B", "Groq Cloud", "LLM Explainability", "Supply Chain NLP"],
              },
              {
                title: "FastAPI REST Backend", color: C.low, icon: "⚡",
                desc: "Python FastAPI serves the model predictions, replenishment plan, and Groq insights via async REST endpoints. The model is trained once on startup and cached. CORS-enabled for React frontend integration.",
                tags: ["FastAPI", "Uvicorn", "Async Python", "REST API"],
              },
            ].map((item, i) => (
              <div key={i} style={{
                background: C.surface, border: `1px solid ${C.border}`,
                borderLeft: `4px solid ${item.color}`,
                borderRadius: 10, padding: 22, marginBottom: 16,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  <span style={{ fontSize: 20 }}>{item.icon}</span>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>{item.title}</div>
                </div>
                <p style={{ color: C.muted, margin: "0 0 14px", lineHeight: 1.6, fontSize: 14 }}>{item.desc}</p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {item.tags.map(t => (
                    <span key={t} style={{
                      background: `${item.color}18`, color: item.color,
                      border: `1px solid ${item.color}33`, borderRadius: 4,
                      padding: "2px 8px", fontSize: 11, fontWeight: 600,
                    }}>{t}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Groq AI Insight Modal */}
      {selectedItem && <GroqInsightPanel item={selectedItem} onClose={() => setSelectedItem(null)} />}
    </div>
  );
}
