import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { site, ai, content as contentApi, apiRawFetch, platformAdmin, billing, importWP, team, collections as collectionsApi, auth as authApi, submissions } from "../lib/api";
import type { WpAnalyzeResult, WpImportOptions, WpImportResult, TeamMember, BillingStatus } from "../lib/api";

interface SiteData {
  id: string;
  name: string;
  subdomain: string;
  domain?: string;
  brief?: Record<string, string>;
  settings?: Record<string, unknown>;
}

function buildDnsInstructions(domain: string): {
  instructions: { type: string; name: string; value: string }[];
  message: string;
} {
  const isRootDomain = domain.split(".").length === 2;
  const instructions = isRootDomain
    ? [{ type: "CNAME", name: "www", value: "origin.cadmus.digital" }]
    : [{ type: "CNAME", name: domain, value: "origin.cadmus.digital" }];
  const message = isRootDomain
    ? "Add a CNAME for www pointing to origin.cadmus.digital. If your DNS provider supports CNAME flattening (like Cloudflare), you can also add a CNAME for the root domain. Otherwise, set up a redirect from your root domain to www. DNS changes usually take 5 minutes to a few hours to propagate."
    : "Add a CNAME record pointing to origin.cadmus.digital. SSL is provisioned automatically. DNS changes usually take 5 minutes to a few hours to propagate.";
  return { instructions, message };
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn-copy"
      title="Copy to clipboard"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard denied */
        }
      }}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

export function SiteSettings() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const showDebug = searchParams.get("debug") === "true";
  const [siteData, setSiteData] = useState<SiteData | null>(null);
  const [loading, setLoading] = useState(true);
  const [resetting, setResetting] = useState(false);

  // General
  const [siteName, setSiteName] = useState("");
  const [siteLanguage, setSiteLanguage] = useState("en");
  const [generalSaved, setGeneralSaved] = useState(false);
  const [generalError, setGeneralError] = useState("");

  // Brief
  const [businessName, setBusinessName] = useState("");
  const [businessDescription, setBusinessDescription] = useState("");
  const [targetAudience, setTargetAudience] = useState("");
  const [tone, setTone] = useState("");
  const [primaryGoal, setPrimaryGoal] = useState("");
  const [briefSaved, setBriefSaved] = useState(false);
  const [briefError, setBriefError] = useState("");

  // Business Info
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [streetAddress, setStreetAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [country, setCountry] = useState("");
  const [businessInfoSaved, setBusinessInfoSaved] = useState(false);
  const [businessInfoError, setBusinessInfoError] = useState("");

  // Form Defaults
  const [formNotificationEmail, setFormNotificationEmail] = useState("");
  const [formConfirmationEnabled, setFormConfirmationEnabled] = useState(false);
  const [formConfirmationMessage, setFormConfirmationMessage] = useState("");
  const [formWebhookUrl, setFormWebhookUrl] = useState("");
  const [formWebhookEnabled, setFormWebhookEnabled] = useState(false);
  const [webhookSecret, setWebhookSecret] = useState<string | null>(null);
  const [revealingSecret, setRevealingSecret] = useState(false);
  const [formSaved, setFormSaved] = useState(false);
  const [formError, setFormError] = useState("");

  // Custom code (owner-only head/body script injection)
  const [customHead, setCustomHead] = useState("");
  const [customBodyEnd, setCustomBodyEnd] = useState("");
  const [customCodeSaving, setCustomCodeSaving] = useState(false);
  const [customCodeSaved, setCustomCodeSaved] = useState(false);
  const [customCodeError, setCustomCodeError] = useState("");

  // Social Links — fixed set of common platforms, stored in settings.socialLinks
  // as Array<{ platform, url }>. Empty URLs are omitted on save so the footer
  // wiring only gets real links.
  const [socialFacebook, setSocialFacebook] = useState("");
  const [socialInstagram, setSocialInstagram] = useState("");
  const [socialTwitter, setSocialTwitter] = useState("");
  const [socialLinkedIn, setSocialLinkedIn] = useState("");
  const [socialYouTube, setSocialYouTube] = useState("");
  const [socialTikTok, setSocialTikTok] = useState("");
  const [socialSaved, setSocialSaved] = useState(false);
  const [socialError, setSocialError] = useState("");

  // Domain
  const [customDomain, setCustomDomain] = useState("");
  const [dnsInstructions, setDnsInstructions] = useState<{ type: string; name: string; value: string }[] | null>(null);
  const [dnsMessage, setDnsMessage] = useState("");
  const [domainError, setDomainError] = useState("");
  const [domainStatus, setDomainStatus] = useState<string | null>(null);
  const [sslStatus, setSslStatus] = useState<string | null>(null);
  const [domainChecking, setDomainChecking] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  // Subdomain change
  const [subdomainExpanded, setSubdomainExpanded] = useState(false);
  const [newSubdomain, setNewSubdomain] = useState("");
  const [subdomainAvailable, setSubdomainAvailable] = useState<boolean | null>(null);
  const [subdomainChecking, setSubdomainChecking] = useState(false);
  const [subdomainSaving, setSubdomainSaving] = useState(false);
  const [subdomainError, setSubdomainError] = useState("");
  const [subdomainSaved, setSubdomainSaved] = useState(false);
  const subdomainDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Billing status (for subdomain change warning)
  const [billingStatusForSubdomain, setBillingStatusForSubdomain] = useState<BillingStatus | null>(null);

  // Theme Debug (platform admin only)
  const [themeDebugData, setThemeDebugData] = useState<Record<string, unknown> | null>(null);
  const [themeDebugLoading, setThemeDebugLoading] = useState(false);
  const [themeDebugError, setThemeDebugError] = useState("");
  const [recompiling, setRecompiling] = useState(false);
  const [recompileResult, setRecompileResult] = useState<{
    ok: boolean;
    beforeBytes: number;
    afterBytes: number;
    blockCount: number;
  } | null>(null);
  const [recompileError, setRecompileError] = useState("");

  // Stitch Import (debug)
  const [stitchProjectId, setStitchProjectId] = useState("");
  const [stitchLoading, setStitchLoading] = useState(false);
  const [stitchError, setStitchError] = useState("");
  const [stitchScreens, setStitchScreens] = useState<
    Array<{ screenId: string; name: string; screenshotUrl?: string }>
  >([]);
  const [existingPages, setExistingPages] = useState<Array<{ id: string; slug: string; type: string }>>([]);
  const [stitchMapping, setStitchMapping] = useState<Record<string, string>>({});
  const [stitchApplying, setStitchApplying] = useState(false);
  const [stitchProgress, setStitchProgress] = useState("");
  const [stitchDone, setStitchDone] = useState<{ applied: number; failed: number } | null>(null);

  useEffect(() => {
    if (!user) return;
    site
      .get(user.siteId)
      .then((s) => {
        const data = s as SiteData;
        setSiteData(data);
        setSiteName(data.name);
        const settings = (s as Record<string, unknown>).settings as Record<string, unknown> | undefined;
        const bi = settings?.businessInfo as Record<string, unknown> | undefined;
        if (bi) {
          setContactEmail((bi.contactEmail as string) || "");
          setContactPhone((bi.contactPhone as string) || "");
          setStreetAddress((bi.streetAddress as string) || "");
          setCity((bi.city as string) || "");
          setState((bi.state as string) || "");
          setPostalCode((bi.postalCode as string) || "");
          setCountry((bi.country as string) || "");
        }
        const fd = settings?.formDefaults as Record<string, unknown> | undefined;
        if (fd) {
          setFormNotificationEmail((fd.notificationEmail as string) || "");
          setFormConfirmationEnabled(fd.confirmationEnabled === true);
          setFormConfirmationMessage((fd.confirmationMessage as string) || "");
          setFormWebhookUrl((fd.webhookUrl as string) || "");
          setFormWebhookEnabled(fd.webhookEnabled === true);
        }
        const cc = settings?.customCode as { head?: string; bodyEnd?: string } | undefined;
        if (cc) {
          setCustomHead(cc.head || "");
          setCustomBodyEnd(cc.bodyEnd || "");
        }
        const sl = settings?.socialLinks as Array<{ platform: string; url: string }> | undefined;
        if (Array.isArray(sl)) {
          const byPlatform = (p: string) =>
            sl.find((l) => l.platform?.toLowerCase() === p.toLowerCase())?.url ?? "";
          setSocialFacebook(byPlatform("facebook"));
          setSocialInstagram(byPlatform("instagram"));
          setSocialTwitter(byPlatform("twitter") || byPlatform("x"));
          setSocialLinkedIn(byPlatform("linkedin"));
          setSocialYouTube(byPlatform("youtube"));
          setSocialTikTok(byPlatform("tiktok"));
        }
        if (data.brief) {
          setBusinessName(data.brief.businessName || "");
          setBusinessDescription(data.brief.businessDescription || "");
          setTargetAudience(data.brief.targetAudience || "");
          setTone(data.brief.tone || "");
          setPrimaryGoal(data.brief.primaryGoal || "");
          setSiteLanguage(data.brief.language ?? "en");
        }
        if (data.domain) {
          const dns = buildDnsInstructions(data.domain);
          setDnsInstructions(dns.instructions);
          setDnsMessage(dns.message);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    billing.status().then(setBillingStatusForSubdomain).catch(() => {});
  }, [user]);

  // Load existing pages for Stitch import mapping
  useEffect(() => {
    contentApi
      .list("page")
      .then((res) => {
        setExistingPages(
          (res.items as Array<{ id: string; slug: string; type: string }>).map((p) => ({
            id: p.id,
            slug: p.slug,
            type: p.type,
          }))
        );
      })
      .catch(() => {});
  }, []);

  const saveGeneral = async () => {
    if (!siteData) return;
    setGeneralError("");
    setGeneralSaved(false);
    try {
      const existingBrief = (siteData.brief ?? {}) as Record<string, string>;
      await site.update(siteData.id, {
        name: siteName,
        brief: { ...existingBrief, language: siteLanguage },
      });
      setGeneralSaved(true);
      setTimeout(() => setGeneralSaved(false), 3000);
    } catch (e) {
      setGeneralError(e instanceof Error ? e.message : "Failed to save");
    }
  };

  const saveBrief = async () => {
    if (!siteData) return;
    setBriefError("");
    setBriefSaved(false);
    try {
      await site.update(siteData.id, {
        brief: { businessName, businessDescription, targetAudience, tone, primaryGoal, language: siteLanguage },
      });
      setBriefSaved(true);
      setTimeout(() => setBriefSaved(false), 3000);
    } catch (e) {
      setBriefError(e instanceof Error ? e.message : "Failed to save");
    }
  };

  const connectDomain = async () => {
    if (!siteData || !customDomain.trim()) return;
    setDomainError("");
    setDnsInstructions(null);
    try {
      const res = await site.connectDomain(siteData.id, customDomain.trim());
      const domain = customDomain.trim();
      const fallback = buildDnsInstructions(domain);
      setDnsInstructions(res.dns?.instructions ?? fallback.instructions);
      setDnsMessage(res.dns?.message ?? fallback.message);
      setDomainStatus(res.domainStatus);
      setSiteData({ ...siteData, domain });
    } catch (e) {
      setDomainError(e instanceof Error ? e.message : "Failed to connect domain");
    }
  };

  // Auto-poll domain status while pending so the user doesn't have to keep
  // hitting "Check Status" after updating their DNS.
  useEffect(() => {
    if (!siteData?.id || !siteData?.domain) return;
    if (domainStatus === "active" || domainStatus === "failed") return;

    let cancelled = false;
    const fetchStatus = async () => {
      try {
        const res = await site.getDomainStatus(siteData.id);
        if (cancelled) return;
        setDomainStatus(res.domainStatus);
        setSslStatus(res.sslStatus);
        if (res.errors?.length) {
          setDomainError(res.errors.join(", "));
        } else {
          setDomainError("");
        }
      } catch {
        /* silent during polling */
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 15_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [siteData?.id, siteData?.domain, domainStatus]);

  const checkDomainStatus = async () => {
    if (!siteData) return;
    setDomainChecking(true);
    setDomainError("");
    try {
      const res = await site.getDomainStatus(siteData.id);
      setDomainStatus(res.domainStatus);
      setSslStatus(res.sslStatus);
      if (res.errors?.length) {
        setDomainError(res.errors.join(", "));
      }
    } catch (e) {
      setDomainError(e instanceof Error ? e.message : "Failed to check status");
    } finally {
      setDomainChecking(false);
    }
  };

  const disconnectDomain = async () => {
    if (!siteData?.domain) return;
    const confirmed = window.confirm(
      `Disconnect ${siteData.domain}?\n\nVisitors using this domain will immediately stop reaching your site until you reconnect it or update DNS elsewhere. Your subdomain URL keeps working.`
    );
    if (!confirmed) return;
    setDisconnecting(true);
    setDomainError("");
    try {
      await site.disconnectDomain(siteData.id);
      setSiteData({ ...siteData, domain: undefined });
      setDomainStatus(null);
      setSslStatus(null);
      setDnsInstructions(null);
      setDnsMessage("");
      setCustomDomain("");
    } catch (e) {
      setDomainError(e instanceof Error ? e.message : "Failed to disconnect domain");
    } finally {
      setDisconnecting(false);
    }
  };

  const handleSubdomainInput = (value: string) => {
    setNewSubdomain(value);
    setSubdomainAvailable(null);
    setSubdomainError("");
    if (subdomainDebounceRef.current) clearTimeout(subdomainDebounceRef.current);
    const normalized = value.toLowerCase().trim();
    if (!normalized || normalized === siteData?.subdomain) return;
    subdomainDebounceRef.current = setTimeout(async () => {
      setSubdomainChecking(true);
      try {
        const res = await authApi.checkSubdomain(normalized);
        setSubdomainAvailable(res.available);
      } catch {
        setSubdomainAvailable(null);
      } finally {
        setSubdomainChecking(false);
      }
    }, 400);
  };

  const saveSubdomain = async () => {
    if (!siteData || !newSubdomain.trim()) return;
    setSubdomainError("");
    setSubdomainSaved(false);
    setSubdomainSaving(true);
    try {
      const res = await site.changeSubdomain(newSubdomain.trim().toLowerCase());
      setSiteData({ ...siteData, subdomain: res.subdomain });
      setSubdomainExpanded(false);
      setNewSubdomain("");
      setSubdomainAvailable(null);
      setSubdomainSaved(true);
      setTimeout(() => setSubdomainSaved(false), 4000);
    } catch (e) {
      setSubdomainError(e instanceof Error ? e.message : "Failed to change subdomain");
    } finally {
      setSubdomainSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="page">
        <h2>Settings</h2>
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="page">
      <h2>Settings</h2>

      {/* General */}
      <section className="settings-section">
        <h3>General</h3>
        <div className="settings-form">
          <label>
            Site Name
            <input
              type="text"
              value={siteName}
              onChange={(e) => setSiteName(e.target.value)}
            />
          </label>
          <label>
            Site Language
            <select value={siteLanguage} onChange={(e) => setSiteLanguage(e.target.value)}>
              <option value="en">English</option>
              <option value="es">Español (Spanish)</option>
            </select>
          </label>
          <div className="settings-actions">
            <button className="btn btn-primary" onClick={saveGeneral}>Save</button>
            {generalSaved && <span className="settings-success">Saved!</span>}
            {generalError && <span className="auth-error">{generalError}</span>}
          </div>
        </div>
      </section>

      {/* Domain */}
      <section className="settings-section">
        <h3>Domain</h3>

        {/* Subdomain */}
        <div style={{ marginBottom: "1.25rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
            <p style={{ margin: 0 }}>
              Subdomain:{" "}
              {(() => {
                const bd = import.meta.env.VITE_BASE_DOMAIN || "cadmus.digital";
                const host = bd === "cadmus.digital"
                  ? `${siteData?.subdomain}.cadmus.digital`
                  : `${siteData?.subdomain}--dev.cadmus.digital`;
                return <a href={`https://${host}`} target="_blank" rel="noopener noreferrer"><strong>{host}</strong></a>;
              })()}
            </p>
            {!subdomainExpanded && (
              <button
                type="button"
                className="btn btn-secondary"
                style={{ fontSize: "0.85rem", padding: "0.25rem 0.75rem" }}
                onClick={() => {
                  setSubdomainExpanded(true);
                  setNewSubdomain("");
                  setSubdomainAvailable(null);
                  setSubdomainError("");
                }}
              >
                Change
              </button>
            )}
            {subdomainSaved && <span className="settings-success">Subdomain updated!</span>}
          </div>

          {subdomainExpanded && (
            <div className="settings-form" style={{ marginTop: "0.75rem" }}>
              {(() => {
                const sub = billingStatusForSubdomain?.subscription;
                const isPaid = sub?.status && !["trialing", "canceled", null].includes(sub.status) ||
                  sub?.status === "active";
                // Treat trialing as paid too — they have a payment method
                const hasSub = sub != null;
                const isPaidPlan = hasSub && (sub.status === "active" || sub.status === "trialing" || sub.status === "past_due");
                return isPaidPlan ? (
                  <div style={{
                    padding: "0.75rem",
                    background: "#fffbeb",
                    border: "1px solid #fde68a",
                    borderRadius: "6px",
                    fontSize: "0.875rem",
                    marginBottom: "0.75rem",
                  }}>
                    Your old URL will redirect to the new one for 48 hours. After that, only the new URL will work. We will email you a confirmation.
                  </div>
                ) : (
                  <div style={{
                    padding: "0.75rem",
                    background: "#fef2f2",
                    border: "1px solid #fecaca",
                    borderRadius: "6px",
                    fontSize: "0.875rem",
                    marginBottom: "0.75rem",
                  }}>
                    Your old URL will stop working immediately after this change.
                  </div>
                );
              })()}
              <label>
                New subdomain
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <input
                    type="text"
                    value={newSubdomain}
                    onChange={(e) => handleSubdomainInput(e.target.value)}
                    placeholder={siteData?.subdomain}
                    style={{ flex: 1 }}
                    autoFocus
                  />
                  <span style={{ whiteSpace: "nowrap", fontSize: "0.9rem", color: "var(--color-text-muted)" }}>
                    {(import.meta.env.VITE_BASE_DOMAIN || "cadmus.digital") === "cadmus.digital" ? ".cadmus.digital" : "--dev.cadmus.digital"}
                  </span>
                </div>
                {newSubdomain && newSubdomain.toLowerCase() !== siteData?.subdomain && (
                  <span style={{ fontSize: "0.8rem", marginTop: "0.25rem", display: "block" }}>
                    {subdomainChecking ? (
                      <span style={{ color: "var(--color-text-muted)" }}>Checking...</span>
                    ) : subdomainAvailable === true ? (
                      <span style={{ color: "#16a34a" }}>Available</span>
                    ) : subdomainAvailable === false ? (
                      <span style={{ color: "#dc2626" }}>Not available</span>
                    ) : null}
                  </span>
                )}
              </label>
              {subdomainError && <span className="auth-error">{subdomainError}</span>}
              <div className="settings-actions">
                <button
                  className="btn btn-primary"
                  onClick={saveSubdomain}
                  disabled={
                    subdomainSaving ||
                    !newSubdomain.trim() ||
                    newSubdomain.toLowerCase().trim() === siteData?.subdomain ||
                    subdomainAvailable === false
                  }
                >
                  {subdomainSaving ? "Saving..." : "Save"}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setSubdomainExpanded(false);
                    setNewSubdomain("");
                    setSubdomainAvailable(null);
                    setSubdomainError("");
                  }}
                  style={{ marginLeft: "0.5rem" }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
        {siteData?.domain ? (
          <div>
            <p style={{ marginBottom: "0.75rem" }}>
              Custom domain: {domainStatus === "active" ? (
                <a href={`https://${siteData.domain}`} target="_blank" rel="noopener noreferrer"><strong>{siteData.domain}</strong></a>
              ) : (
                <strong>{siteData.domain}</strong>
              )}
              {domainStatus && (
                <span
                  style={{
                    marginLeft: "0.75rem",
                    padding: "2px 8px",
                    borderRadius: "4px",
                    fontSize: "0.85rem",
                    fontWeight: 500,
                    background:
                      domainStatus === "active" ? "#dcfce7" :
                      domainStatus === "failed" ? "#fee2e2" : "#fef3c7",
                    color:
                      domainStatus === "active" ? "#166534" :
                      domainStatus === "failed" ? "#991b1b" : "#92400e",
                  }}
                >
                  {domainStatus === "active" ? "Active" :
                   domainStatus === "ssl_pending" ? "SSL Provisioning..." :
                   domainStatus === "failed" ? "Failed" : "Pending"}
                </span>
              )}
              {sslStatus && sslStatus !== domainStatus && (
                <span style={{ marginLeft: "0.5rem", fontSize: "0.85rem", color: "var(--color-text-muted, #64748b)" }}>
                  (SSL: {sslStatus})
                </span>
              )}
            </p>
            <div className="settings-actions">
              <button
                className="btn btn-primary"
                onClick={checkDomainStatus}
                disabled={domainChecking}
              >
                {domainChecking ? "Checking..." : "Check Status"}
              </button>
              <button
                className="btn"
                onClick={disconnectDomain}
                disabled={disconnecting}
                style={{ marginLeft: "0.5rem", color: "#991b1b" }}
              >
                {disconnecting ? "Disconnecting..." : "Disconnect"}
              </button>
              {domainError && <span className="auth-error">{domainError}</span>}
            </div>
            {domainStatus === "failed" && (
              <div className="domain-failed-help">
                <p><strong>Verification failed.</strong> Common causes:</p>
                <ul>
                  <li>CNAME record not yet added at your DNS provider, or not yet propagated (DNS can take a few hours).</li>
                  <li>CNAME points somewhere other than <code>origin.cadmus.digital</code> — double-check the value exactly.</li>
                  <li>Proxy/CDN enabled at your DNS provider (turn off proxying; we handle SSL).</li>
                </ul>
                <p>Update your DNS, then click <strong>Check Status</strong>. You can also disconnect and try again with a different domain.</p>
              </div>
            )}
            {(domainStatus === "pending" || domainStatus === "ssl_pending") && (
              <p className="domain-poll-note">
                Waiting for DNS &amp; SSL verification — we check every 15 seconds automatically.
              </p>
            )}
            {dnsInstructions && (
              <div className="settings-domain-instructions" style={{ marginTop: "1rem" }}>
                <p><strong>DNS Setup:</strong></p>
                <table className="content-table dns-records-table">
                  <thead>
                    <tr><th>Type</th><th>Name</th><th>Value</th></tr>
                  </thead>
                  <tbody>
                    {dnsInstructions.map((rec, i) => (
                      <tr key={i}>
                        <td>{rec.type}</td>
                        <td>
                          <span className="dns-cell">
                            <code>{rec.name}</code>
                            <CopyButton text={rec.name} />
                          </span>
                        </td>
                        <td>
                          <span className="dns-cell">
                            <code>{rec.value}</code>
                            <CopyButton text={rec.value} />
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {dnsMessage && (
                  <p style={{ marginTop: "0.75rem", fontSize: "0.9rem", color: "var(--color-text-muted, #64748b)" }}>
                    {dnsMessage}
                  </p>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="settings-form">
            <label>
              Connect Custom Domain
              <input
                type="text"
                value={customDomain}
                onChange={(e) => setCustomDomain(e.target.value)}
                placeholder="example.com"
              />
            </label>
            <div className="settings-actions">
              <button className="btn btn-primary" onClick={connectDomain}>Connect</button>
              {domainError && <span className="auth-error">{domainError}</span>}
            </div>
          </div>
        )}
      </section>

      {/* Site Brief */}
      <section className="settings-section">
        <h3>Site Brief</h3>
        <div className="settings-form">
          <label>
            Business Name
            <input type="text" value={businessName} onChange={(e) => setBusinessName(e.target.value)} />
          </label>
          <label>
            Business Description
            <textarea value={businessDescription} onChange={(e) => setBusinessDescription(e.target.value)} rows={3} />
          </label>
          <label>
            Target Audience
            <input type="text" value={targetAudience} onChange={(e) => setTargetAudience(e.target.value)} />
          </label>
          <label>
            Tone
            <input type="text" value={tone} onChange={(e) => setTone(e.target.value)} placeholder="e.g. professional, friendly, casual" />
          </label>
          <label>
            Primary Goal
            <input type="text" value={primaryGoal} onChange={(e) => setPrimaryGoal(e.target.value)} placeholder="e.g. generate leads, sell products" />
          </label>
          <div className="settings-actions">
            <button className="btn btn-primary" onClick={saveBrief}>Save Brief</button>
            {briefSaved && <span className="settings-success">Saved!</span>}
            {briefError && <span className="auth-error">{briefError}</span>}
          </div>
        </div>
      </section>

      {/* Business Info */}
      <section className="settings-section">
        <h3>Business Info</h3>
        <p style={{ marginBottom: "1rem", fontSize: "0.9rem", color: "var(--color-text-muted)" }}>
          Contact details and address for your site's structured data (helps with SEO and Google Knowledge Panel).
        </p>
        <div className="settings-form">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem" }}>
            <label>
              Contact Email
              <input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="hello@example.com" />
            </label>
            <label>
              Phone Number
              <input type="tel" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} placeholder="+1 (555) 123-4567" />
            </label>
          </div>
          <label>
            Street Address
            <input type="text" value={streetAddress} onChange={(e) => setStreetAddress(e.target.value)} placeholder="123 Main St" />
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: "0.75rem" }}>
            <label>
              City
              <input type="text" value={city} onChange={(e) => setCity(e.target.value)} />
            </label>
            <label>
              State / Province
              <input type="text" value={state} onChange={(e) => setState(e.target.value)} />
            </label>
            <label>
              Postal Code
              <input type="text" value={postalCode} onChange={(e) => setPostalCode(e.target.value)} />
            </label>
          </div>
          <label>
            Country
            <input type="text" value={country} onChange={(e) => setCountry(e.target.value)} placeholder="United States" />
          </label>
          <div className="settings-actions">
            <button
              className="btn btn-primary"
              onClick={async () => {
                if (!siteData) return;
                setBusinessInfoError("");
                setBusinessInfoSaved(false);
                try {
                  const existingSettings = (siteData as unknown as Record<string, unknown>).settings as Record<string, unknown> | undefined;
                  await site.update(siteData.id, {
                    settings: {
                      ...existingSettings,
                      businessInfo: {
                        contactEmail,
                        contactPhone,
                        streetAddress,
                        city,
                        state,
                        postalCode,
                        country,
                      },
                    },
                  });
                  setBusinessInfoSaved(true);
                  setTimeout(() => setBusinessInfoSaved(false), 3000);
                } catch (e) {
                  setBusinessInfoError(e instanceof Error ? e.message : "Failed to save");
                }
              }}
            >
              Save
            </button>
            {businessInfoSaved && <span className="settings-success">Saved!</span>}
            {businessInfoError && <span className="auth-error">{businessInfoError}</span>}
          </div>
        </div>
      </section>

      {/* Social Links */}
      <section className="settings-section">
        <h3>Social Links</h3>
        <p style={{ marginBottom: "1rem", fontSize: "0.9rem", color: "var(--color-text-muted)" }}>
          Links to your social profiles. These appear in your footer and in the Organization schema for SEO.
        </p>
        <div className="settings-form">
          <label>
            Facebook
            <input type="url" value={socialFacebook} onChange={(e) => setSocialFacebook(e.target.value)} placeholder="https://facebook.com/yourpage" />
          </label>
          <label>
            Instagram
            <input type="url" value={socialInstagram} onChange={(e) => setSocialInstagram(e.target.value)} placeholder="https://instagram.com/yourhandle" />
          </label>
          <label>
            X / Twitter
            <input type="url" value={socialTwitter} onChange={(e) => setSocialTwitter(e.target.value)} placeholder="https://x.com/yourhandle" />
          </label>
          <label>
            LinkedIn
            <input type="url" value={socialLinkedIn} onChange={(e) => setSocialLinkedIn(e.target.value)} placeholder="https://linkedin.com/company/yourcompany" />
          </label>
          <label>
            YouTube
            <input type="url" value={socialYouTube} onChange={(e) => setSocialYouTube(e.target.value)} placeholder="https://youtube.com/@yourchannel" />
          </label>
          <label>
            TikTok
            <input type="url" value={socialTikTok} onChange={(e) => setSocialTikTok(e.target.value)} placeholder="https://tiktok.com/@yourhandle" />
          </label>
          <div className="settings-actions">
            <button
              className="btn btn-primary"
              onClick={async () => {
                if (!siteData) return;
                setSocialError("");
                setSocialSaved(false);
                try {
                  const pairs: Array<[string, string]> = [
                    ["facebook", socialFacebook],
                    ["instagram", socialInstagram],
                    ["twitter", socialTwitter],
                    ["linkedin", socialLinkedIn],
                    ["youtube", socialYouTube],
                    ["tiktok", socialTikTok],
                  ];
                  const socialLinks = pairs
                    .map(([platform, url]) => ({ platform, url: url.trim() }))
                    .filter((l) => l.url);
                  const existingSettings = (siteData as unknown as Record<string, unknown>).settings as Record<string, unknown> | undefined;
                  await site.update(siteData.id, {
                    settings: { ...existingSettings, socialLinks },
                  });
                  setSocialSaved(true);
                  setTimeout(() => setSocialSaved(false), 3000);
                } catch (e) {
                  setSocialError(e instanceof Error ? e.message : "Failed to save");
                }
              }}
            >
              Save
            </button>
            {socialSaved && <span className="settings-success">Saved!</span>}
            {socialError && <span className="auth-error">{socialError}</span>}
          </div>
        </div>
      </section>

      {/* Form Defaults */}
      <section className="settings-section">
        <h3>Form Defaults</h3>
        <p style={{ marginBottom: "1rem", fontSize: "0.9rem", color: "var(--color-text-muted)" }}>
          Default settings for forms that don't have their own notification configured (e.g. Stitch design forms).
        </p>
        <div className="settings-form">
          <label>
            Notification Email
            <input
              type="email"
              value={formNotificationEmail}
              onChange={(e) => setFormNotificationEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </label>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={formConfirmationEnabled}
              onChange={(e) => setFormConfirmationEnabled(e.target.checked)}
            />
            Send confirmation email to submitter
          </label>
          {formConfirmationEnabled && (
            <label>
              Confirmation Message
              <textarea
                value={formConfirmationMessage}
                onChange={(e) => setFormConfirmationMessage(e.target.value)}
                placeholder="Thank you for reaching out. We'll get back to you soon."
                rows={3}
              />
            </label>
          )}

          <h4 style={{ margin: "1rem 0 0.25rem" }}>Webhook</h4>
          <p style={{ margin: "0 0 0.5rem", fontSize: "0.85rem", color: "var(--color-text-muted)" }}>
            Default webhook for forms without their own. Individual forms can override this in the page editor.
          </p>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={formWebhookEnabled}
              onChange={(e) => setFormWebhookEnabled(e.target.checked)}
            />
            Send each submission to a webhook URL
          </label>
          {formWebhookEnabled && (
            <label>
              Webhook URL
              <input
                type="url"
                value={formWebhookUrl}
                onChange={(e) => setFormWebhookUrl(e.target.value)}
                placeholder="https://hooks.example.com/forms"
              />
            </label>
          )}
          <div style={{ marginTop: "0.5rem" }}>
            <label style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}>Signing secret</label>
            <p style={{ margin: "0.15rem 0 0.4rem", fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
              We sign every webhook with this secret (HMAC-SHA256 of "&lt;timestamp&gt;.&lt;body&gt;" in the X-Cadmus-Signature header). Use it to verify requests are from us.
            </p>
            {webhookSecret ? (
              <>
                <code style={{ display: "block", padding: "0.4rem 0.6rem", background: "var(--color-surface-2, #f5f5f5)", borderRadius: 4, fontSize: "0.8rem", wordBreak: "break-all" }}>
                  {webhookSecret}
                </code>
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ marginTop: "0.4rem" }}
                  disabled={revealingSecret}
                  onClick={async () => {
                    if (!confirm("Rotate the signing secret? The current secret stops working immediately — any receiver verifying signatures must be updated with the new one.")) return;
                    setRevealingSecret(true);
                    try {
                      const { secret } = await submissions.rotateWebhookSecret();
                      setWebhookSecret(secret);
                    } catch {
                      setFormError("Failed to rotate signing secret");
                    } finally {
                      setRevealingSecret(false);
                    }
                  }}
                >
                  {revealingSecret ? "Rotating…" : "Rotate secret"}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-sm"
                disabled={revealingSecret}
                onClick={async () => {
                  setRevealingSecret(true);
                  try {
                    const { secret } = await submissions.webhookSecret();
                    setWebhookSecret(secret);
                  } catch {
                    setFormError("Failed to load signing secret");
                  } finally {
                    setRevealingSecret(false);
                  }
                }}
              >
                {revealingSecret ? "Loading…" : "Reveal signing secret"}
              </button>
            )}
          </div>

          <div className="settings-actions">
            <button
              className="btn btn-primary"
              onClick={async () => {
                if (!siteData) return;
                setFormError("");
                setFormSaved(false);
                try {
                  const existingSettings = (siteData as unknown as Record<string, unknown>).settings as Record<string, unknown> | undefined;
                  // Preserve any existing formDefaults fields (notably the
                  // server-generated webhookSecret) instead of replacing them.
                  const existingFormDefaults = (existingSettings?.formDefaults as Record<string, unknown> | undefined) ?? {};
                  await site.update(siteData.id, {
                    settings: {
                      ...existingSettings,
                      formDefaults: {
                        ...existingFormDefaults,
                        notificationEmail: formNotificationEmail,
                        confirmationEnabled: formConfirmationEnabled,
                        confirmationMessage: formConfirmationMessage,
                        webhookUrl: formWebhookUrl,
                        webhookEnabled: formWebhookEnabled,
                      },
                    },
                  });
                  setFormSaved(true);
                  setTimeout(() => setFormSaved(false), 3000);
                } catch (e) {
                  setFormError(e instanceof Error ? e.message : "Failed to save");
                }
              }}
            >
              Save
            </button>
            {formSaved && <span className="settings-success">Saved!</span>}
            {formError && <span className="auth-error">{formError}</span>}
          </div>
        </div>
      </section>

      {user?.role === "owner" && (
        <section className="settings-section">
          <h3>Custom Code</h3>
          <p style={{ marginBottom: "0.75rem", fontSize: "0.9rem", color: "var(--color-text-muted)" }}>
            Add analytics, pixels, chat widgets, or verification tags. This code is injected verbatim into every page — it is NOT sanitized, so only paste code from sources you trust. Owner-only.
          </p>
          <div className="settings-form">
            <label>
              Head code <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>(injected into &lt;head&gt; — analytics, meta verification)</span>
              <textarea
                value={customHead}
                onChange={(e) => setCustomHead(e.target.value)}
                placeholder={"<!-- e.g. Google tag (gtag.js) -->\n<script async src=\"https://www.googletagmanager.com/gtag/js?id=G-XXXX\"></script>"}
                rows={5}
                style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.8rem" }}
              />
            </label>
            <label>
              Body end code <span style={{ color: "var(--color-text-muted)", fontWeight: 400 }}>(injected before &lt;/body&gt; — chat widgets, deferred scripts)</span>
              <textarea
                value={customBodyEnd}
                onChange={(e) => setCustomBodyEnd(e.target.value)}
                placeholder={"<!-- e.g. chat widget snippet -->"}
                rows={5}
                style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.8rem" }}
              />
            </label>
            <div className="settings-actions">
              <button
                className="btn btn-primary"
                disabled={customCodeSaving || !siteData}
                onClick={async () => {
                  if (!siteData) return;
                  setCustomCodeError("");
                  setCustomCodeSaved(false);
                  setCustomCodeSaving(true);
                  try {
                    await site.updateCustomCode(siteData.id, { head: customHead, bodyEnd: customBodyEnd });
                    setCustomCodeSaved(true);
                    setTimeout(() => setCustomCodeSaved(false), 3000);
                  } catch (e) {
                    setCustomCodeError(e instanceof Error ? e.message : "Failed to save");
                  } finally {
                    setCustomCodeSaving(false);
                  }
                }}
              >
                {customCodeSaving ? "Saving…" : "Save Custom Code"}
              </button>
              {customCodeSaved && <span className="settings-success">Saved!</span>}
              {customCodeError && <span className="auth-error">{customCodeError}</span>}
            </div>
          </div>
        </section>
      )}

      <WordPressImportSection siteId={siteData?.id ?? null} userId={user?.id ?? null} />

      <ExportSection />

      {/* Debug: AI Preferences */}
      {showDebug && <AIPreferencesSection />}

      {/* Debug: Stitch Import */}
      {showDebug && (
      <section className="settings-section" style={{ borderTop: "2px dashed var(--color-border)" }}>
        <h3>Debug: Import Stitch Project</h3>
        <p style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}>
          Fetch screens from an existing Stitch project and apply them to your pages.
        </p>
        <div className="settings-row">
          <label>Stitch Project ID</label>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <input
              type="text"
              value={stitchProjectId}
              onChange={(e) => setStitchProjectId(e.target.value)}
              placeholder="e.g. 4044680601076201931"
              style={{ flex: 1 }}
            />
            <button
              className="btn btn-secondary"
              disabled={!stitchProjectId.trim() || stitchLoading}
              onClick={async () => {
                setStitchError("");
                setStitchScreens([]);
                setStitchMapping({});
                setStitchDone(null);
                setStitchLoading(true);
                try {
                  const res = await ai.listStitchScreens(stitchProjectId.trim());
                  setStitchScreens(res.screens);
                  if (res.screens.length === 0) {
                    setStitchError("No screens found in this project");
                  }
                } catch (e) {
                  setStitchError(e instanceof Error ? e.message : "Failed to fetch screens");
                } finally {
                  setStitchLoading(false);
                }
              }}
            >
              {stitchLoading ? "Fetching..." : "Fetch Screens"}
            </button>
          </div>
          {stitchError && <span className="auth-error">{stitchError}</span>}
        </div>

        {stitchScreens.length > 0 && !stitchDone && (
          <div style={{ marginTop: "1rem" }}>
            <p style={{ fontWeight: 600, marginBottom: "0.5rem" }}>
              Found {stitchScreens.length} screen(s). Map each to an existing page:
            </p>
            {stitchScreens.map((screen, i) => (
              <div key={screen.screenId} className="settings-row" style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
                {screen.screenshotUrl && (
                  <img
                    src={screen.screenshotUrl}
                    alt={screen.name || `Screen ${i + 1}`}
                    style={{ width: 120, height: 80, objectFit: "cover", borderRadius: 4, border: "1px solid var(--color-border)", flexShrink: 0 }}
                  />
                )}
                <span style={{ minWidth: 150 }}>
                  {screen.name || `Screen ${i + 1}`}
                  <span style={{ fontSize: "0.75rem", color: "var(--color-text-muted)", display: "block" }}>
                    {screen.screenId.slice(0, 12)}...
                  </span>
                </span>
                <select
                  value={stitchMapping[screen.screenId] ?? ""}
                  onChange={(e) =>
                    setStitchMapping((prev) => ({
                      ...prev,
                      [screen.screenId]: e.target.value,
                    }))
                  }
                  style={{ flex: 1 }}
                >
                  <option value="">— Skip (don't apply) —</option>
                  <option value="__post-template__">Blog Post Template</option>
                  {existingPages.map((p) => (
                    <option key={p.id} value={p.id}>
                      /{p.slug} ({p.type})
                    </option>
                  ))}
                </select>
              </div>
            ))}
            {stitchApplying && stitchProgress && (
              <p style={{ fontSize: "0.85rem", color: "var(--color-text-muted)", fontStyle: "italic", margin: "0.5rem 0" }}>
                {stitchProgress}
              </p>
            )}
            <button
              className="btn btn-primary"
              style={{ marginTop: "0.75rem" }}
              disabled={Object.values(stitchMapping).filter(Boolean).length === 0 || stitchApplying}
              onClick={async () => {
                setStitchError("");
                setStitchApplying(true);
                let applied = 0;
                let failed = 0;
                const entries = Object.entries(stitchMapping).filter(([, v]) => v);
                for (let i = 0; i < entries.length; i++) {
                  const [screenId, contentId] = entries[i];
                  const isPostTemplate = contentId === "__post-template__";
                  const screenName = stitchScreens.find((s) => s.screenId === screenId)?.name || screenId.slice(0, 12);
                  const pageName = isPostTemplate ? "Blog Post Template" : existingPages.find((p) => p.id === contentId)?.slug || "page";
                  setStitchProgress(`Applying ${screenName} → ${isPostTemplate ? pageName : `/${pageName}`} (${i + 1}/${entries.length})...`);
                  try {
                    if (isPostTemplate) {
                      await ai.applyStitchScreenAsTemplate(stitchProjectId.trim(), screenId);
                    } else {
                      await ai.applyStitchScreen(stitchProjectId.trim(), screenId, contentId);
                    }
                    applied++;
                  } catch {
                    failed++;
                  }
                }
                setStitchApplying(false);
                setStitchProgress("");
                setStitchDone({ applied, failed });
              }}
            >
              {stitchApplying ? "Applying..." : "Apply to Pages"}
            </button>
          </div>
        )}

        {stitchDone && (
          <div style={{ marginTop: "1rem", padding: "0.75rem", background: stitchDone.failed ? "#fff3e0" : "#e6f9e6", borderRadius: 6 }}>
            <strong>Done!</strong> Applied Stitch designs to {stitchDone.applied} page(s).
            {stitchDone.failed > 0 && ` ${stitchDone.failed} failed.`}
            {stitchDone.applied > 0 && " Refresh your site to see the changes."}
          </div>
        )}
      </section>
      )}

      {/* Debug: Reset Site */}
      {showDebug && (
      <section className="settings-section" style={{ borderTop: "2px dashed var(--color-border)" }}>
        <h3>Debug: Reset Site</h3>
        <p style={{ fontSize: "0.85rem", color: "var(--color-text-muted)", marginBottom: "0.75rem" }}>
          Delete all content, media, collections, navigation, and design settings, then restart onboarding from scratch. Your account and subdomain are preserved.
        </p>
        <button
          className="btn btn-danger"
          disabled={resetting}
          onClick={async () => {
            if (!siteData) return;
            if (!window.confirm("Are you sure? This will permanently delete all site content, media, and settings.")) return;
            setResetting(true);
            try {
              await site.reset(siteData.id);
              navigate("/onboarding");
            } catch {
              setResetting(false);
            }
          }}
        >
          {resetting ? "Resetting..." : "Reset Site & Start Over"}
        </button>
      </section>
      )}

      {/* Platform Admin: Theme Debug */}
      {user?.globalRole === "cadmus_admin" && (
      <section className="settings-section" style={{ borderTop: "2px dashed var(--color-border)" }}>
        <h3>Platform Admin: Theme Debug</h3>
        <p style={{ fontSize: "0.85rem", color: "var(--color-text-muted)", marginBottom: "0.75rem" }}>
          Inspect the compiled theme (fonts, header/footer, CSS coverage) and recompile Tailwind from the current blocks.
        </p>
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginBottom: "0.75rem" }}>
          <button
            className="btn btn-secondary"
            disabled={themeDebugLoading}
            onClick={async () => {
              if (!siteData) return;
              setThemeDebugError("");
              setThemeDebugLoading(true);
              try {
                const data = await platformAdmin.themeDebug(siteData.id);
                setThemeDebugData(data);
              } catch (err) {
                setThemeDebugError(err instanceof Error ? err.message : "Failed to load theme debug info");
              } finally {
                setThemeDebugLoading(false);
              }
            }}
          >
            {themeDebugLoading ? "Loading..." : "Load Theme Debug Info"}
          </button>
          <button
            className="btn btn-primary"
            disabled={recompiling}
            onClick={async () => {
              if (!siteData) return;
              setRecompileError("");
              setRecompileResult(null);
              setRecompiling(true);
              try {
                const result = await platformAdmin.recompileTheme(siteData.id);
                setRecompileResult(result);
              } catch (err) {
                setRecompileError(err instanceof Error ? err.message : "Recompile failed");
              } finally {
                setRecompiling(false);
              }
            }}
          >
            {recompiling ? "Recompiling..." : "Recompile Theme"}
          </button>
        </div>
        {themeDebugError && (
          <div className="auth-error" style={{ marginBottom: "0.75rem" }}>{themeDebugError}</div>
        )}
        {recompileError && (
          <div className="auth-error" style={{ marginBottom: "0.75rem" }}>{recompileError}</div>
        )}
        {recompileResult && (
          <div style={{ marginBottom: "0.75rem", padding: "0.75rem", background: "#e6f9e6", borderRadius: 6, fontSize: "0.85rem" }}>
            <strong>Recompiled.</strong> Compiled CSS: {recompileResult.beforeBytes} → {recompileResult.afterBytes} bytes across {recompileResult.blockCount} block(s).
          </div>
        )}
        {themeDebugData && (
          <pre
            style={{
              background: "var(--color-bg)",
              border: "1px solid var(--color-border)",
              borderRadius: 6,
              padding: "0.75rem",
              fontSize: "0.75rem",
              maxHeight: "400px",
              overflow: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {JSON.stringify(themeDebugData, null, 2)}
          </pre>
        )}
      </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WordPress Import Section
// ---------------------------------------------------------------------------

type ImportStep = "entry" | "options" | "running" | "done";

function WordPressImportSection({ siteId, userId }: { siteId: string | null; userId: string | null }) {
  const [step, setStep] = useState<ImportStep>("entry");
  const [billingStatus, setBillingStatus] = useState<BillingStatus | null>(null);
  const [billingLoading, setBillingLoading] = useState(true);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [existingCollections, setExistingCollections] = useState<Array<{ id: string; name: string; slug: string }>>([]);

  // Step 1: file + analyze
  const [file, setFile] = useState<File | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analyzeError, setAnalyzeError] = useState("");
  const [analyzeResult, setAnalyzeResult] = useState<WpAnalyzeResult | null>(null);

  // Step 2: options
  const [importDrafts, setImportDrafts] = useState(false);
  const [importMedia, setImportMedia] = useState(false);
  const [authorMap, setAuthorMap] = useState<Record<string, string>>({});
  const [categoryMap, setCategoryMap] = useState<Record<string, "new" | string>>({});
  const [includePostTypes, setIncludePostTypes] = useState<("post" | "page")[]>(["post", "page"]);
  const [startError, setStartError] = useState("");

  // Step 3: polling
  const [jobId, setJobId] = useState<string | null>(null);
  const [pollStatus, setPollStatus] = useState<{ status: string; progress: number; total: number } | null>(null);

  // Step 4: result
  const [importResult, setImportResult] = useState<WpImportResult | null>(null);

  const storageKey = siteId ? `wp_import_${siteId}` : null;

  useEffect(() => {
    billing.status().then((s) => setBillingStatus(s)).catch(() => {}).finally(() => setBillingLoading(false));
    team.list().then((r) => setTeamMembers(r.members)).catch(() => {});
    if (siteId) {
      collectionsApi.list("category")
        .then((r) => {
          const items = (r.items as Array<{ id: string; name: string; slug: string; type: string }>) || [];
          setExistingCollections(items.map((c) => ({ id: c.id, name: c.name, slug: c.slug })));
        })
        .catch(() => {});

      // Restore in-progress or completed job from a previous visit
      const saved = storageKey ? localStorage.getItem(storageKey) : null;
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as { jobId: string; result?: WpImportResult };
          setJobId(parsed.jobId);
          if (parsed.result) {
            setImportResult(parsed.result);
            setStep("done");
          } else {
            setStep("running");
          }
        } catch {
          // corrupt entry — ignore
        }
      }
    }
  }, [siteId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Initialize category map when analyze result arrives
  useEffect(() => {
    if (!analyzeResult) return;
    const map: Record<string, "new" | string> = {};
    for (const cat of analyzeResult.categories) {
      map[cat.slug] = "new";
    }
    setCategoryMap(map);

    const amap: Record<string, string> = {};
    for (const author of analyzeResult.authors) {
      amap[author.login] = "owner";
    }
    setAuthorMap(amap);
  }, [analyzeResult]);

  // Poll job status
  useEffect(() => {
    if (step !== "running" || !jobId || !siteId) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const s = await importWP.jobStatus(siteId, jobId);
        if (cancelled) return;
        setPollStatus({ status: s.status, progress: s.progress, total: s.total });
        if (s.status === "completed" || s.status === "failed") {
          setImportResult(s.result);
          setStep("done");
          if (storageKey) {
            localStorage.setItem(storageKey, JSON.stringify({ jobId, result: s.result }));
          }
        }
      } catch {
        // ignore transient poll errors
      }
    };

    poll();
    const interval = setInterval(poll, 2000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [step, jobId, siteId]);

  const MAX_UPLOAD_MB = 25;

  const handleAnalyze = async () => {
    if (!file || !siteId) return;
    setAnalyzeError("");

    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      setAnalyzeError(
        `This file is ${(file.size / 1024 / 1024).toFixed(0)} MB, which exceeds the 25 MB upload limit. ` +
        `In WordPress, go to Tools → Export and use the filters to export posts, pages, and media separately.`
      );
      return;
    }

    setAnalyzing(true);
    try {
      const result = await importWP.analyze(siteId, file);
      setAnalyzeResult(result);
      setStep("options");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      setAnalyzeError(
        msg.includes("413") || msg.toLowerCase().includes("too large")
          ? `File is too large (max ${MAX_UPLOAD_MB} MB). In WordPress, go to Tools → Export and export posts, pages, and media separately.`
          : msg || "Failed to analyze the file. Make sure it is a valid WordPress XML export."
      );
    } finally {
      setAnalyzing(false);
    }
  };

  const handleStart = async () => {
    if (!analyzeResult || !siteId) return;
    setStartError("");
    const options: WpImportOptions = {
      importDrafts,
      importMedia,
      authorMap,
      categoryMap,
      includePostTypes,
    };
    try {
      const res = await importWP.start(siteId, analyzeResult.jobId, options);
      setJobId(res.jobId);
      setStep("running");
      if (storageKey) {
        localStorage.setItem(storageKey, JSON.stringify({ jobId: res.jobId }));
      }
    } catch (err) {
      setStartError(err instanceof Error ? err.message : "Failed to start import");
    }
  };

  const handleReset = () => {
    if (storageKey) localStorage.removeItem(storageKey);
    setStep("entry");
    setFile(null);
    setAnalyzeResult(null);
    setAnalyzing(false);
    setAnalyzeError("");
    setStartError("");
    setJobId(null);
    setPollStatus(null);
    setImportResult(null);
    setImportDrafts(false);
    setImportMedia(false);
    setAuthorMap({});
    setCategoryMap({});
    setIncludePostTypes(["post", "page"]);
  };

  if (billingLoading) {
    return (
      <section className="settings-section">
        <h3>Import from WordPress</h3>
        <p>Loading...</p>
      </section>
    );
  }

  const hasPaymentMethod = billingStatus?.hasPaymentMethod ?? false;

  return (
    <section className="settings-section">
      <h3>Import from WordPress</h3>
      <p style={{ marginBottom: "1rem", fontSize: "0.9rem", color: "var(--color-text-muted)" }}>
        Import posts, pages, and media from a WordPress XML export (WXR) file.
        Go to WordPress Admin → Tools → Export to download your export file.
      </p>

      {!hasPaymentMethod && (
        <div style={{
          padding: "1rem",
          background: "var(--color-bg-subtle, #f5f5f5)",
          border: "1px solid var(--color-border)",
          borderRadius: "6px",
          display: "flex",
          gap: "0.75rem",
          alignItems: "flex-start",
        }}>
          <span style={{ fontSize: "1.25rem" }}>🔒</span>
          <p style={{ margin: 0, fontSize: "0.9rem" }}>
            A payment method is required to use the importer. Add one in the Account section.
          </p>
        </div>
      )}

      {hasPaymentMethod && step === "entry" && (
        <div className="settings-form">
          <label>
            WordPress Export File (.xml)
            <input
              type="file"
              accept=".xml,application/xml,text/xml"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          {analyzeError && <div className="auth-error">{analyzeError}</div>}
          <div className="settings-actions">
            <button
              className="btn btn-primary"
              disabled={!file || analyzing}
              onClick={handleAnalyze}
            >
              {analyzing ? "Analyzing..." : "Analyze File"}
            </button>
          </div>
        </div>
      )}

      {hasPaymentMethod && step === "options" && analyzeResult && (
        <div className="settings-form">
          <div style={{ padding: "0.75rem", background: "var(--color-bg-subtle, #f5f5f5)", borderRadius: "6px", marginBottom: "1rem" }}>
            <strong>Found:</strong>{" "}
            {analyzeResult.postCount} posts, {analyzeResult.pageCount} pages, {analyzeResult.attachmentCount} attachments
          </div>

          {analyzeResult.hasMedia && (
            <div style={{ padding: "0.75rem", background: "#fefce8", border: "1px solid #fde68a", borderRadius: "6px", fontSize: "0.9rem", marginBottom: "1rem" }}>
              Media import requires your original WordPress site to still be accessible.
              Dead links will be skipped and logged.
            </div>
          )}

          <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
            <legend style={{ fontWeight: 600, marginBottom: "0.5rem" }}>Content to import</legend>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={includePostTypes.includes("post")}
                onChange={(e) => {
                  if (e.target.checked) setIncludePostTypes((p) => [...p, "post"]);
                  else setIncludePostTypes((p) => p.filter((t) => t !== "post"));
                }}
              />
              Posts ({analyzeResult.postCount})
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={includePostTypes.includes("page")}
                onChange={(e) => {
                  if (e.target.checked) setIncludePostTypes((p) => [...p, "page"]);
                  else setIncludePostTypes((p) => p.filter((t) => t !== "page"));
                }}
              />
              Pages ({analyzeResult.pageCount})
            </label>
          </fieldset>

          <label className="checkbox-label" style={{ marginTop: "0.5rem" }}>
            <input
              type="checkbox"
              checked={importDrafts}
              onChange={(e) => setImportDrafts(e.target.checked)}
            />
            Import draft posts/pages
          </label>

          {analyzeResult.hasMedia && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={importMedia}
                onChange={(e) => setImportMedia(e.target.checked)}
              />
              Import media files to Cadmus
            </label>
          )}

          {analyzeResult.authors.length > 1 && teamMembers.length > 1 && (
            <div>
              <p style={{ fontWeight: 600, marginBottom: "0.5rem" }}>Author Mapping</p>
              {analyzeResult.authors.map((author) => (
                <div key={author.login} style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.5rem" }}>
                  <span style={{ minWidth: "150px", fontSize: "0.9rem" }}>{author.displayName} ({author.login})</span>
                  <select
                    value={authorMap[author.login] ?? "owner"}
                    onChange={(e) => setAuthorMap((prev) => ({ ...prev, [author.login]: e.target.value }))}
                    style={{ flex: 1 }}
                  >
                    <option value="owner">Owner</option>
                    {teamMembers.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.firstName || m.email} {m.lastName || ""} ({m.role})
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}

          {analyzeResult.categories.length > 0 && (
            <div>
              <p style={{ fontWeight: 600, marginBottom: "0.5rem" }}>Category Mapping</p>
              {analyzeResult.categories.map((cat) => (
                <div key={cat.slug} style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "0.5rem" }}>
                  <span style={{ minWidth: "150px", fontSize: "0.9rem" }}>
                    {cat.name}
                    {cat.postCount > 0 && <span style={{ color: "var(--color-text-muted)", fontSize: "0.8rem" }}> ({cat.postCount})</span>}
                  </span>
                  <select
                    value={categoryMap[cat.slug] ?? "new"}
                    onChange={(e) => setCategoryMap((prev) => ({ ...prev, [cat.slug]: e.target.value as "new" | string }))}
                    style={{ flex: 1 }}
                  >
                    <option value="new">Create new collection</option>
                    {existingCollections.map((c) => (
                      <option key={c.id} value={c.id}>{c.name} (/{c.slug})</option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}

          {startError && <div className="auth-error">{startError}</div>}

          <div className="settings-actions">
            <button
              className="btn btn-primary"
              disabled={includePostTypes.length === 0}
              onClick={handleStart}
            >
              Start Import
            </button>
            <button className="btn" onClick={handleReset} style={{ marginLeft: "0.5rem" }}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {hasPaymentMethod && step === "running" && (
        <div>
          <p style={{ marginBottom: "0.5rem", fontWeight: 500 }}>
            Importing...{pollStatus ? ` (${pollStatus.progress} of ${pollStatus.total})` : ""}
          </p>
          <div style={{
            height: "8px",
            background: "var(--color-bg-subtle, #f5f5f5)",
            borderRadius: "4px",
            overflow: "hidden",
            marginBottom: "0.75rem",
          }}>
            <div
              style={{
                height: "100%",
                background: "var(--color-primary)",
                width: pollStatus && pollStatus.total > 0
                  ? `${Math.round((pollStatus.progress / pollStatus.total) * 100)}%`
                  : "0%",
                transition: "width 0.3s ease",
              }}
            />
          </div>
          <p style={{ fontSize: "0.85rem", color: "var(--color-text-muted)" }}>
            This may take a few minutes. You can leave this page — the import will continue in the background.
          </p>
        </div>
      )}

      {hasPaymentMethod && step === "done" && (
        <div>
          <div style={{
            padding: "1rem",
            background: importResult && !importResult.otherErrors?.length ? "#dcfce7" : "#fff3e0",
            border: `1px solid ${importResult && !importResult.otherErrors?.length ? "#bbf7d0" : "#fde68a"}`,
            borderRadius: "6px",
            marginBottom: "1rem",
          }}>
            {importResult ? (
              <>
                <p style={{ fontWeight: 600, marginBottom: "0.5rem" }}>Import complete</p>
                <p>
                  Imported: {importResult.imported.posts} posts, {importResult.imported.pages} pages
                  {importResult.imported.media > 0 && `, ${importResult.imported.media} media files`}
                </p>
                {importResult.skipped > 0 && <p>Skipped: {importResult.skipped} items</p>}
              </>
            ) : (
              <p style={{ fontWeight: 600 }}>Import failed</p>
            )}
          </div>

          {importResult?.renamedSlugs && importResult.renamedSlugs.length > 0 && (
            <details style={{ marginBottom: "0.75rem" }}>
              <summary style={{ cursor: "pointer", fontWeight: 500, marginBottom: "0.5rem" }}>
                Renamed slugs ({importResult.renamedSlugs.length})
              </summary>
              <ul style={{ fontSize: "0.85rem", paddingLeft: "1.25rem", margin: "0.5rem 0" }}>
                {importResult.renamedSlugs.map((r, i) => (
                  <li key={i}>{r.title}: <code>{r.originalSlug}</code> → <code>{r.newSlug}</code></li>
                ))}
              </ul>
            </details>
          )}

          {importResult?.mediaErrors && importResult.mediaErrors.length > 0 && (
            <details style={{ marginBottom: "0.75rem" }}>
              <summary style={{ cursor: "pointer", fontWeight: 500, marginBottom: "0.5rem" }}>
                Media errors ({importResult.mediaErrors.length})
              </summary>
              <ul style={{ fontSize: "0.85rem", paddingLeft: "1.25rem", margin: "0.5rem 0" }}>
                {importResult.mediaErrors.map((e, i) => (
                  <li key={i}><code>{e.url}</code>: {e.reason}</li>
                ))}
              </ul>
            </details>
          )}

          {importResult?.otherErrors && importResult.otherErrors.length > 0 && (
            <details style={{ marginBottom: "0.75rem" }}>
              <summary style={{ cursor: "pointer", fontWeight: 500, marginBottom: "0.5rem" }}>
                Other errors ({importResult.otherErrors.length})
              </summary>
              <ul style={{ fontSize: "0.85rem", paddingLeft: "1.25rem", margin: "0.5rem 0" }}>
                {importResult.otherErrors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </details>
          )}

          <button className="btn btn-secondary" onClick={handleReset}>
            Start another import
          </button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Export Section
// ---------------------------------------------------------------------------

type ExportFormat = "html" | "json";

const EXPORT_CATEGORIES = [
  { id: "content", label: "Content", description: "All pages, posts, and their blocks" },
  { id: "submissions", label: "Form Submissions", description: "All form submission data" },
  { id: "settings", label: "Site Settings", description: "Name, brief, theme, and configuration" },
  { id: "collections", label: "Collections", description: "Categories, tags, and content groupings" },
  { id: "navigation", label: "Navigation", description: "Menu items and structure" },
  { id: "media", label: "Media", description: "Image and file metadata (not the files themselves)" },
];

function ExportSection() {
  const [format, setFormat] = useState<ExportFormat>("html");
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(
    new Set(EXPORT_CATEGORIES.map((c) => c.id))
  );
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");

  const allSelected = selectedCategories.size === EXPORT_CATEGORIES.length;

  const toggleCategory = useCallback((id: string) => {
    setSelectedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (allSelected) setSelectedCategories(new Set());
    else setSelectedCategories(new Set(EXPORT_CATEGORIES.map((c) => c.id)));
  }, [allSelected]);

  async function handleExport() {
    setError("");
    if (format === "json" && selectedCategories.size === 0) {
      setError("Select at least one category to export.");
      return;
    }

    setExporting(true);
    try {
      const params = new URLSearchParams({ format });
      if (format === "json") {
        params.set("categories", Array.from(selectedCategories).join(","));
      }

      const res = await apiRawFetch(`/api/export?${params}`);

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || `Export failed (${res.status})`);
      }

      const disposition = res.headers.get("Content-Disposition") || "";
      const filenameMatch = disposition.match(/filename="?([^"]+)"?/);
      const fallbackExt = format === "html" ? "zip" : "json";
      const filename = filenameMatch?.[1] || `export.${fallbackExt}`;

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className="settings-section">
      <h3>Export</h3>
      <p style={{ marginBottom: "1rem", fontSize: "0.9rem", color: "var(--color-text-muted)" }}>
        Download your site data for backup or migration.
      </p>

      <div style={{ display: "flex", gap: "0.75rem", marginBottom: "1rem" }}>
        <button
          type="button"
          className={`variant-chip${format === "html" ? " active" : ""}`}
          onClick={() => setFormat("html")}
        >
          HTML
        </button>
        <button
          type="button"
          className={`variant-chip${format === "json" ? " active" : ""}`}
          onClick={() => setFormat("json")}
        >
          JSON
        </button>
      </div>

      {format === "html" && (
        <p style={{ fontSize: "0.9rem", color: "var(--color-text-muted)" }}>
          Exports all pages as a single self-contained HTML file with embedded styles. Suitable for archiving or viewing offline.
        </p>
      )}

      {format === "json" && (
        <div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem" }}>
            <span style={{ fontWeight: 500, fontSize: "0.9rem" }}>Data to include</span>
            <button
              type="button"
              onClick={toggleAll}
              style={{
                background: "none",
                border: "none",
                color: "var(--color-primary)",
                cursor: "pointer",
                fontSize: "0.85rem",
                textDecoration: "underline",
                padding: 0,
              }}
            >
              {allSelected ? "Deselect all" : "Select all"}
            </button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {EXPORT_CATEGORIES.map((cat) => (
              <label
                key={cat.id}
                className="checkbox-label"
                style={{
                  padding: "0.75rem",
                  border: "1px solid var(--color-border)",
                  borderRadius: "6px",
                  cursor: "pointer",
                  background: selectedCategories.has(cat.id) ? "var(--color-bg)" : "transparent",
                }}
              >
                <input
                  type="checkbox"
                  checked={selectedCategories.has(cat.id)}
                  onChange={() => toggleCategory(cat.id)}
                />
                <div>
                  <div style={{ fontWeight: 500 }}>{cat.label}</div>
                  <div style={{ fontSize: "0.8rem", color: "var(--color-text-muted)" }}>
                    {cat.description}
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div style={{
          marginTop: "1rem",
          padding: "0.75rem",
          background: "#fef2f2",
          border: "1px solid #fecaca",
          borderRadius: "6px",
          color: "#dc2626",
          fontSize: "0.9rem",
        }}>
          {error}
        </div>
      )}

      <div style={{ marginTop: "1.5rem" }}>
        <button
          className="btn btn-primary"
          onClick={handleExport}
          disabled={exporting || (format === "json" && selectedCategories.size === 0)}
        >
          {exporting ? "Exporting..." : `Export as ${format.toUpperCase()}`}
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// AI Preferences Section
// ---------------------------------------------------------------------------

const TEXT_MODELS = [
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Anthropic)" },
  { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash (Google)" },
];

const IMAGE_MODELS = [
  { value: "imagen-4.0-generate-001", label: "Imagen 4.0 (Google)" },
  { value: "imagen-4.0-fast-generate-001", label: "Imagen 4.0 Fast (Google)" },
  { value: "imagen-4.0-ultra-generate-001", label: "Imagen 4.0 Ultra (Google)" },
];

function AIPreferencesSection() {
  const [textModel, setTextModel] = useState("claude-sonnet-4-6");
  const [imageModel, setImageModel] = useState("imagen-4.0-generate-001");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    ai.getPreferences()
      .then((res) => {
        const prefs = res.preferences || {};
        if (prefs.textModel) setTextModel(prefs.textModel);
        if (prefs.imageModel) setImageModel(prefs.imageModel);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setStatusMsg(null);
    try {
      await ai.updatePreferences({ textModel, imageModel });
      setStatusMsg("Preferences saved.");
    } catch {
      setStatusMsg("Failed to save preferences.");
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return null;

  return (
    <section className="settings-section" style={{ borderTop: "2px dashed var(--color-border)" }}>
      <h3>Debug: AI Preferences</h3>
      <p>Choose your preferred AI models for different tasks.</p>
      <div className="settings-form">
        <label>
          Text Generation Model
          <select value={textModel} onChange={(e) => setTextModel(e.target.value)}>
            {TEXT_MODELS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </label>
        <label>
          Image Generation Model
          <select value={imageModel} onChange={(e) => setImageModel(e.target.value)}>
            {IMAGE_MODELS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </label>
        <div className="settings-actions">
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save Preferences"}
          </button>
          {statusMsg && <span className={statusMsg.includes("Failed") ? "auth-error" : "settings-success"}>{statusMsg}</span>}
        </div>
      </div>
    </section>
  );
}
