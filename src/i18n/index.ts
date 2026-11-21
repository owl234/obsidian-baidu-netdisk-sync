import { en, TranslationKey } from "./en";
import { zh } from "./zh";

export type SupportedLocale = "en" | "zh";
export type { TranslationKey };

let currentLocale: SupportedLocale | null = null;

function resolveLocaleTag(tag?: string): SupportedLocale {
  if (!tag) return "en";
  return tag.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function detectDefaultLocale(): SupportedLocale {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().locale;
    return resolveLocaleTag(resolved);
  } catch {
    return "en";
  }
}

export function initLocale(localeTag?: string): SupportedLocale {
  currentLocale = localeTag ? resolveLocaleTag(localeTag) : detectDefaultLocale();
  return currentLocale;
}

export function getLocale(): SupportedLocale {
  if (!currentLocale) {
    currentLocale = detectDefaultLocale();
  }
  return currentLocale;
}

export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  const locale = getLocale();
  const dict = locale === "zh" ? zh : en;
  let template: string = dict[key] ?? en[key];

  if (params) {
    for (const [paramKey, val] of Object.entries(params)) {
      template = template.replace(new RegExp(`\\{${paramKey}\\}`, "g"), String(val));
    }
  }

  return template;
}
