export interface SiteBriefPage {
  type: string;   // e.g. "homepage", "about", "services", "contact", "blog"
  slug: string;    // URL slug, e.g. "home", "about", "services"
  purpose: string; // Brief description of what this page should accomplish
}

export interface SiteBrief {
  businessName: string;
  businessDescription: string;
  location?: string;
  targetAudience?: string;
  differentiators?: string;
  tone?: string;
  primaryGoal?: string;
  brandColors?: string;
  logoUrl?: string;
  inspirationImages?: string[];
  pages?: SiteBriefPage[];
  // Explicit user prohibitions / hard requirements pulled from the brief, e.g.
  // "do not use stock photos", "never add a testimonials section". These are
  // injected into the design prompt as absolute rules. Each entry is a single
  // directive in the user's words.
  constraints?: string[];
  // The user's original brief text (paste/upload), preserved verbatim so no
  // instruction is silently lost in structured extraction. Used as a fallback
  // reference in generation; may be undefined for interview-derived briefs.
  rawBrief?: string;
  existingAssets?: {
    hasLogo: boolean;
    hasBrandColors: boolean;
    hasContent: boolean;
  };
  language?: string;
}
