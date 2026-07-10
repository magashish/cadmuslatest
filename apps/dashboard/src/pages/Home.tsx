import { useEffect, useState } from "react";
import { admin } from "../lib/api";
import { VersionsSection } from "../components/VersionsSection";

interface Stats {
  sites: number;
  users: number;
  activeSubscriptions: number;
  trials: number;
  partners: number;
  referrals: number;
}

export function Home() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    admin
      .stats()
      .then(setStats)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="page">
        <h2>Dashboard</h2>
        <p>Loading...</p>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="page">
        <h2>Dashboard</h2>
        <p>Failed to load stats.</p>
      </div>
    );
  }

  const cards = [
    { label: "Total Sites", value: stats.sites },
    { label: "Active Subscriptions", value: stats.activeSubscriptions },
    { label: "Trials", value: stats.trials },
    { label: "Total Users", value: stats.users },
    { label: "Partners", value: stats.partners },
    { label: "Referrals", value: stats.referrals },
  ];

  return (
    <div className="page">
      <h2>Dashboard</h2>
      <div className="stat-cards">
        {cards.map((card) => (
          <div key={card.label} className="stat-card">
            <div className="stat-card-value">{card.value}</div>
            <div className="stat-card-label">{card.label}</div>
          </div>
        ))}
      </div>
      <VersionsSection />
    </div>
  );
}
