/**
 * Content policy enforcement for Cadmus AI.
 *
 * Two layers:
 *  1. `checkContentPolicy()` — fast keyword/pattern screen run BEFORE any AI call
 *  2. System-prompt instructions (see core-identity.ts) telling the model to refuse
 *
 * We intentionally keep this lightweight. The upstream LLMs (Claude, Gemini) have
 * their own safety filters; this layer catches obvious intent early so we don't
 * waste API calls and can return a clear, branded refusal message.
 */

export interface PolicyResult {
  allowed: true;
}

export interface PolicyViolation {
  allowed: false;
  category: string;
  message: string;
}

export type ContentPolicyCheck = PolicyResult | PolicyViolation;

// ---------------------------------------------------------------------------
// Prohibited categories — each has a display name, user-facing message, and
// patterns that signal intent (not just incidental mention).
// ---------------------------------------------------------------------------

interface ProhibitedCategory {
  name: string;
  message: string;
  /** Patterns are tested against lowercased input. Use word boundaries (\b) to avoid false positives. */
  patterns: RegExp[];
}

const PROHIBITED_CATEGORIES: ProhibitedCategory[] = [
  {
    name: "adult_content",
    message:
      "Cadmus cannot be used to create websites with adult or sexually explicit content.",
    patterns: [
      /\b(porn|pornograph(y|ic)|xxx|adult\s+(entertain|content|video|film|site|website|industry))\b/,
      /\b(escort\s+service|erotic\s+(massag|servic|content)|sex\s+(work|shop|toy\s+store|cam)|cam\s*(girl|boy|model|site))\b/,
      /\b(onlyfans\s*(clone|alternative|competitor)|strip\s*club|gentlemen'?s\s+club)\b/,
      /\b(nsfw\s+(content|site|platform)|hookup\s+(site|app|platform))\b/,
    ],
  },
  {
    name: "child_exploitation",
    message:
      "This request has been rejected. Cadmus has a zero-tolerance policy for content involving the exploitation of minors.",
    patterns: [
      /\bchild\s+(porn|exploit|abuse)\b/,
      /\b(csam|cp\s+site|minor\s+(exploit|porn|attract))\b/,
    ],
  },
  {
    name: "illegal_drugs",
    message:
      "Cadmus cannot be used to create websites that sell or promote illegal drugs or controlled substances.",
    patterns: [
      /\b(sell|buy|order|shop)\s+(weed|marijuana|cannabis|cocaine|heroin|meth|mdma|ecstasy|lsd|fentanyl|ketamine|shrooms|psychedelics)\b/,
      /\b(drug\s+(dealer|market|shop|store|delivery)|dark\s*net\s+market|narcotics\s+(sale|shop|store))\b/,
      /\b(online\s+(dispensary|pharmacy)\s+(no|without)\s+(prescription|rx))\b/,
    ],
  },
  {
    name: "weapons_trafficking",
    message:
      "Cadmus cannot be used to create websites for illegal weapons sales or trafficking.",
    patterns: [
      /\b(buy|sell|order)\s+(guns?|firearms?|weapons?|ammunition|ammo)\s+(online|illegall?y?|no\s+(background|license))\b/,
      /\b(ghost\s+gun|untraceable\s+(gun|firearm|weapon)|illegal\s+arms)\b/,
      /\b(weapons?\s+traffick|arms\s+dealer|black\s+market\s+(gun|weapon|firearm|arms))\b/,
    ],
  },
  {
    name: "fraud_scams",
    message:
      "Cadmus cannot be used to create websites designed to deceive, scam, or defraud people.",
    // Bare nouns like "phishing" or "ponzi" appear in legitimate prose
    // (Terms of Service, Acceptable Use lists, articles about scams), so we
    // require a build-intent suffix. Verbose enough to catch real intent,
    // narrow enough that describing the activity in content doesn't trip.
    patterns: [
      /\b(phishing\s+(kit|site|page|campaign|template|tool|attack|scheme)|scam\s+(site|page|website)|fake\s+(bank|login|paypal|amazon))\b/,
      /\b(carding\s+(site|forum)|credit\s+card\s+(fraud|dump|skim)|identity\s+theft\s+service)\b/,
      /\b(ponzi\s+(scheme\s+(site|page|website|landing|operation)|site|page|operation)|pyramid\s+scheme\s+(site|page|website|landing|operation)|money\s+laundering\s+(site|service))\b/,
      /\b(counterfeit\s+(money|currency|document|passport|id)|fake\s+(diploma|degree|certificate)\s+(site|service|shop))\b/,
    ],
  },
  {
    name: "hate_extremism",
    message:
      "Cadmus cannot be used to create websites that promote hate, violence, or extremism targeting any group.",
    patterns: [
      /\b(white\s+(supremac|nationalist|power)|neo[\s-]?nazi|aryan\s+nation)\b/,
      /\b(hate\s+group|racial\s+purity|ethnic\s+cleansing)\b/,
      /\b(terrorist\s+(recruit|propag|organiz)|jihadi\s+(recruit|propag)|extremist\s+(recruit|cell))\b/,
    ],
  },
  {
    name: "illegal_gambling",
    message:
      "Cadmus cannot be used to create unlicensed gambling or betting websites.",
    patterns: [
      /\b(illegal\s+(casino|gambling|betting)|unlicensed\s+(casino|gambling|betting|sportsbook))\b/,
      /\b(offshore\s+(casino|betting|sportsbook)|unregulated\s+(gambling|casino|poker))\b/,
    ],
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Screen a piece of user input against the content policy.
 * Call this on prompts, business descriptions, page purposes, etc.
 * Returns `{ allowed: true }` or `{ allowed: false, category, message }`.
 */
export function checkContentPolicy(text: string): ContentPolicyCheck {
  if (!text) return { allowed: true };

  const lower = text.toLowerCase();

  for (const cat of PROHIBITED_CATEGORIES) {
    for (const pattern of cat.patterns) {
      if (pattern.test(lower)) {
        return {
          allowed: false,
          category: cat.name,
          message: cat.message,
        };
      }
    }
  }

  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Image-generation-specific patterns
// These are broader than the site-building checks above because image prompts
// express visual intent directly (e.g. "nude woman") rather than site purpose.
// ---------------------------------------------------------------------------

const IMAGE_PROHIBITED_CATEGORIES: ProhibitedCategory[] = [
  {
    name: "explicit_nudity",
    message: "Image generation cannot be used to create explicit or nude content.",
    patterns: [
      /\bnude\b/,
      /\bnaked\b/,
      /\btopless\b/,
      /\bgenitals?\b/,
      /\bexplicit(ly)?\s+(naked|nude|sexual|sex)\b/,
      /\b(bare|exposed)\s+(breasts?|chest|body)\b/,
    ],
  },
  {
    name: "sexual_content",
    message: "Image generation cannot be used to create sexual or pornographic content.",
    patterns: [
      /\bporn(ograph(y|ic))?\b/,
      /\bsex\s+(act|scene|position|tape)\b/,
      /\b(sexual|erotic)\s+(act|scene|content|image|photo)\b/,
      /\bmasturbat/,
      /\bhentai\b/,
    ],
  },
  {
    name: "graphic_violence",
    message: "Image generation cannot be used to create graphic violence or gore.",
    patterns: [
      /\bgore\b/,
      /\bgraphic\s+(violence|injury|wound|death)\b/,
      /\bdecapitat/,
      /\bdismember/,
      /\bmutilat/,
      /\bblood(y|ied)?\s+(corpse|body|scene|mess)\b/,
    ],
  },
];

/**
 * Additional policy check for image generation prompts.
 * Runs the base policy first, then image-specific visual-content patterns.
 */
export function checkImagePrompt(prompt: string): ContentPolicyCheck {
  const base = checkContentPolicy(prompt);
  if (!base.allowed) return base;

  if (!prompt) return { allowed: true };
  const lower = prompt.toLowerCase();

  for (const cat of IMAGE_PROHIBITED_CATEGORIES) {
    for (const pattern of cat.patterns) {
      if (pattern.test(lower)) {
        return { allowed: false, category: cat.name, message: cat.message };
      }
    }
  }

  return { allowed: true };
}

/**
 * Screen multiple strings at once (e.g. all fields of a site brief).
 * Returns the first violation found, or `{ allowed: true }`.
 */
export function checkContentPolicyBulk(texts: (string | null | undefined)[]): ContentPolicyCheck {
  for (const text of texts) {
    if (!text) continue;
    const result = checkContentPolicy(text);
    if (!result.allowed) return result;
  }
  return { allowed: true };
}

/**
 * Paragraph to append to system prompts so the model itself refuses
 * prohibited content even if the keyword screen misses it.
 */
export const CONTENT_POLICY_PROMPT = `
CONTENT POLICY — You MUST refuse requests that ask you to create content for:
- Adult, pornographic, or sexually explicit websites or businesses
- Child exploitation in any form (zero tolerance)
- Illegal drug sales or promotion of controlled substances
- Illegal weapons sales or trafficking
- Fraud, scams, phishing, or deceptive schemes
- Hate groups, white supremacy, neo-Nazism, or terrorist recruitment
- Unlicensed or illegal gambling operations

If a request falls into any of these categories, respond ONLY with:
"I'm sorry, but I can't help create content for that type of website. Cadmus's content policy prohibits [specific category]. If you believe this is a mistake, please contact support."

Do NOT provide partial help, suggestions for rewording, or workarounds. Simply decline.`;
