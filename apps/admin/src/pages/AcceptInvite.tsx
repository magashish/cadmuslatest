import { useState, useEffect } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { PasswordStrengthMeter, meetsPasswordRequirements } from "../components/PasswordStrengthMeter";

const API = import.meta.env.VITE_API_URL || "";

export function AcceptInvite() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get("token") || "";

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [validating, setValidating] = useState(true);
  const [error, setError] = useState("");
  const [invalidMessage, setInvalidMessage] = useState("");
  const [hasPassword, setHasPassword] = useState(false);
  const [email, setEmail] = useState("");

  // Validate token on page load
  useEffect(() => {
    if (!token) {
      setInvalidMessage("This invitation link is missing or invalid.");
      setValidating(false);
      return;
    }

    fetch(`${API}/api/team/validate-invite?token=${encodeURIComponent(token)}`)
      .then((res) => res.json())
      .then((data) => {
        if (!data.valid) {
          setInvalidMessage(data.error || "This invitation link is invalid or has expired.");
        } else {
          setHasPassword(data.hasPassword);
          setEmail(data.email || "");
        }
      })
      .catch(() => {
        setInvalidMessage("Something went wrong. Please try again later.");
      })
      .finally(() => setValidating(false));
  }, [token]);

  const handleAccept = async (skipPassword: boolean) => {
    if (!skipPassword) {
      if (!meetsPasswordRequirements(password)) {
        setError("Please meet all password requirements.");
        return;
      }
      if (password !== confirmPassword) {
        setError("Passwords do not match.");
        return;
      }
    }

    setLoading(true);
    setError("");

    try {
      const res = await fetch(`${API}/api/team/accept-invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password: skipPassword ? undefined : password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to accept invitation.");
        return;
      }

      navigate("/login", { state: { message: "Invitation accepted! Please log in." } });
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  if (validating) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h2>Checking invitation...</h2>
        </div>
      </div>
    );
  }

  if (invalidMessage) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h2>Invitation Unavailable</h2>
          <p style={{ color: "#666", marginBottom: "1.5rem" }}>{invalidMessage}</p>
          <button
            className="btn btn-primary"
            onClick={() => navigate("/login")}
            style={{ width: "100%" }}
          >
            Go to Login
          </button>
        </div>
      </div>
    );
  }

  // User already has a password — just accept directly
  if (hasPassword) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h2>Accept Invitation</h2>
          <p style={{ color: "#666", marginBottom: "1.5rem" }}>
            You're joining as <strong>{email}</strong>. Since you already have an account, just click below to accept.
          </p>

          {error && <p className="auth-error">{error}</p>}

          <button
            className="btn btn-primary"
            onClick={() => handleAccept(true)}
            disabled={loading}
            style={{ width: "100%", marginTop: "0.5rem" }}
          >
            {loading ? "Accepting..." : "Accept Invitation"}
          </button>
        </div>
      </div>
    );
  }

  // New user — needs to set a password
  return (
    <div className="auth-page">
      <div className="auth-card">
        <h2>Accept Invitation</h2>
        <p style={{ color: "#666", marginBottom: "1.5rem" }}>
          Set a password to complete your account setup{email ? ` for ${email}` : ""}.
        </p>

        {error && <p className="auth-error">{error}</p>}

        <div className="form-group">
          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 12 characters"
            onKeyDown={(e) => e.key === "Enter" && handleAccept(false)}
          />
          <PasswordStrengthMeter password={password} />
        </div>

        <div className="form-group">
          <label>Confirm Password</label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Confirm your password"
            onKeyDown={(e) => e.key === "Enter" && handleAccept(false)}
          />
        </div>

        <button
          className="btn btn-primary"
          onClick={() => handleAccept(false)}
          disabled={loading}
          style={{ width: "100%", marginTop: "0.5rem" }}
        >
          {loading ? "Accepting..." : "Accept & Set Password"}
        </button>
      </div>
    </div>
  );
}
