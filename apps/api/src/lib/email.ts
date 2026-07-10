import type { EmailProvider } from "@cadmus/cloud";

let emailProvider: EmailProvider | null = null;

export function setEmailProvider(provider: EmailProvider) {
  emailProvider = provider;
}

export function getEmailProvider(): EmailProvider | null {
  return emailProvider;
}
