import { useEffect, useState, useCallback } from "react";
import { admin, type UserListItem } from "../lib/api";

export function Users() {
  const [items, setItems] = useState<UserListItem[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await admin.users({ page, limit: 25, search });
      setItems(res.items);
      setTotalPages(res.pagination.totalPages);
      setTotal(res.pagination.total);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [page, search]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleSearch = (value: string) => {
    setSearch(value);
    setPage(1);
  };

  const formatDate = (d: string) =>
    new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  const fullName = (u: UserListItem) =>
    [u.firstName, u.lastName].filter(Boolean).join(" ") || "--";

  return (
    <div className="page">
      <h2>Users ({total})</h2>

      <div className="filter-bar">
        <input
          type="text"
          placeholder="Search by email or name..."
          value={search}
          onChange={(e) => handleSearch(e.target.value)}
        />
      </div>

      {loading ? (
        <p>Loading...</p>
      ) : items.length === 0 ? (
        <p style={{ color: "var(--color-text-muted)" }}>No users found.</p>
      ) : (
        <>
          <table className="content-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Global Role</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {items.map((user) => (
                <tr key={user.id}>
                  <td>{user.email}</td>
                  <td>{fullName(user)}</td>
                  <td>
                    <span className={`status-badge status-${user.globalRole}`}>
                      {user.globalRole}
                    </span>
                  </td>
                  <td>{formatDate(user.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {totalPages > 1 && (
            <div className="pagination">
              <button onClick={() => setPage((p) => p - 1)} disabled={page <= 1}>
                Previous
              </button>
              <span className="pagination-info">
                Page {page} of {totalPages}
              </span>
              <button onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages}>
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
