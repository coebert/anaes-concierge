import { useEffect, useState } from "react";

const KEY = "rota:preferenceMatchFilter";

function readInitial(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) return true;
    return raw === "1";
  } catch {
    return true;
  }
}

/**
 * Global rota preference-match filter. Persists in localStorage and stays in
 * sync across every subscriber in the tab via a same-tab CustomEvent bus.
 */
export function usePreferenceMatchFilter(): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState<boolean>(true);

  useEffect(() => {
    setValue(readInitial());
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<boolean>).detail;
      if (typeof detail === "boolean") setValue(detail);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setValue(e.newValue === "1");
    };
    window.addEventListener("rota:pref-match-changed", onChange as EventListener);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("rota:pref-match-changed", onChange as EventListener);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const set = (v: boolean) => {
    setValue(v);
    try {
      window.localStorage.setItem(KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
    window.dispatchEvent(
      new CustomEvent<boolean>("rota:pref-match-changed", { detail: v }),
    );
  };

  return [value, set];
}
