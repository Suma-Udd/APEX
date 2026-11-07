import { useEffect, useState } from "react";

export type ThemePref = "system" | "light" | "dark";
const KEY = "apex.theme";

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch { return "system"; }
}

/** Follows the OS light/dark setting unless the user picks one. Returns the resolved theme too. */
export function useTheme(): [ThemePref, (t: ThemePref) => void, "light" | "dark"] {
  const [pref, setPref] = useState<ThemePref>(read);
  const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  const [systemDark, setSystemDark] = useState(media ? media.matches : true);
  useEffect(() => {
    if (!media) return;
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    media.addEventListener("change", on);
    return () => media.removeEventListener("change", on);
  }, [media]);
  const resolved = pref === "system" ? (systemDark ? "dark" : "light") : pref;
  useEffect(() => { document.documentElement.dataset.theme = resolved; }, [resolved]);
  const set = (t: ThemePref) => {
    setPref(t);
    try { localStorage.setItem(KEY, t); } catch { /* private mode */ }
  };
  return [pref, set, resolved];
}
