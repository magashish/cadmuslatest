import type { EmailProvider, EmailMessage, EmailSendResult } from "../types.js";

export interface MailgunEmailProviderConfig {
  apiKey: string;
  domain: string;
  defaultFrom?: string;
  /** Use EU endpoint (api.eu.mailgun.net) instead of US */
  region?: "us" | "eu";
}

export class MailgunEmailProvider implements EmailProvider {
  private apiKey: string;
  private domain: string;
  private defaultFrom: string;
  private baseUrl: string;

  constructor(config: MailgunEmailProviderConfig) {
    this.apiKey = config.apiKey;
    this.domain = config.domain;
    this.defaultFrom = config.defaultFrom ?? "Cadmus <noreply@cadmus.digital>";
    this.baseUrl =
      config.region === "eu"
        ? "https://api.eu.mailgun.net/v3"
        : "https://api.mailgun.net/v3";
  }

  async send(message: EmailMessage): Promise<EmailSendResult> {
    const form = new URLSearchParams();
    form.append("from", message.from || this.defaultFrom);
    form.append("to", message.to);
    form.append("subject", message.subject);
    form.append("html", message.html);
    if (message.text) form.append("text", message.text);
    if (message.replyTo) form.append("h:Reply-To", message.replyTo);

    const res = await fetch(`${this.baseUrl}/${this.domain}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`api:${this.apiKey}`)}`,
      },
      body: form,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(
        `Mailgun error: ${(err as Record<string, string>).message || res.status}`,
      );
    }

    const body = (await res.json()) as { id: string };
    return { id: body.id, success: true };
  }
}
