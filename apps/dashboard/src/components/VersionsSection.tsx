import { useEffect, useState } from "react";

interface VersionInfo {
  app: string;
  env: string | null;
  gitSha: string | null;
  gitTag: string | null;
  builtAt: string | null;
}

type EnvName = "dev" | "prod";
type AppName = "api" | "admin" | "web" | "dashboard";

const VERSION_URLS: Record<AppName, Record<EnvName, string>> = {
  api: {
    dev: "https://api-dev.cadmus.digital/api/version",
    prod: "https://api.cadmus.digital/api/version",
  },
  admin: {
    dev: "https://dev.cadmus.digital/admin/version.json",
    prod: "https://cadmus.digital/admin/version.json",
  },
  web: {
    dev: "https://dev.cadmus.digital/version.json",
    prod: "https://cadmus.digital/version.json",
  },
  dashboard: {
    dev: "https://dashboard-dev.cadmus.digital/version.json",
    prod: "https://dashboard.cadmus.digital/version.json",
  },
};

const APPS: AppName[] = ["api", "admin", "web", "dashboard"];
const ENVS: EnvName[] = ["dev", "prod"];

const REPO = "frobroweb/cadmus";
const commitUrl = (sha: string) => `https://github.com/${REPO}/commit/${sha}`;
// base...head shows the commits in `head` that aren't in `base` — i.e. what's
// live on dev but not yet in prod.
const compareUrl = (base: string, head: string) =>
  `https://github.com/${REPO}/compare/${base}...${head}`;
const shortSha = (sha: string) => (sha.length > 7 ? sha.slice(0, 7) : sha);

type FetchState =
  | { status: "loading" }
  | { status: "ok"; data: VersionInfo }
  | { status: "error"; message: string };

type Versions = Record<AppName, Record<EnvName, FetchState>>;

function emptyVersions(): Versions {
  const out = {} as Versions;
  for (const app of APPS) {
    out[app] = { dev: { status: "loading" }, prod: { status: "loading" } };
  }
  return out;
}

async function fetchVersion(url: string): Promise<VersionInfo> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function formatBuiltAt(builtAt: string | null): string {
  if (!builtAt) return "--";
  try {
    return new Date(builtAt).toLocaleString();
  } catch {
    return builtAt;
  }
}

function shaOf(state: FetchState): string | null {
  return state.status === "ok" ? state.data.gitSha : null;
}

export function VersionsSection() {
  const [versions, setVersions] = useState<Versions>(emptyVersions);

  useEffect(() => {
    let cancelled = false;
    for (const app of APPS) {
      for (const env of ENVS) {
        fetchVersion(VERSION_URLS[app][env])
          .then((data) => {
            if (cancelled) return;
            setVersions((prev) => ({
              ...prev,
              [app]: { ...prev[app], [env]: { status: "ok", data } },
            }));
          })
          .catch((err: Error) => {
            if (cancelled) return;
            setVersions((prev) => ({
              ...prev,
              [app]: { ...prev[app], [env]: { status: "error", message: err.message } },
            }));
          });
      }
    }
    return () => {
      cancelled = true;
    };
  }, []);

  // `compare`, when set, renders a "what's not in prod yet" link under the SHA.
  const renderCell = (state: FetchState, compare?: { base: string; head: string } | null) => {
    if (state.status === "loading") {
      return <span style={{ color: "var(--color-text-muted)" }}>Loading...</span>;
    }
    if (state.status === "error") {
      return <span style={{ color: "var(--color-danger, #c33)" }}>{state.message}</span>;
    }
    const { gitSha, gitTag, builtAt } = state.data;
    return (
      <div>
        {gitTag && (
          <div style={{ fontWeight: 600, marginBottom: "0.15em" }}>{gitTag}</div>
        )}
        {gitSha ? (
          <a href={commitUrl(gitSha)} target="_blank" rel="noopener noreferrer">
            <code style={{ fontFamily: "monospace" }}>{shortSha(gitSha)}</code>
          </a>
        ) : (
          <code style={{ fontFamily: "monospace" }}>--</code>
        )}
        <div style={{ fontSize: "0.85em", color: "var(--color-text-muted)" }}>
          {formatBuiltAt(builtAt)}
        </div>
        {compare && (
          <div style={{ fontSize: "0.85em", marginTop: "0.3em" }}>
            <a href={compareUrl(compare.base, compare.head)} target="_blank" rel="noopener noreferrer">
              Compare with prod ↗
            </a>
          </div>
        )}
      </div>
    );
  };

  return (
    <section style={{ marginTop: "2rem" }}>
      <h3>Versions</h3>
      <table className="content-table">
        <thead>
          <tr>
            <th>App</th>
            <th>Dev</th>
            <th>Prod</th>
          </tr>
        </thead>
        <tbody>
          {APPS.map((app) => {
            const devSha = shaOf(versions[app].dev);
            const prodSha = shaOf(versions[app].prod);
            // Only offer a compare when both SHAs are known and they differ —
            // i.e. dev is genuinely ahead of prod for this app.
            const ahead =
              devSha && prodSha && devSha !== prodSha
                ? { base: prodSha, head: devSha }
                : null;
            return (
              <tr key={app}>
                <td style={{ textTransform: "capitalize", fontWeight: 600 }}>{app}</td>
                <td>{renderCell(versions[app].dev, ahead)}</td>
                <td>{renderCell(versions[app].prod)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
