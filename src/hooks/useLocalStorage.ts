import { useEffect, useState } from "react";

export function useLocalStorage<T>(
  key: string,
  initialValue: T,
  legacyKeys: string[] = [],
) {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === "undefined") {
      return initialValue;
    }

    const raw =
      window.localStorage.getItem(key) ??
      legacyKeys
        .map((legacyKey) => window.localStorage.getItem(legacyKey))
        .find((legacyValue) => legacyValue !== null) ??
      null;

    if (!raw) {
      return initialValue;
    }

    try {
      return JSON.parse(raw) as T;
    } catch {
      return initialValue;
    }
  });

  useEffect(() => {
    window.localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue] as const;
}
