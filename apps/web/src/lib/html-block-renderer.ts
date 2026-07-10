// Re-export shared helpers so web-side imports keep working. The actual
// implementations live in @cadmus/shared so the admin preview iframe can
// use the exact same render pipeline as the public site.
export {
  applyEditableFields,
  applyNavToStitchHeader,
  applyNavToStitchFooter,
  buildSocialLinksRow,
  buildStitchCssVars,
} from "@cadmus/shared";
export type { SocialLink, NavItem } from "@cadmus/shared";
