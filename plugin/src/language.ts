// Purpose: v0.1-14 — which language the plugin speaks: Simplified Chinese or English (user 2026-09-25: these two for
// v0.1; Chinese of any region gets Simplified Chinese, every other language gets English). The panel learns Codex's
// interface language and reports it with its calls; it is kept in the data directory, where the engine (the text for
// the model) and the plugin service (the tab's title) read it. Until a panel has reported one, the system language
// counts; the command line always follows the system language.
// Input: language tags (BCP 47 or POSIX, e.g. "zh-CN", "zh_TW.UTF-8", "en-US"), the environment, the data directory.
// Output: "zh" | "en"; <data dir>/language.json = { "lang": "zh", "source": "codex" | "system", "at": "…" }.

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "./paths.ts";

export type Lang = "zh" | "en";
// codex: the panel got Codex's interface language; system: it only had the system's.
export type LangSource = "codex" | "system";
type Stored = { lang: Lang; source: LangSource; at: string };

export function langOf(tag: unknown): Lang | null {
  if (typeof tag !== "string") return null;
  const value = tag.trim().toLowerCase();
  if (!value || value === "c" || value === "posix" || value.startsWith("c.")) return null;
  return value.startsWith("zh") ? "zh" : "en";
}

// POSIX locale variables when set (macOS, Linux, some Windows shells), else what the runtime reports (Windows).
export function systemLang(env: NodeJS.ProcessEnv = process.env): Lang {
  for (const name of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const lang = langOf(env[name]);
    if (lang) return lang;
  }
  return langOf(Intl.DateTimeFormat().resolvedOptions().locale) ?? "en";
}

export const languageFileOf = (root = dataDir()) => join(root, "language.json");
let cache: { file: string; mtimeMs: number; value: Stored | null } | null = null;

export function storedLang(file = languageFileOf()): Stored | null {
  try {
    const { mtimeMs } = statSync(file);
    if (cache?.file === file && cache.mtimeMs === mtimeMs) return cache.value;
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const lang = raw?.lang === "zh" || raw?.lang === "en" ? (raw.lang as Lang) : null;
    const value: Stored | null = lang ? { lang, source: raw.source === "codex" ? "codex" : "system", at: String(raw.at ?? "") } : null;
    cache = { file, mtimeMs, value };
    return value;
  } catch {
    return null;
  }
}

// Written only when it changes, whole file then renamed, so readers never see half of it.
export function rememberLang(lang: Lang, source: LangSource, file = languageFileOf()): void {
  const known = storedLang(file);
  if (known?.lang === lang && known.source === source) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify({ lang, source, at: new Date().toISOString() }));
  renameSync(`${file}.tmp`, file);
  cache = null;
}

export function currentLang(file = languageFileOf()): Lang {
  return storedLang(file)?.lang ?? systemLang();
}
