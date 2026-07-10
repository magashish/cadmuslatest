import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";

const API_BASE = import.meta.env.VITE_API_URL || "";

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Something went wrong");
      }
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Cadmus</h1>
          <h2>Check your email</h2>
          <p style={{ color: "#666", lineHeight: 1.6, marginBottom: "1.5rem" }}>
            If an account exists for <strong>{email}</strong>, we sent a password reset link.
            It expires in 1 hour.
          </p>
          <Link to="/login" className="btn btn-primary btn-full" style={{ display: "block", textAlign: "center", textDecoration: "none" }}>
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Cadmus</h1>
        <h2>Forgot password</h2>
        <p style={{ color: "#666", lineHeight: 1.6, marginBottom: "1.5rem" }}>
          Enter your email and we'll send you a link to reset your password.
        </p>
        {error && <div className="auth-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
            />
          </div>
          <button type="submit" className="btn btn-primary btn-full" disabled={submitting}>
            {submitting ? "Sending..." : "Send reset link"}
          </button>
        </form>
        <p className="auth-link">
          <Link to="/login">Back to sign in</Link>
        </p>
      </div>
    </div>
  );
}
