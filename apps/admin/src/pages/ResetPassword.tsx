import { useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { PasswordStrengthMeter, meetsPasswordRequirements } from "../components/PasswordStrengthMeter";

const API_BASE = import.meta.env.VITE_API_URL || "";

export function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  if (!token) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Cadmus</h1>
          <h2>Invalid link</h2>
          <p style={{ color: "#666", lineHeight: 1.6, marginBottom: "1.5rem" }}>
            This password reset link is invalid. Please request a new one.
          </p>
          <Link to="/forgot-password" className="btn btn-primary btn-full" style={{ display: "block", textAlign: "center", textDecoration: "none" }}>
            Request new link
          </Link>
        </div>
      </div>
    );
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");

    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }

    if (!meetsPasswordRequirements(password)) {
      setError("Please meet all password requirements");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: password }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Something went wrong");
      }
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Cadmus</h1>
          <h2>Password reset</h2>
          <p style={{ color: "#666", lineHeight: 1.6, marginBottom: "1.5rem" }}>
            Your password has been updated. You can now sign in with your new password.
          </p>
          <Link to="/login" className="btn btn-primary btn-full" style={{ display: "block", textAlign: "center", textDecoration: "none" }}>
            Sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Cadmus</h1>
        <h2>Set new password</h2>
        {error && <div className="auth-error">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>New password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
              minLength={12}
              placeholder="At least 12 characters"
            />
            <PasswordStrengthMeter password={password} />
          </div>
          <div className="form-group">
            <label>Confirm password</label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={12}
            />
          </div>
          <button type="submit" className="btn btn-primary btn-full" disabled={submitting}>
            {submitting ? "Resetting..." : "Reset password"}
          </button>
        </form>
      </div>
    </div>
  );
}
