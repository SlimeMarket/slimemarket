// ============ SlimeMarket — Income dashboard charts (Recharts + shadcn/ui patterns) ============
// Reads from the global `Recharts` UMD bundle (loaded via <script> in index.html).
// All components are dark-themed to match the Arc navy palette:
//   arc-bg #060A14 · arc-surface #0C1322 · arc-border #1C2740
//   arc-primary #2F6BFF · arc-accent #38BDF8 · emerald-400 #34D399
// Exposes: MonthlyRevenueBarChart, CumulativeRevenueAreaChart, OrderStatusPieChart,
// IncomeChartTooltip.

const { useId } = React;
const R = window.Recharts || {};
const {
  ResponsiveContainer,
  BarChart, Bar, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} = R;

// ---- color tokens (mirror tailwind arc palette) ----
const ARC = {
  bg: "#060A14",
  surface: "#0C1322",
  surface2: "#111C33",
  border: "#1C2740",
  borderlt: "#26355A",
  primary: "#2F6BFF",
  primarydk: "#1E4FD9",
  accent: "#38BDF8",
  text: "#E6EDF7",
  muted: "#8A9BB8",
  faint: "#5A6B8C",
};
// Emerald gradient stops for bars/area:
const EMERALD = { from: "#34D399", to: "#059669" };
// Pie palette for order-status breakdown (matches STATUS_META pills):
const STATUS_COLORS = {
  PENDING: "#8A9BB8",
  PROCESS: "#FBBF24",
  SENT: "#22D3EE",
  DONE: "#34D399",
  DISPUTED: "#FB7185",
  REFUNDED: "#FB7185",
  CANCELLED: "#5A6B8C",
  DECLINED: "#FB7185",
};

// ---- Custom tooltip (shadcn/ui-style: bordered card, mono numbers) ----
// `valueFormatter` lets callers pass formatUsdc / formatUsdcCompact.
function IncomeChartTooltip({ active, payload, label, valueFormatter, suffix }) {
  if (!active || !Array.isArray(payload) || payload.length === 0) return null;
  const fmt = typeof valueFormatter === "function" ? valueFormatter : (v) => v;
  return (
    <div className="rounded-xl ring-1 ring-arc-border bg-arc-surface/95 backdrop-blur px-3.5 py-2.5 shadow-2xl anim-fade">
      {label != null && (
        <div className="text-[11px] uppercase tracking-wide text-arc-faint mb-1.5">{String(label)}</div>
      )}
      <div className="space-y-1">
        {payload.map((p, i) => {
          const name = p.name || p.dataKey;
          const val = typeof p.value === "number" ? fmt(p.value) : String(p.value || "\u2014");
          const color = p.color || p.fill || ARC.primary;
          return (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: color }} />
              <span className="text-arc-muted">{name}</span>
              <span className="ml-auto font-mono tabular-nums text-arc-text font-semibold">
                {val}{suffix ? <span className="text-arc-faint ml-0.5">{suffix}</span> : null}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============ BarChart: monthly revenue (12 bars, emerald gradient) ============
// data: [{ month: "Jan", revenue: 1234.5, orders: 12 }, ...] (12 entries)
function MonthlyRevenueBarChart({ data = [], height = 280 }) {
  // Stable gradient id (re-render safe). Recharts <defs> live in the same SVG,
  // so we only define the gradient once per chart instance.
  const rawId = useId ? useId() : "a";
  const gid = "barEmGrad-" + String(rawId).replace(/[:]/g, "");
  if (!BarChart) {
    return <div className="text-xs text-arc-faint py-10 text-center">Charts unavailable (Recharts not loaded).</div>;
  }
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={EMERALD.from} stopOpacity={0.95} />
              <stop offset="100%" stopColor={EMERALD.to} stopOpacity={0.55} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={ARC.border} strokeDasharray="3 3" vertical={false} opacity={0.6} />
          <XAxis
            dataKey="month"
            tick={{ fill: ARC.muted, fontSize: 11, fontFamily: '"JetBrains Mono", monospace' }}
            tickLine={false}
            axisLine={{ stroke: ARC.border }}
            dy={6}
          />
          <YAxis
            tick={{ fill: ARC.faint, fontSize: 11, fontFamily: '"JetBrains Mono", monospace' }}
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={(v) => (window.Fmt ? window.Fmt.formatUsdcCompact(v) : v)}
          />
          <Tooltip
            cursor={{ fill: ARC.surface2, opacity: 0.4, radius: 6 }}
            content={<IncomeChartTooltip valueFormatter={(v) => (window.Fmt ? window.Fmt.formatUsdc(v) : v)} suffix="USDC" />}
          />
          <Bar
            dataKey="revenue"
            name="Revenue"
            fill={"url(#" + gid + ")"}
            radius={[6, 6, 0, 0]}
            maxBarSize={38}
            isAnimationActive={true}
            animationDuration={650}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

// ============ AreaChart: cumulative revenue trend ============
// data: [{ month: "Jan", cumulative: 1234.5 }, ...] (running total over 12 months)
function CumulativeRevenueAreaChart({ data = [], height = 260 }) {
  const rawId = useId ? useId() : "b";
  const gid = "cumEmerald-" + String(rawId).replace(/[:]/g, "");
  if (!AreaChart) {
    return <div className="text-xs text-arc-faint py-10 text-center">Charts unavailable.</div>;
  }
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={EMERALD.from} stopOpacity={0.45} />
              <stop offset="95%" stopColor={EMERALD.to} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={ARC.border} strokeDasharray="3 3" vertical={false} opacity={0.6} />
          <XAxis
            dataKey="month"
            tick={{ fill: ARC.muted, fontSize: 11, fontFamily: '"JetBrains Mono", monospace' }}
            tickLine={false}
            axisLine={{ stroke: ARC.border }}
            dy={6}
          />
          <YAxis
            tick={{ fill: ARC.faint, fontSize: 11, fontFamily: '"JetBrains Mono", monospace' }}
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={(v) => (window.Fmt ? window.Fmt.formatUsdcCompact(v) : v)}
          />
          <Tooltip
            cursor={{ stroke: ARC.accent, strokeWidth: 1, strokeDasharray: "4 4" }}
            content={<IncomeChartTooltip valueFormatter={(v) => (window.Fmt ? window.Fmt.formatUsdc(v) : v)} suffix="USDC" />}
          />
          <Area
            type="monotone"
            dataKey="cumulative"
            name="Cumulative Revenue"
            stroke={EMERALD.from}
            strokeWidth={2}
            fill={"url(#" + gid + ")"}
            dot={{ r: 2.5, fill: EMERALD.from, stroke: ARC.bg, strokeWidth: 1.5 }}
            activeDot={{ r: 5, fill: EMERALD.from, stroke: ARC.bg, strokeWidth: 2 }}
            isAnimationActive={true}
            animationDuration={700}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ============ PieChart: order status breakdown ============
// data: [{ name: "Done", value: 42, color: "#34D399" }, ...]
function OrderStatusPieChart({ data = [], height = 260 }) {
  if (!PieChart) {
    return <div className="text-xs text-arc-faint py-10 text-center">Charts unavailable.</div>;
  }
  // Use custom legend (right side) so we can show counts + colors consistent
  // with the rest of the dashboard.
  const total = data.reduce((s, d) => s + (Number(d.value) || 0), 0);
  return (
    <div className="flex flex-col sm:flex-row items-center gap-4" style={{ minHeight: height }}>
      <div style={{ width: "100%", maxWidth: 220, height }} className="shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={52}
              outerRadius={88}
              paddingAngle={2}
              stroke={ARC.bg}
              strokeWidth={2}
              isAnimationActive={true}
              animationDuration={650}
            >
              {data.map((d, i) => (
                <Cell key={i} fill={d.color || ARC.primary} />
              ))}
            </Pie>
            <Tooltip
              content={<IncomeChartTooltip valueFormatter={(v) => String(v) + " order" + (v === 1 ? "" : "s")} />}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      {/* Custom legend */}
      <div className="flex-1 w-full space-y-1.5">
        {data.map((d, i) => {
          const pct = total > 0 ? Math.round((d.value / total) * 100) : 0;
          return (
            <div key={i} className="flex items-center gap-2.5 text-xs">
              <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: d.color || ARC.primary }} />
              <span className="text-arc-muted">{d.name}</span>
              <span className="ml-auto font-mono tabular-nums text-arc-text font-semibold">{d.value}</span>
              <span className="text-arc-faint w-10 text-right tabular-nums">{pct}%</span>
            </div>
          );
        })}
        {data.length === 0 && <div className="text-xs text-arc-faint text-center py-6">No order data.</div>}
      </div>
    </div>
  );
}

Object.assign(window, {
  MonthlyRevenueBarChart,
  CumulativeRevenueAreaChart,
  OrderStatusPieChart,
  IncomeChartTooltip,
  INCOME_CHART_COLORS: { ARC, EMERALD, STATUS_COLORS },
});
