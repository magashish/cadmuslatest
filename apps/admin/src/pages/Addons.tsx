import { useState, useEffect, useCallback, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { addons, ApiError, type MarketplaceAddon } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import { UpgradePrompt } from "../components/UpgradePrompt";
import type { GateResult } from "../lib/feature-gates";

type Tab = "browse" | "installed";

// Synthetic gate for the add-on upgrade prompt: paid add-ons are simply not
// available on the free plan (no usage meter to show).
const ADDON_GATE: GateResult = { allowed: false, limit: null, usage: null, period: null };

function formatPrice(cents: number | null, interval: "mo" | "yr"): string {
  const dollars = (cents ?? 0) / 100;
  const str = Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
  return `$${str}/${interval}`;
}

export function Addons() {
  const { t } = useTranslation();
  const { user, sitePlan } = useAuth();
  const canManage = user?.role === "owner" || user?.role === "admin";
  const annual = sitePlan === "annual";

  const [tab, setTab] = useState<Tab>("browse");
  const [items, setItems] = useState<MarketplaceAddon[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [upgradeSlug, setUpgradeSlug] = useState<string | null>(null);
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await addons.list();
      setItems(res.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("addons.errors.load"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setActionError = (slug: string, msg: string) =>
    setActionErrors((prev) => ({ ...prev, [slug]: msg }));
  const clearActionError = (slug: string) =>
    setActionErrors((prev) => {
      const next = { ...prev };
      delete next[slug];
      return next;
    });

  const priceLabel = (a: MarketplaceAddon): string =>
    a.isFree ? t("addons.free") : formatPrice(annual ? a.priceAnnualCents : a.priceMonthlyCents, annual ? "yr" : "mo");

  const handleInstall = async (a: MarketplaceAddon) => {
    if (!canManage) return;
    clearActionError(a.slug);
    // Paid add-on on a free-tier site → prompt to upgrade instead of installing.
    if (!a.isFree && sitePlan === "free") {
      setUpgradeSlug(a.slug);
      return;
    }
    setBusySlug(a.slug);
    try {
      const res = await addons.install(a.slug);
      setItems((prev) =>
        prev.map((i) =>
          i.slug === a.slug
            ? { ...i, installed: true, installStatus: res.installStatus, config: res.config }
            : i,
        ),
      );
      setUpgradeSlug(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        setUpgradeSlug(a.slug);
      } else {
        setActionError(a.slug, e instanceof Error ? e.message : t("addons.errors.install"));
      }
    } finally {
      setBusySlug(null);
    }
  };

  const handleUninstall = async (a: MarketplaceAddon) => {
    if (!canManage) return;
    const message = a.isFree
      ? t("addons.confirmUninstall.free", { name: a.name })
      : t("addons.confirmUninstall.paid", { name: a.name });
    if (!confirm(message)) return;
    clearActionError(a.slug);
    setBusySlug(a.slug);
    try {
      await addons.uninstall(a.slug);
      setItems((prev) =>
        prev.map((i) =>
          i.slug === a.slug
            ? { ...i, installed: false, installStatus: null, config: undefined }
            : i,
        ),
      );
      if (expandedSlug === a.slug) setExpandedSlug(null);
    } catch (e) {
      setActionError(a.slug, e instanceof Error ? e.message : t("addons.errors.uninstall"));
    } finally {
      setBusySlug(null);
    }
  };

  const handleConfigSaved = (slug: string, config: Record<string, unknown>) => {
    setItems((prev) => prev.map((i) => (i.slug === slug ? { ...i, config } : i)));
  };

  const installed = items.filter((i) => i.installed);

  return (
    <div className="page">
      <h2>{t("addons.title")}</h2>
      <p style={{ color: "var(--color-text-muted)", marginTop: "0.25rem" }}>
        {t("addons.subtitle")}
      </p>

      <div style={{ display: "flex", gap: "0.5rem", marginTop: "1.5rem", borderBottom: "1px solid var(--color-border)" }}>
        {([
          ["browse", t("addons.tabs.browse")],
          ["installed", installed.length ? t("addons.tabs.installedWithCount", { count: installed.length }) : t("addons.tabs.installed")],
        ] as const).map(
          ([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              style={{
                padding: "0.5rem 1rem",
                background: "none",
                border: "none",
                borderBottom: tab === key ? "2px solid var(--color-primary)" : "2px solid transparent",
                fontWeight: tab === key ? 600 : 400,
                color: tab === key ? "var(--color-primary)" : "var(--color-text-muted)",
                cursor: "pointer",
                marginBottom: "-1px",
              }}
            >
              {label}
            </button>
          ),
        )}
      </div>

      {loading ? (
        <p style={{ marginTop: "1.5rem", color: "var(--color-text-muted)" }}>{t("addons.loading")}</p>
      ) : error ? (
        <p className="auth-error" style={{ marginTop: "1.5rem" }}>{error}</p>
      ) : tab === "browse" ? (
        <div style={{ marginTop: "1.5rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {items.length === 0 ? (
            <div className="card" style={{ padding: "2rem", textAlign: "center", color: "var(--color-text-muted)" }}>
              {t("addons.noneAvailable")}
            </div>
          ) : (
            items.map((a) => (
              <BrowseCard
                key={a.slug}
                addon={a}
                priceLabel={priceLabel(a)}
                canManage={!!canManage}
                busy={busySlug === a.slug}
                error={actionErrors[a.slug]}
                showBillingNote={!a.isFree && !a.installed && sitePlan !== "free"}
                showUpgrade={upgradeSlug === a.slug}
                onInstall={() => handleInstall(a)}
                onDismissUpgrade={() => setUpgradeSlug(null)}
              />
            ))
          )}
        </div>
      ) : (
        <div style={{ marginTop: "1.5rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
          {installed.length === 0 ? (
            <div className="card" style={{ padding: "2rem", textAlign: "center", color: "var(--color-text-muted)" }}>
              {t("addons.noneInstalledPrefix")} <strong>{t("addons.tabs.browse")}</strong>.
            </div>
          ) : (
            installed.map((a) => (
              <InstalledRow
                key={a.slug}
                addon={a}
                canManage={!!canManage}
                busy={busySlug === a.slug}
                error={actionErrors[a.slug]}
                expanded={expandedSlug === a.slug}
                onToggle={() => setExpandedSlug((s) => (s === a.slug ? null : a.slug))}
                onUninstall={() => handleUninstall(a)}
                onConfigSaved={handleConfigSaved}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function CategoryChip({ category }: { category: string | null }) {
  if (!category) return null;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0.1rem 0.5rem",
        borderRadius: "9999px",
        fontSize: "0.72rem",
        fontWeight: 600,
        textTransform: "capitalize",
        background: "var(--color-surface-2, #f3f4f6)",
        color: "var(--color-text-muted, #6b7280)",
      }}
    >
      {category}
    </span>
  );
}

function BrowseCard({
  addon,
  priceLabel,
  canManage,
  busy,
  error,
  showBillingNote,
  showUpgrade,
  onInstall,
  onDismissUpgrade,
}: {
  addon: MarketplaceAddon;
  priceLabel: string;
  canManage: boolean;
  busy: boolean;
  error?: string;
  showBillingNote: boolean;
  showUpgrade: boolean;
  onInstall: () => void;
  onDismissUpgrade: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const description = addon.description || "";
  const isLong = description.length > 160;
  const shown = expanded || !isLong ? description : `${description.slice(0, 160).trimEnd()}…`;

  return (
    <div className="card" style={{ padding: "1rem 1.25rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem" }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600, fontSize: "1rem" }}>{addon.name}</span>
            <CategoryChip category={addon.category} />
          </div>
          {addon.tagline && (
            <div style={{ color: "var(--color-text-muted)", fontSize: "0.875rem", marginTop: "0.15rem" }}>
              {addon.tagline}
            </div>
          )}
        </div>
        <span
          style={{
            whiteSpace: "nowrap",
            fontWeight: 600,
            fontSize: "0.8125rem",
            padding: "0.2rem 0.6rem",
            borderRadius: "9999px",
            background: addon.isFree ? "#ecfdf5" : "#eff6ff",
            color: addon.isFree ? "#047857" : "#1d4ed8",
            border: `1px solid ${addon.isFree ? "#a7f3d0" : "#bfdbfe"}`,
          }}
        >
          {priceLabel}
        </span>
      </div>

      {description && (
        <p style={{ fontSize: "0.875rem", lineHeight: 1.5, color: "var(--color-text, #374151)", margin: "0.75rem 0 0" }}>
          {shown}{" "}
          {isLong && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              style={{ background: "none", border: "none", padding: 0, color: "var(--color-primary)", cursor: "pointer", fontSize: "0.85rem" }}
            >
              {expanded ? t("addons.showLess") : t("addons.showMore")}
            </button>
          )}
        </p>
      )}

      <div style={{ marginTop: "1rem" }}>
        {addon.installed ? (
          <button type="button" className="btn" disabled>
            {t("addons.installed")}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canManage || busy}
            onClick={onInstall}
            title={canManage ? undefined : t("addons.installTitleDisabled")}
          >
            {busy ? t("addons.installing") : t("addons.install")}
          </button>
        )}
        {showBillingNote && !addon.installed && (
          <div style={{ fontSize: "0.78rem", color: "var(--color-text-muted)", marginTop: "0.4rem" }}>
            {t("addons.billingNote")}
          </div>
        )}
        {error && (
          <div className="auth-error" style={{ marginTop: "0.5rem" }}>{error}</div>
        )}
      </div>

      {showUpgrade && (
        <div style={{ marginTop: "1rem" }}>
          <UpgradePrompt feature="paid_addons" gate={ADDON_GATE} inline />
          <button
            type="button"
            onClick={onDismissUpgrade}
            style={{ background: "none", border: "none", padding: "0.4rem 0 0", color: "var(--color-text-muted)", cursor: "pointer", fontSize: "0.8rem" }}
          >
            {t("addons.dismiss")}
          </button>
        </div>
      )}
    </div>
  );
}

function InstalledRow({
  addon,
  canManage,
  busy,
  error,
  expanded,
  onToggle,
  onUninstall,
  onConfigSaved,
}: {
  addon: MarketplaceAddon;
  canManage: boolean;
  busy: boolean;
  error?: string;
  expanded: boolean;
  onToggle: () => void;
  onUninstall: () => void;
  onConfigSaved: (slug: string, config: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const suspended = addon.installStatus === "suspended";
  return (
    <div className="card" style={{ padding: "1rem 1.25rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "1rem", flexWrap: "wrap" }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600 }}>{addon.name}</span>
            <CategoryChip category={addon.category} />
            {suspended && (
              <span
                style={{
                  display: "inline-block",
                  padding: "0.15rem 0.5rem",
                  borderRadius: "4px",
                  fontSize: "0.72rem",
                  fontWeight: 600,
                  background: "#fef2f2",
                  color: "#b91c1c",
                  border: "1px solid #fecaca",
                }}
              >
                {t("addons.suspendedBadge")}
              </span>
            )}
          </div>
          {addon.tagline && (
            <div style={{ color: "var(--color-text-muted)", fontSize: "0.85rem", marginTop: "0.15rem" }}>
              {addon.tagline}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button type="button" className="btn" onClick={onToggle}>
            {t("addons.configure")} {expanded ? "▲" : "▼"}
          </button>
          <button
            type="button"
            className="btn"
            style={{ color: "#dc2626" }}
            disabled={!canManage || busy}
            onClick={onUninstall}
          >
            {busy ? t("addons.working") : t("addons.uninstall")}
          </button>
        </div>
      </div>

      {error && <div className="auth-error" style={{ marginTop: "0.5rem" }}>{error}</div>}

      {expanded && (
        <div style={{ marginTop: "1rem", paddingTop: "1rem", borderTop: "1px solid var(--color-border)" }}>
          <ConfigPanel addon={addon} canManage={canManage} onSaved={onConfigSaved} />
        </div>
      )}
    </div>
  );
}

function ConfigPanel({
  addon,
  canManage,
  onSaved,
}: {
  addon: MarketplaceAddon;
  canManage: boolean;
  onSaved: (slug: string, config: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation();
  const config = addon.config ?? {};
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const save = async (payload: Record<string, unknown>) => {
    if (!canManage) return;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const res = await addons.updateConfig(addon.slug, payload);
      onSaved(addon.slug, res.config);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("addons.errors.saveConfig"));
    } finally {
      setSaving(false);
    }
  };

  const status = (
    <>
      {saved && <span className="settings-success" style={{ marginLeft: "0.5rem" }}>{t("addons.configSaved")}</span>}
      {error && <span className="auth-error" style={{ marginLeft: "0.5rem" }}>{error}</span>}
    </>
  );

  if (addon.slug === "visitor-chatbot") {
    return <VisitorChatbotConfig config={config} saving={saving} canManage={canManage} onSave={save} status={status} />;
  }
  if (addon.slug === "turnstile-spam-protection") {
    return <TurnstileConfig config={config} saving={saving} canManage={canManage} onSave={save} status={status} />;
  }
  if (addon.slug === "mortgage-calculator") {
    return (
      <p style={{ fontSize: "0.875rem", color: "var(--color-text-muted)", margin: 0 }}>
        {t("addons.mortgageCalculatorHint")}
      </p>
    );
  }
  return (
    <p style={{ fontSize: "0.875rem", color: "var(--color-text-muted)", margin: 0 }}>
      {t("addons.noConfigurableSettings")}
    </p>
  );
}

function VisitorChatbotConfig({
  config,
  saving,
  canManage,
  onSave,
  status,
}: {
  config: Record<string, unknown>;
  saving: boolean;
  canManage: boolean;
  onSave: (payload: Record<string, unknown>) => void;
  status: ReactNode;
}) {
  const { t } = useTranslation();
  const [instructions, setInstructions] = useState((config.instructions as string) ?? "");
  const [greeting, setGreeting] = useState((config.greeting as string) ?? "");
  const [enabled, setEnabled] = useState(config.enabled !== false);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem", maxWidth: 560 }}>
      <label style={{ display: "block", fontSize: "0.875rem" }}>
        <span style={{ fontWeight: 600, display: "block", marginBottom: "0.25rem" }}>{t("addons.visitorChatbot.instructionsLabel")}</span>
        <textarea
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          rows={5}
          disabled={!canManage}
          placeholder={t("addons.visitorChatbot.instructionsPlaceholder")}
          style={{ width: "100%", padding: "0.6rem", border: "1px solid #d1d5db", borderRadius: 6, resize: "vertical", fontFamily: "inherit", fontSize: "0.875rem" }}
        />
      </label>
      <label style={{ display: "block", fontSize: "0.875rem" }}>
        <span style={{ fontWeight: 600, display: "block", marginBottom: "0.25rem" }}>{t("addons.visitorChatbot.greetingLabel")}</span>
        <input
          type="text"
          value={greeting}
          onChange={(e) => setGreeting(e.target.value)}
          disabled={!canManage}
          placeholder={t("addons.visitorChatbot.greetingPlaceholder")}
          style={{ width: "100%", padding: "0.5rem", border: "1px solid #d1d5db", borderRadius: 6, fontSize: "0.875rem" }}
        />
      </label>
      <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.875rem" }}>
        <input type="checkbox" checked={enabled} disabled={!canManage} onChange={(e) => setEnabled(e.target.checked)} />
        {t("addons.visitorChatbot.enabled")}
      </label>
      <div className="settings-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canManage || saving}
          onClick={() => onSave({ instructions, greeting, enabled })}
        >
          {saving ? t("common.saving") : t("common.save")}
        </button>
        {status}
      </div>
    </div>
  );
}

function TurnstileConfig({
  config,
  saving,
  canManage,
  onSave,
  status,
}: {
  config: Record<string, unknown>;
  saving: boolean;
  canManage: boolean;
  onSave: (payload: Record<string, unknown>) => void;
  status: ReactNode;
}) {
  const { t } = useTranslation();
  const [sitekey, setSitekey] = useState((config.sitekey as string) ?? "");
  const [secretKey, setSecretKey] = useState((config.secretKey as string) ?? "");
  const [open, setOpen] = useState(!!config.sitekey || !!config.secretKey);

  return (
    <div style={{ maxWidth: 560 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{ background: "none", border: "none", padding: 0, color: "var(--color-primary)", cursor: "pointer", fontSize: "0.875rem", fontWeight: 600 }}
      >
        {t("addons.turnstile.advancedToggle")} {open ? "▲" : "▼"}
      </button>

      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.85rem", marginTop: "0.85rem" }}>
          <p style={{ fontSize: "0.8125rem", color: "var(--color-text-muted)", margin: 0 }}>
            {t("addons.turnstile.description")}
          </p>
          <label style={{ display: "block", fontSize: "0.875rem" }}>
            <span style={{ fontWeight: 600, display: "block", marginBottom: "0.25rem" }}>{t("addons.turnstile.siteKeyLabel")}</span>
            <input
              type="text"
              value={sitekey}
              onChange={(e) => setSitekey(e.target.value)}
              disabled={!canManage}
              placeholder="0x4AAAAAAA…"
              style={{ width: "100%", padding: "0.5rem", border: "1px solid #d1d5db", borderRadius: 6, fontSize: "0.875rem" }}
            />
          </label>
          <label style={{ display: "block", fontSize: "0.875rem" }}>
            <span style={{ fontWeight: 600, display: "block", marginBottom: "0.25rem" }}>{t("addons.turnstile.secretKeyLabel")}</span>
            <input
              type="password"
              value={secretKey}
              onChange={(e) => setSecretKey(e.target.value)}
              disabled={!canManage}
              placeholder={t("addons.turnstile.secretKeyPlaceholder")}
              style={{ width: "100%", padding: "0.5rem", border: "1px solid #d1d5db", borderRadius: 6, fontSize: "0.875rem" }}
            />
          </label>
          <div className="settings-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canManage || saving}
              onClick={() => onSave({ sitekey, secretKey })}
            >
              {saving ? t("common.saving") : t("common.save")}
            </button>
            {status}
          </div>
        </div>
      )}
    </div>
  );
}
