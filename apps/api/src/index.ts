import "./instrument.js";
import { serve } from "@hono/node-server";
import { AIRouter, ClaudeProvider, GeminiProvider, VertexProvider, StitchDesignService, ClaudePageDesigner } from "@cadmus/ai";
import type { AIRouterConfig, AITaskType, AIModelConfig } from "@cadmus/ai";
import { GCSStorageProvider, CloudflareCustomHostnameProvider, CloudflareCdnCacheProvider, MailgunEmailProvider, GcpLogsProvider } from "@cadmus/cloud";
import { setAIRouter, setStitchService, setClaudePageDesigner, setAIStorageProvider } from "./routes/ai.js";
import { setStorageProvider, setStagingStorageProvider } from "./routes/media.js";
import { setFormUploadsStorageProvider } from "./lib/form-uploads.js";
import { setCustomHostnameProvider } from "./routes/sites.js";
import { setCdnCacheProvider } from "./routes/content.js";
import { setLogsProvider } from "./routes/admin-logs.js";
import { setEmailProvider } from "./lib/email.js";
import { initStripe } from "./lib/stripe.js";
import { app } from "./app.js";

// ---------------------------------------------------------------------------
// Bootstrap providers from environment
// ---------------------------------------------------------------------------

const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
const geminiApiKey = process.env.GEMINI_API_KEY;
const vertexProject = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCP_PROJECT_ID ?? null;
const vertexLocation = process.env.VERTEX_LOCATION ?? "us-central1";

const allTasks: AITaskType[] = [
  "copywriting",
  "seo",
  "image",
  "interview",
  "analysis",
  "embedding",
  "alt-text",
  "visitor-chat",
];

if (anthropicApiKey || geminiApiKey) {
  const claudeModel: AIModelConfig = { providerId: "claude", modelId: "claude-sonnet-4-6" };
  const geminiModel: AIModelConfig = { providerId: "gemini", modelId: "gemini-2.5-flash" };
  const geminiEmbed: AIModelConfig = { providerId: "gemini", modelId: "text-embedding-004" };
  const vertexImage: AIModelConfig = { providerId: "vertex", modelId: "imagen-4.0-generate-001" };

  // Image generation: Vertex AI primary (GCP quota, adjustable), Gemini Dev API fallback.
  // If Vertex isn't available (no project), fall back to Gemini only.
  const imagePrimary = vertexProject ? vertexImage : geminiModel;
  const imageFallback = geminiModel;

  let defaults: Record<string, AIModelConfig>;
  let fallbacks: Record<string, AIModelConfig>;

  if (anthropicApiKey && geminiApiKey) {
    // Claude primary for text/tools; Gemini/Vertex for tasks Claude can't do natively.
    defaults = Object.fromEntries(
      allTasks.map((t) => {
        if (t === "embedding") return [t, geminiEmbed];
        if (t === "image") return [t, imagePrimary];
        return [t, claudeModel];
      }),
    );
    fallbacks = Object.fromEntries(
      allTasks.map((t) => {
        if (t === "embedding") return [t, geminiEmbed];
        if (t === "image") return [t, imageFallback];
        return [t, geminiModel];
      }),
    );
  } else if (anthropicApiKey) {
    defaults = Object.fromEntries(
      allTasks.map((t) => [t, t === "image" ? imagePrimary : claudeModel]),
    );
    fallbacks = Object.fromEntries(
      allTasks.map((t) => [t, t === "image" ? imageFallback : claudeModel]),
    );
  } else {
    defaults = Object.fromEntries(
      allTasks.map((t) => {
        if (t === "embedding") return [t, geminiEmbed];
        if (t === "image") return [t, imagePrimary];
        return [t, geminiModel];
      }),
    );
    fallbacks = Object.fromEntries(
      allTasks.map((t) => [t, t === "embedding" ? geminiEmbed : imageFallback]),
    );
  }

  const config: AIRouterConfig = {
    defaults: defaults as AIRouterConfig["defaults"],
    fallbacks: fallbacks as AIRouterConfig["fallbacks"],
  };
  const router = new AIRouter(config);

  if (anthropicApiKey) {
    router.registerProvider(new ClaudeProvider({ apiKey: anthropicApiKey }));
    console.log("AI provider configured: Claude (Anthropic)");
  }
  if (geminiApiKey) {
    router.registerProvider(new GeminiProvider({ apiKey: geminiApiKey }));
    console.log("AI provider configured: Gemini (Google)");
  }
  if (vertexProject) {
    router.registerProvider(new VertexProvider({ project: vertexProject, location: vertexLocation }));
    console.log(`AI provider configured: Vertex AI (${vertexProject}/${vertexLocation})`);
  }

  setAIRouter(router);
}

const gcsBucket = process.env.GCS_BUCKET;
if (gcsBucket) {
  const gcs = new GCSStorageProvider({ bucketName: gcsBucket });
  setStorageProvider(gcs);
  setAIStorageProvider(gcs);
  console.log(`Storage provider configured: GCS (${gcsBucket})`);
}

const gcsStagingBucket = process.env.GCS_STAGING_BUCKET_NAME;
if (gcsStagingBucket) {
  setStagingStorageProvider(new GCSStorageProvider({ bucketName: gcsStagingBucket }));
  console.log(`Staging storage provider configured: GCS (${gcsStagingBucket})`);
}

// Private bucket for form-submission attachments (form-file-uploads add-on).
// Never the public media bucket — visitor uploads must not be world-readable.
const formUploadsBucket = process.env.FORM_UPLOADS_BUCKET;
if (formUploadsBucket) {
  setFormUploadsStorageProvider(new GCSStorageProvider({ bucketName: formUploadsBucket }));
  console.log(`Form uploads storage configured: GCS (${formUploadsBucket})`);
}

// Trim credentials: a stray trailing newline/space in a GCP secret would
// corrupt the `Authorization: Bearer …` header and surface as an opaque
// Cloudflare auth failure. Defensive only — the value should be clean.
const cfApiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
const cfZoneId = process.env.CLOUDFLARE_ZONE_ID?.trim();
if (cfApiToken && cfZoneId) {
  const cf = new CloudflareCustomHostnameProvider({ apiToken: cfApiToken, zoneId: cfZoneId });
  setCustomHostnameProvider(cf);
  console.log("Custom hostname provider configured: Cloudflare");
}
// CDN cache purge uses a separate token with Zone Cache Purge permission.
// Falls back to CLOUDFLARE_API_TOKEN if the dedicated token isn't set.
const cfCachePurgeToken = process.env.CLOUDFLARE_CACHE_PURGE_TOKEN?.trim() ?? cfApiToken;
if (cfCachePurgeToken && cfZoneId) {
  setCdnCacheProvider(new CloudflareCdnCacheProvider({ apiToken: cfCachePurgeToken, zoneId: cfZoneId }));
  console.log("CDN cache purge configured: Cloudflare");
}

// Cloud Run logs viewer for the ops dashboard. Uses ADC (the API service
// account) — needs roles/logging.viewer on the project. On Cloud Run
// (K_SERVICE always set) the client resolves the project from the metadata
// server, so don't require GOOGLE_CLOUD_PROJECT to be set explicitly.
if (vertexProject || process.env.K_SERVICE) {
  setLogsProvider(new GcpLogsProvider(vertexProject ? { projectId: vertexProject } : {}));
  console.log(`Logs provider configured: Cloud Logging (${vertexProject ?? "metadata-resolved project"})`);
}

const mailgunApiKey = process.env.MAILGUN_API_KEY;
const mailgunDomain = process.env.MAILGUN_DOMAIN;
if (mailgunApiKey && mailgunDomain) {
  setEmailProvider(new MailgunEmailProvider({
    apiKey: mailgunApiKey,
    domain: mailgunDomain,
    region: (process.env.MAILGUN_REGION as "us" | "eu") || "us",
  }));
  console.log(`Email provider configured: Mailgun (${mailgunDomain})`);
}

// Stripe billing
initStripe();

const stitchApiKey = process.env.STITCH_API_KEY;
if (stitchApiKey) {
  setStitchService(new StitchDesignService({ apiKey: stitchApiKey }));
  console.log("Design service configured: Google Stitch");
}

if (anthropicApiKey) {
  setClaudePageDesigner(new ClaudePageDesigner({ apiKey: anthropicApiKey }));
  console.log("Page designer configured: Claude (default; set settings.pageDesigner = \"stitch\" to opt out)");
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const port = Number(process.env.PORT) || 3001;
console.log(`Cadmus API running on port ${port}`);
const server = serve({ fetch: app.fetch, port });

// Graceful shutdown for Cloud Run
function shutdown() {
  console.log("Shutting down...");
  server.close();
  setTimeout(() => process.exit(1), 8000);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
