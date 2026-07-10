import { useState, useEffect, useCallback } from "react";
import { team, billing, type TeamMember } from "../lib/api";
import { useAuth } from "../context/AuthContext";
import { useFeatureGates } from "../lib/feature-gates";
import { UpgradePrompt } from "../components/UpgradePrompt";

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  editor: "Editor",
  viewer: "Viewer",
};

const ROLE_COLORS: Record<string, string> = {
  owner: "#1a1a1a",
  admin: "#4f46e5",
  editor: "#059669",
  viewer: "#6b7280",
};

export function Team() {
  const { user, switchSite, logout } = useAuth();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("editor");
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [billingUserId, setBillingUserId] = useState<string | null>(null);

  const canManage = user?.role === "owner" || user?.role === "admin";
  const { gates } = useFeatureGates();
  const teamGate = gates?.team_members;

  const load = useCallback(async () => {
    try {
      const res = await team.list();
      setMembers(res.members);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    billing.status().then((s) => setBillingUserId(s.subscription?.billingUserId ?? null)).catch(() => {});
  }, []);

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    setError("");
    setSuccess("");
    setInviting(true);
    try {
      await team.invite(inviteEmail.trim(), inviteRole);
      setSuccess(`Invitation sent to ${inviteEmail}`);
      setInviteEmail("");
      setTimeout(() => setSuccess(""), 3000);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send invitation");
    } finally {
      setInviting(false);
    }
  };

  const handleRoleChange = async (memberId: string, newRole: string) => {
    try {
      await team.changeRole(memberId, newRole);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to change role");
    }
  };

  const handleRemove = async (member: TeamMember) => {
    const name = [member.firstName, member.lastName].filter(Boolean).join(" ") || member.email;
    const isSelf = member.userId === user?.id;
    const message = isSelf
      ? "Leave this site? You will lose access."
      : `Remove ${name} from this site?`;
    if (!confirm(message)) return;
    try {
      await team.remove(member.id);
      if (isSelf) {
        // Switch to another site or log out
        const otherSites = user?.memberships?.filter(
          (m) => m.siteId !== user.siteId && m.status === "active"
        );
        if (otherSites && otherSites.length > 0) {
          await switchSite(otherSites[0].siteId);
        } else {
          logout();
        }
      } else {
        load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to remove member");
    }
  };

  if (loading) {
    return (
      <div className="page">
        <div className="page-header"><h2>Team</h2></div>
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h2>Team</h2>
      </div>

      {canManage && (
        <section className="settings-section">
          <h3>Invite Member</h3>
          {teamGate && !teamGate.allowed ? (
            <UpgradePrompt feature="team_members" gate={teamGate} inline />
          ) : (
            <div className="settings-form" style={{ display: "flex", gap: "0.75rem", alignItems: "flex-end", flexWrap: "wrap" }}>
              <label style={{ flex: 1, minWidth: "200px" }}>
                Email
                <input
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="colleague@example.com"
                  onKeyDown={(e) => e.key === "Enter" && handleInvite()}
                />
              </label>
              <label style={{ width: "140px" }}>
                Role
                <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                  {user?.role === "owner" && <option value="admin">Admin</option>}
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
              </label>
              <button
                className="btn btn-primary"
                onClick={handleInvite}
                disabled={inviting || !inviteEmail.trim()}
                style={{ marginBottom: "0.75rem" }}
              >
                {inviting ? "Sending..." : "Send Invite"}
              </button>
            </div>
          )}
          {error && <p className="auth-error" style={{ marginTop: "0.5rem" }}>{error}</p>}
          {success && <p className="settings-success" style={{ marginTop: "0.5rem" }}>{success}</p>}
        </section>
      )}

      <section className="settings-section">
        <h3>Members ({members.filter((m) => m.status === "active").length})</h3>
        <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "2px solid #e5e7eb", textAlign: "left" }}>
              <th style={{ padding: "0.5rem 0.75rem" }}>Name</th>
              <th style={{ padding: "0.5rem 0.75rem" }}>Email</th>
              <th style={{ padding: "0.5rem 0.75rem" }}>Role</th>
              <th style={{ padding: "0.5rem 0.75rem" }}>Joined</th>
              <th style={{ padding: "0.5rem 0.75rem", width: "80px" }}></th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const name = [m.firstName, m.lastName].filter(Boolean).join(" ");
              const isCurrentUser = m.userId === user?.id;
              const isOwner = m.role === "owner";
              const canEdit = canManage && !isOwner && !isCurrentUser;
              const activeCount = members.filter((x) => x.status === "active").length;
              const canLeave = isCurrentUser && !isOwner && activeCount > 1;

              return (
                <tr key={m.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "0.75rem" }}>
                    {name || <span style={{ color: "#9ca3af" }}>—</span>}
                    {isCurrentUser && <span style={{ color: "#6b7280", fontSize: "0.8em", marginLeft: "0.5rem" }}>(you)</span>}
                  </td>
                  <td style={{ padding: "0.75rem" }}>{m.email}</td>
                  <td style={{ padding: "0.75rem" }}>
                    {canEdit ? (
                      <select
                        value={m.role}
                        onChange={(e) => handleRoleChange(m.id, e.target.value)}
                        style={{ padding: "0.25rem 0.5rem", fontSize: "0.85rem", borderRadius: "4px" }}
                      >
                        {user?.role === "owner" && <option value="admin">Admin</option>}
                        <option value="editor">Editor</option>
                        <option value="viewer">Viewer</option>
                      </select>
                    ) : (
                      <span
                        style={{
                          display: "inline-block",
                          padding: "0.15rem 0.5rem",
                          borderRadius: "9999px",
                          fontSize: "0.8rem",
                          fontWeight: 600,
                          color: "#fff",
                          background: ROLE_COLORS[m.role] || "#6b7280",
                        }}
                      >
                        {ROLE_LABELS[m.role] || m.role}
                      </span>
                    )}
                    {m.status === "invited" && (
                      <span style={{ marginLeft: "0.5rem", fontSize: "0.8em", color: "#d97706" }}>Pending</span>
                    )}
                    {billingUserId && m.userId === billingUserId && (
                      <span
                        title="This member is the billing contact"
                        style={{
                          marginLeft: "0.5rem",
                          display: "inline-block",
                          padding: "0.1rem 0.4rem",
                          borderRadius: "4px",
                          fontSize: "0.7rem",
                          fontWeight: 600,
                          background: "#ede9fe",
                          color: "#6d28d9",
                        }}
                      >
                        Billing
                      </span>
                    )}
                  </td>
                  <td style={{ padding: "0.75rem", color: "#6b7280", fontSize: "0.9rem" }}>
                    {m.joinedAt ? new Date(m.joinedAt).toLocaleDateString() : "—"}
                  </td>
                  <td style={{ padding: "0.75rem" }}>
                    {canEdit && (
                      <button
                        className="btn"
                        style={{ fontSize: "0.8rem", padding: "0.25rem 0.5rem", color: "#dc2626" }}
                        onClick={() => handleRemove(m)}
                      >
                        Remove
                      </button>
                    )}
                    {canLeave && (
                      <button
                        className="btn"
                        style={{ fontSize: "0.8rem", padding: "0.25rem 0.5rem", color: "#dc2626" }}
                        onClick={() => handleRemove(m)}
                      >
                        Leave
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </section>
    </div>
  );
}
