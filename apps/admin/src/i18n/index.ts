import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import hi from "./locales/hi.json";

export const SUPPORTED_LOCALES = ["en", "hi"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

const STORAGE_KEY = "cadmus_locale";

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

function detectInitialLocale(): SupportedLocale {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (isSupportedLocale(stored)) return stored;

  const browserLang = navigator.language?.split("-")[0];
  if (isSupportedLocale(browserLang)) return browserLang;

  return "en";
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, hi: { translation: hi } },
  lng: detectInitialLocale(),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

// Persist so the choice survives reloads before the user's saved profile
// preference (if any) is fetched and applied on top of it.
i18n.on("languageChanged", (lng) => {
  if (isSupportedLocale(lng)) localStorage.setItem(STORAGE_KEY, lng);
});

export default i18n;
