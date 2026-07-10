import { Storage, type Bucket, type File, type GetSignedUrlConfig } from "@google-cloud/storage";
import type { StorageProvider, StorageUploadResult, StorageObjectStream } from "../types.js";

// Keyless V4 signing makes a network call to the IAM signBlob API. On a
// long-lived instance (min-instances >= 1) a keep-alive socket to
// iamcredentials.googleapis.com can be closed server-side and then reused,
// surfacing as "Premature close"/ECONNRESET. These are transient: a retry
// gets a fresh connection. Permission errors (403) are NOT matched here, so
// they still fail fast.
function isTransientSigningError(err: unknown): boolean {
  const e = err as { name?: string; message?: string; code?: string };
  const text = `${e?.name ?? ""} ${e?.message ?? ""} ${e?.code ?? ""}`;
  return /premature close|econnreset|socket hang up|etimedout|epipe|ehostunreach|signingerror/i.test(text);
}

export interface GCSStorageProviderConfig {
  bucketName: string;
  projectId?: string;
  keyFilePath?: string;
  stagingBucketName?: string;
}

export class GCSStorageProvider implements StorageProvider {
  private storage: Storage;
  private bucket: Bucket;
  private bucketName: string;
  private stagingBucket?: Bucket;

  constructor(config: GCSStorageProviderConfig) {
    this.storage = new Storage({
      projectId: config.projectId,
      keyFilename: config.keyFilePath,
    });
    this.bucketName = config.bucketName;
    this.bucket = this.storage.bucket(config.bucketName);
    if (config.stagingBucketName) {
      this.stagingBucket = this.storage.bucket(config.stagingBucketName);
    }
  }

  async upload(
    file: Buffer,
    path: string,
    contentType?: string,
    cacheControl?: string,
  ): Promise<StorageUploadResult> {
    const gcsFile = this.bucket.file(path);
    await gcsFile.save(file, {
      contentType,
      resumable: false,
      ...(cacheControl ? { metadata: { cacheControl } } : {}),
    });

    return {
      path,
      url: this.getPublicUrl(path),
      size: file.length,
    };
  }

  async delete(path: string): Promise<void> {
    await this.bucket.file(path).delete();
  }

  // Retries signing on transient signBlob connection errors (see
  // isTransientSigningError). 3 attempts with a short backoff; the retry
  // establishes a fresh connection, so one dead keep-alive socket no longer
  // becomes a user-facing 500.
  private async signWithRetry(file: File, options: GetSignedUrlConfig, attempts = 3): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const [url] = await file.getSignedUrl(options);
        return url;
      } catch (err) {
        lastErr = err;
        if (!isTransientSigningError(err) || attempt === attempts) throw err;
        console.warn(`Signed URL attempt ${attempt}/${attempts} failed (transient), retrying: ${(err as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, 150 * attempt));
      }
    }
    throw lastErr;
  }

  async getSignedUrl(path: string, expiresInSeconds: number): Promise<string> {
    return this.signWithRetry(this.bucket.file(path), {
      version: "v4",
      action: "read",
      expires: Date.now() + expiresInSeconds * 1000,
    });
  }

  async getSignedUploadUrl(path: string, contentType: string, expiresInSeconds: number): Promise<string> {
    return this.signWithRetry(this.bucket.file(path), {
      version: "v4",
      action: "write",
      expires: Date.now() + expiresInSeconds * 1000,
      contentType,
    });
  }

  // Creates a resumable upload session and returns its URI. Uses the SA's
  // access token (storage.googleapis.com) — no signBlob — so it's reliable on
  // Cloud Run. The client PUTs the file directly to the returned URI.
  async createResumableUploadUrl(path: string, contentType: string, origin?: string): Promise<string> {
    const [uri] = await this.bucket.file(path).createResumableUpload({
      metadata: { contentType },
      ...(origin ? { origin } : {}),
    });
    return uri;
  }

  async streamObject(path: string, range?: { start: number; end?: number }): Promise<StorageObjectStream> {
    const file = this.bucket.file(path);
    const [metadata] = await file.getMetadata();
    const size = Number(metadata.size ?? 0);
    const contentType = metadata.contentType ?? "application/octet-stream";
    // GCS createReadStream end is inclusive, matching HTTP Range semantics.
    const opts = range
      ? range.end != null
        ? { start: range.start, end: range.end }
        : { start: range.start }
      : undefined;
    const stream = file.createReadStream(opts);
    return { stream, size, contentType };
  }

  getPublicUrl(path: string): string {
    return `https://storage.googleapis.com/${this.bucketName}/${path}`;
  }

  async getObjectSize(path: string): Promise<number> {
    const [metadata] = await this.bucket.file(path).getMetadata();
    return Number(metadata.size ?? 0);
  }

  async copyFile(sourcePath: string, destPath: string, sourceBucketName?: string): Promise<StorageUploadResult> {
    const srcBucket = sourceBucketName
      ? this.storage.bucket(sourceBucketName)
      : (this.stagingBucket ?? this.bucket);
    await srcBucket.file(sourcePath).copy(this.bucket.file(destPath));
    const [metadata] = await this.bucket.file(destPath).getMetadata();
    return {
      path: destPath,
      url: this.getPublicUrl(destPath),
      size: Number(metadata.size ?? 0),
    };
  }

  async ping(): Promise<void> {
    const [exists] = await this.bucket.exists();
    if (!exists) throw new Error(`Bucket ${this.bucketName} not accessible`);
  }
}
