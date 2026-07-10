export type { SiteBrief, SiteBriefPage } from "./types/site-brief.js";
export type { AuthUser, LoginRequest, SignupRequest, AuthResponse, SiteRole, GlobalRole, SiteMembership, Locale } from "./types/auth.js";
export { SUPPORTED_LOCALES } from "./types/auth.js";
export type { ContentType, ContentStatus, BlockType } from "./types/content.js";
export type { ScheduledTaskType, ScheduledTaskStatus } from "./types/scheduling.js";
export type {
  ContentBlock,
  HeroBlock,
  TextBlock,
  HeadingBlock,
  ImageBlock,
  CTABlock,
  TestimonialBlock,
  FAQBlock,
  PricingBlock,
  GalleryBlock,
  FormBlock,
  VideoBlock,
  EmbedBlock,
  MapBlock,
  ParagraphBlock,
  SectionBlock,
  HtmlBlock,
  HtmlBlockEditableField,
  MortgageCalculatorBlock,
} from "./types/design.js";
export type { SiteTheme, DesignStyle, FontSizeToken } from "./types/theme.js";
export type { DesignIntent } from "./types/design-intent.js";
export { themeToTailwindConfig } from "./theme/to-tailwind.js";
export { themePresets } from "./theme-presets.js";
export {
  applyEditableFields,
  applyNavToStitchHeader,
  applyNavToStitchFooter,
  buildSocialLinksRow,
  backfillFieldsFromMarkers,
  buildStitchCssVars,
  STITCH_HEADER_NAV_CONTAINER_RE,
  CLAUDE_HEADER_NAV_CONTAINER_RE,
  STITCH_FOOTER_NAV_COLUMN_RE,
  STITCH_FOOTER_SOCIAL_CONTAINER_RE,
} from "./html/nav-wiring.js";
export type { NavItem, SocialLink } from "./html/nav-wiring.js";
