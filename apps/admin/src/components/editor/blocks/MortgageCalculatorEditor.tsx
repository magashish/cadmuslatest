import type { MortgageCalculatorBlock } from "@cadmus/shared";

const TERM_OPTIONS = [15, 20, 30];

interface Props {
  data: MortgageCalculatorBlock["data"];
  onDataChange: (data: MortgageCalculatorBlock["data"]) => void;
  theme?: Record<string, unknown>;
}

// <input type="color"> only accepts #rrggbb — normalize #rgb, reject anything
// else so an empty/invalid value never renders the browser's blank "dash" state.
function toHex6(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(v)) {
    return `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`.toLowerCase();
  }
  return null;
}

export function MortgageCalculatorEditor({ data, onDataChange, theme }: Props) {
  const num = (value: string): number | undefined => {
    if (value === "") return undefined;
    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  // The swatch always shows the EFFECTIVE color: the custom override when set,
  // otherwise the site theme's primary (what the block actually renders with).
  const themeColors = (theme?.colors ?? {}) as Record<string, unknown>;
  const themePrimary = toHex6(themeColors.primary) ?? "#2563eb";
  const customAccent = toHex6(data.accentColor);
  const effectiveAccent = customAccent ?? themePrimary;

  return (
    <div>
      <div className="form-group">
        <label>Title</label>
        <input
          type="text"
          value={data.title ?? ""}
          onChange={(e) => onDataChange({ ...data, title: e.target.value })}
          placeholder="Mortgage Calculator"
        />
        <small style={{ color: "#888" }}>Optional heading shown above the calculator</small>
      </div>

      <div className="form-group">
        <label>Default Home Price ($)</label>
        <input
          type="number"
          min={0}
          step={1000}
          value={data.defaultPrice ?? ""}
          onChange={(e) => onDataChange({ ...data, defaultPrice: num(e.target.value) })}
          placeholder="400000"
        />
      </div>

      <div className="form-group">
        <label>Default Down Payment (%)</label>
        <input
          type="number"
          min={0}
          max={100}
          step={1}
          value={data.defaultDownPct ?? ""}
          onChange={(e) => onDataChange({ ...data, defaultDownPct: num(e.target.value) })}
          placeholder="20"
        />
      </div>

      <div className="form-group">
        <label>Default Interest Rate (% APR)</label>
        <input
          type="number"
          min={0}
          step={0.1}
          value={data.defaultRatePct ?? ""}
          onChange={(e) => onDataChange({ ...data, defaultRatePct: num(e.target.value) })}
          placeholder="6.5"
        />
      </div>

      <div className="form-group">
        <label>Default Loan Term (years)</label>
        <select
          value={data.defaultTermYears ?? 30}
          onChange={(e) => onDataChange({ ...data, defaultTermYears: parseInt(e.target.value, 10) })}
        >
          {TERM_OPTIONS.map((years) => (
            <option key={years} value={years}>{years}</option>
          ))}
        </select>
      </div>

      <div className="form-group">
        <label>
          <input
            type="checkbox"
            checked={data.showAmortization ?? false}
            onChange={(e) => onDataChange({ ...data, showAmortization: e.target.checked })}
          />{" "}
          Show amortization schedule
        </label>
      </div>

      <div className="form-group">
        <label>Accent Color</label>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Swatch styling mirrors ThemeEditor's color chips — the explicit
              size + padding:0 stop the global `.form-group input` padding from
              crushing the native swatch into a blank sliver. */}
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.4rem 0.6rem",
              borderRadius: "6px",
              border: "1px solid var(--color-border, #e2e8f0)",
              background: "var(--color-surface, #f8fafc)",
              cursor: "pointer",
              fontSize: "0.8rem",
            }}
          >
            <input
              type="color"
              value={effectiveAccent}
              onChange={(e) => onDataChange({ ...data, accentColor: e.target.value })}
              style={{
                width: "28px",
                height: "28px",
                border: "1px solid rgba(0,0,0,0.15)",
                borderRadius: "4px",
                padding: 0,
                cursor: "pointer",
                flexShrink: 0,
              }}
            />
            <span style={{ color: "var(--color-text-muted, #666)", fontSize: "0.75rem", fontFamily: "monospace" }}>
              {effectiveAccent}
            </span>
          </label>
          {customAccent ? (
            <button
              type="button"
              onClick={() => {
                const { accentColor: _omit, ...rest } = data;
                onDataChange(rest);
              }}
            >
              Reset to theme
            </button>
          ) : (
            <span style={{ fontSize: "0.75rem", color: "#888" }}>Using theme color</span>
          )}
        </div>
        <small style={{ color: "#888" }}>
          Overrides the theme primary color for this calculator. Pick a color to customize.
        </small>
      </div>

      <div className="form-group">
        <label>
          <input
            type="checkbox"
            checked={data.includeTaxesInsurance ?? false}
            onChange={(e) =>
              onDataChange({ ...data, includeTaxesInsurance: e.target.checked })
            }
          />{" "}
          Include taxes &amp; insurance
        </label>
        <small style={{ color: "#888" }}>
          Adds property-tax and insurance inputs and shows a total monthly payment (PITI).
        </small>
      </div>

      {data.includeTaxesInsurance && (
        <>
          <div className="form-group">
            <label>Default Property Tax Rate (%/yr)</label>
            <input
              type="number"
              min={0}
              step={0.05}
              value={data.defaultTaxRatePct ?? ""}
              onChange={(e) =>
                onDataChange({ ...data, defaultTaxRatePct: num(e.target.value) })
              }
              placeholder="1.1"
            />
          </div>

          <div className="form-group">
            <label>Default Home Insurance ($/yr)</label>
            <input
              type="number"
              min={0}
              step={50}
              value={data.defaultInsuranceYearly ?? ""}
              onChange={(e) =>
                onDataChange({ ...data, defaultInsuranceYearly: num(e.target.value) })
              }
              placeholder="1500"
            />
          </div>

          <div className="form-group">
            <label>
              <input
                type="checkbox"
                checked={data.showBreakdown ?? true}
                onChange={(e) => onDataChange({ ...data, showBreakdown: e.target.checked })}
              />{" "}
              Show payment breakdown
            </label>
          </div>
        </>
      )}
    </div>
  );
}
