export type ScheduledTaskType =
  | "publish_content"
  | "ai_reminder"
  | "ai_generate"
  | "seo_audit"
  | "media_cleanup"
  | "analytics_digest"
  | "addon_sync";

export type ScheduledTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
