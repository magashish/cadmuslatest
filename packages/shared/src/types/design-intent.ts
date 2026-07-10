// The realized global design direction for a site, captured after the homepage
// is generated and referenced on every AI edit so changes stay coherent.
// Theme tokens persist *what colors/fonts*; DesignIntent persists *why and how*
// — the aesthetic, voice, and layout language that edits would otherwise
// re-guess. Stored at settings.designIntent; never served to the public site.
export interface DesignIntent {
  // North-star paragraph: the executed look in plain language.
  aestheticDirection: string;
  // Copy voice & tone (e.g. "confident, plain-spoken, benefit-led; short headlines; no jargon").
  voiceAndTone: string;
  // Layout & composition principles actually used (section rhythm, dark/light
  // alternation, asymmetry, whitespace, card style).
  layoutPrinciples: string;
  // Imagery style (photographic vs illustrated, mood, subject matter, treatment).
  imageryStyle: string;
  // Color & type usage rationale — complements the raw theme tokens.
  colorAndType: string;
  // Hard prohibitions/requirements. Mirrors brief.constraints so every edit
  // sees the bans even when the brief isn't in context.
  constraints: string[];
  // Positioning / differentiators to reinforce in copy.
  positioning?: string;
  version: number;
  updatedAt: string;
  source: "generated" | "refined" | "user-edited";
}
