import { useEffect, useRef, useState, useCallback } from "react";
import { apiRawFetch } from "./api";

export type FeatureKey =
  | "custom_domain"
  | "team_members"
  | "ai_chat_message"
  | "ai_image_generation"
  | "page_count"
  | "post_count"
  | "storage_upload"
  | "form_email_notification"
  | "paid_addons";

export interface GateResult {
  allowed: boolean;
  limit: number | null;
  usage: number | null;
  period: "daily" | "monthly" | "lifetime" | null;
  reason?: string;
}

const CACHE_TTL_MS = 60_000; // 60 seconds

let cachedGates: Record<FeatureKey, GateResult> | null = null;
let cacheExpiry = 0;

async function fetchGates(): Promise<Record<FeatureKey, GateResult>> {
  const now = Date.now();
  if (cachedGates && now < cacheExpiry) {
    return cachedGates;
  }

  const res = await apiRawFetch("/api/feature-gates");
  if (!res.ok) {
    throw new Error(`Failed to fetch feature gates: ${res.status}`);
  }

  const data = (await res.json()) as Record<FeatureKey, GateResult>;
  cachedGates = data;
  cacheExpiry = Date.now() + CACHE_TTL_MS;
  return data;
}

export function invalidateFeatureGatesCache(): void {
  cachedGates = null;
  cacheExpiry = 0;
}

export function useFeatureGates(): {
  gates: Record<FeatureKey, GateResult> | null;
  loading: boolean;
  refetch: () => void;
} {
  const [gates, setGates] = useState<Record<FeatureKey, GateResult> | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const load = useCallback(() => {
    setLoading(true);
    fetchGates()
      .then((data) => {
        if (mountedRef.current) {
          setGates(data);
          setLoading(false);
        }
      })
      .catch(() => {
        if (mountedRef.current) {
          setLoading(false);
        }
      });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    load();
    return () => {
      mountedRef.current = false;
    };
  }, [load]);

  const refetch = useCallback(() => {
    invalidateFeatureGatesCache();
    load();
  }, [load]);

  return { gates, loading, refetch };
}
