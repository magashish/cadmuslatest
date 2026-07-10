import { useState, useEffect, useRef, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { auth } from "../lib/api";

type AvailabilityState = "idle" | "checking" | "available" | "taken" | "invalid";

function isValidSubdomainClient(sub: string): boolean {
  if (sub.length < 3 || sub.length > 40) return false;
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(sub) && !/^[a-z0-9]$/.test(sub)) return false;
  return true;
}

export function SubdomainSetup() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [subdomain, setSubdomain] = useState("");
  const [availability, setAvailability] = useState<AvailabilityState>("idle");
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!user) {
      navigate("/login", { replace: true });
    }
  }, [user, navigate]);

  // Debounced availability check
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (!subdomain) {
      setAvailability("idle");
      setSuggestion(null);
      return;
    }

    const normalized = subdomain.toLowerCase();
    if (!isValidSubdomainClient(normalized)) {
      setAvailability("invalid");
      setSuggestion(null);
      return;
    }

    setAvailability("checking");
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await auth.checkSubdomain(normalized);
        if (res.available) {
          setAvailability("available");
          setSuggestion(null);
        } else {
          setAvailability("taken");
          setSuggestion(res.suggestion ?? null);
        }
      } catch {
        setAvailability("idle");
      }
    }, 400);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [subdomain]);

  const handlePickForMe = async () => {
    try {
      const res = await auth.suggestSubdomain();
      setSubdomain(res.subdomain);
    } catch {
      // ignore
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    const normalized = subdomain.toLowerCase().trim();
    if (availability !== "available") {
      setError("Please choose an available subdomain first.");
      return;
    }
    setSubmitting(true);
    try {
      await auth.setSubdomain(normalized);
      navigate("/verify-email");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set subdomain");
    } finally {
      setSubmitting(false);
    }
  };

  const baseDomain = (import.meta.env.VITE_BASE_DOMAIN as string | undefined) || "cadmus.digital";
  const subdomainSuffix = baseDomain === "cadmus.digital" ? `.cadmus.digital` : `--dev.cadmus.digital`;

  const availabilityIndicator = () => {
    switch (availability) {
      case "checking":
        return <span className="subdomain-status checking">Checking...</span>;
      case "available":
        return <span className="subdomain-status available">Available</span>;
      case "taken":
        return (
          <span className="subdomain-status taken">
            Taken
            {suggestion && (
              <>
                {" "}— try{" "}
                <button
                  type="button"
                  className="subdomain-suggestion-link"
                  onClick={() => setSubdomain(suggestion)}
                >
                  {suggestion}
                </button>
              </>
            )}
          </span>
        );
      case "invalid":
        return <span className="subdomain-status invalid">Use 3–40 lowercase letters, numbers, or hyphens</span>;
      default:
        return null;
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Cadmus</h1>
        <h2>Choose your subdomain</h2>
        <p className="auth-description">
          This will be your site's address on Cadmus. You can connect a custom domain later.
        </p>
        {error && <div className="auth-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Subdomain</label>
            <div className="subdomain-input-wrap">
              <input
                type="text"
                value={subdomain}
                onChange={(e) => setSubdomain(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                placeholder="my-site"
                required
                autoFocus
                autoComplete="off"
                spellCheck={false}
              />
              <span className="subdomain-suffix">{subdomainSuffix}</span>
            </div>
            <div className="subdomain-availability">{availabilityIndicator()}</div>
          </div>
          <button
            type="button"
            className="btn btn-secondary btn-full"
            onClick={handlePickForMe}
            style={{ marginBottom: "0.75rem" }}
          >
            Pick one for me
          </button>
          <button
            type="submit"
            className="btn btn-primary btn-full"
            disabled={submitting || availability !== "available"}
          >
            {submitting ? "Saving..." : "Continue"}
          </button>
        </form>
      </div>
    </div>
  );
}
