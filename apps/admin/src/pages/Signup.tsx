import { useState, useEffect, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { auth, billing, type BillingPlanDetails } from "../lib/api";
import { PasswordStrengthMeter, meetsPasswordRequirements } from "../components/PasswordStrengthMeter";

type PromoInfo = {
  valid: boolean;
  reason?: string;
  name?: string;
  trialDays?: number;
  planOverride?: string;
};

export function Signup() {
  const { provision } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const promoCodeParam = searchParams.get("promo") || "";
  const refParam = searchParams.get("ref") || "";
  const clientParam = searchParams.get("client") || "";
  const planParam = searchParams.get("plan");
  const initialPlan = planParam === "annual" ? "annual" : planParam === "monthly" ? "monthly" : null;
  // Paid intent: an explicit monthly/annual plan, or the generic "pro" alias (shows toggle, defaults to monthly)
  const isPaidIntent = initialPlan !== null || planParam === "pro";
  // Pro mode: paid intent without a promo code
  const isPro = isPaidIntent && !promoCodeParam;

  const [siteName, setSiteName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [selectedPlan, setSelectedPlan] = useState<"monthly" | "annual">(initialPlan ?? "monthly");
  const [plans, setPlans] = useState<BillingPlanDetails[]>([]);
  const [promoInfo, setPromoInfo] = useState<PromoInfo | null>(null);
  const [promoLoading, setPromoLoading] = useState(false);
  // Agency disclosure for ?client= links — name of the partner who will get
  // admin access and manage billing. null = no valid client code.
  const [agencyName, setAgencyName] = useState<string | null>(null);
  const [error, setError] = useState<ReactNode>("");
  const [submitting, setSubmitting] = useState(false);

  // Fetch plan amounts for the paid toggle (public endpoint; single source = PLAN_CATALOG on the API)
  useEffect(() => {
    if (!isPro) return;
    billing.plans().then((res) => setPlans(res.plans)).catch(() => {});
  }, [isPro]);

  const priceLabel = (plan: "monthly" | "annual") => {
    const p = plans.find((x) => x.plan === plan);
    if (!p) return "";
    return `$${p.amountUsd}/${p.interval === "year" ? "year" : "month"}`;
  };

  // Persist a ?ref= referral/partner code so it survives a reload of this page
  // (and the Stripe round-trip on paid signups) until the account is created.
  useEffect(() => {
    if (refParam) localStorage.setItem("cadmus_ref", refParam);
  }, [refParam]);

  // Persist + resolve a ?client= agency code. Only valid codes show the
  // disclosure banner; invalid ones degrade to a normal signup.
  useEffect(() => {
    if (!clientParam) return;
    localStorage.setItem("cadmus_client", clientParam);
    auth.partnerInfo(clientParam)
      .then((res) => setAgencyName(res.valid && res.name ? res.name : null))
      .catch(() => setAgencyName(null));
  }, [clientParam]);

  // Fetch promo details when a promo code is in the URL
  useEffect(() => {
    if (!promoCodeParam) return;
    setPromoLoading(true);
    auth.promoInfo(promoCodeParam)
      .then(setPromoInfo)
      .catch(() => setPromoInfo({ valid: false, reason: "Could not load promotion details." }))
      .finally(() => setPromoLoading(false));
  }, [promoCodeParam]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (!meetsPasswordRequirements(password)) {
      setError("Please meet all password requirements");
      return;
    }
    setSubmitting(true);
    try {
      const referralCode = refParam || localStorage.getItem("cadmus_ref") || undefined;
      // Only send the client code when the disclosure banner was actually shown
      // — the user must see what they're agreeing to.
      const clientCode = agencyName ? (clientParam || localStorage.getItem("cadmus_client") || undefined) : undefined;
      const { promoApplied } = await provision(siteName, email, password, promoCodeParam || undefined, referralCode, clientCode);
      // Attribution is recorded server-side at signup; clear the stored codes.
      localStorage.removeItem("cadmus_ref");
      localStorage.removeItem("cadmus_client");

      if (promoApplied) {
        // Promo applied — no Stripe needed, go straight to onboarding
        navigate("/signup/subdomain");
      } else if (isPro) {
        // Paid signup — redirect to Stripe Checkout
        const res = await billing.createCheckoutSession({
          successUrl: `${window.location.origin}/signup/subdomain?subscribed=1`,
          cancelUrl: `${window.location.origin}/signup?plan=${selectedPlan}`,
          plan: selectedPlan,
        });
        window.location.href = res.url;
      } else {
        navigate("/signup/subdomain");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Signup failed";
      if (msg.includes("already exists")) {
        setError(<>An account with this email already exists. <Link to="/login">Sign in instead</Link></>);
      } else {
        setError(msg);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const hasValidPromo = promoInfo?.valid === true;
  const showPromo = !!promoCodeParam && !promoLoading;

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Cadmus</h1>
        <h2>
          {hasValidPromo
            ? `Claim your ${promoInfo!.trialDays}-day free trial`
            : isPro
              ? "Start your Pro plan"
              : "Create a site that actually works"}
        </h2>

        {/* Promo offer banner */}
        {showPromo && hasValidPromo && (
          <div className="promo-banner">
            <strong>{promoInfo!.name}</strong>
            <span>{promoInfo!.trialDays} days of Pro, free — no credit card required.</span>
          </div>
        )}
        {showPromo && !hasValidPromo && (
          <div className="auth-error">
            {promoInfo?.reason || "This promotion is not valid."} You can still sign up for a free account.
          </div>
        )}

        {/* Agency disclosure — the consent moment for ?client= invite links */}
        {agencyName && (
          <div className="promo-banner">
            <strong>You're signing up with {agencyName}</strong>
            <span>
              {agencyName} will be added to your site as an administrator and will manage the site and its billing on your behalf.
            </span>
          </div>
        )}

        {/* Paid plan toggle (only shown for ?plan= without a promo) */}
        {isPro && (
          <div className="plan-toggle">
            <button
              type="button"
              className={`plan-toggle__option${selectedPlan === "monthly" ? " active" : ""}`}
              onClick={() => setSelectedPlan("monthly")}
            >
              Monthly
              {priceLabel("monthly") && <span className="plan-toggle__price">{priceLabel("monthly")}</span>}
            </button>
            <button
              type="button"
              className={`plan-toggle__option${selectedPlan === "annual" ? " active" : ""}`}
              onClick={() => setSelectedPlan("annual")}
            >
              Annual <span className="plan-toggle__badge">Save ~17%</span>
              {priceLabel("annual") && <span className="plan-toggle__price">{priceLabel("annual")}</span>}
            </button>
          </div>
        )}

        {error && <div className="auth-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Site Name</label>
            <input
              type="text"
              value={siteName}
              onChange={(e) => setSiteName(e.target.value)}
              placeholder="My New Site"
              required
              autoFocus
            />
          </div>
          <div className="form-group">
            <label>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="form-group">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={12}
            />
            <PasswordStrengthMeter password={password} />
          </div>
          <button type="submit" className="btn btn-primary btn-full" disabled={submitting || promoLoading}>
            {submitting
              ? hasValidPromo ? "Activating your trial..." : isPro ? "Setting up your account..." : "Creating your site..."
              : hasValidPromo ? "Activate free trial"
              : isPro ? "Continue to payment →"
              : "Create free site"}
          </button>
        </form>

        {isPro && (
          <p className="auth-link">
            Just want the free plan? <Link to="/signup">Sign up for free</Link>
          </p>
        )}
        <p className="auth-link">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
