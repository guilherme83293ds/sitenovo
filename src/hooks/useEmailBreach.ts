import { useEffect, useState } from "react";

export type BreachStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "safe" }
  | { state: "breached"; breaches: string[] }
  | { state: "error" };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function useEmailBreach(email: string): BreachStatus {
  const [breach, setBreach] = useState<BreachStatus>({ state: "idle" });

  useEffect(() => {
    if (!EMAIL_RE.test(email)) {
      setBreach({ state: "idle" });
      return;
    }

    const controller = new AbortController();
    const t = setTimeout(async () => {
      setBreach({ state: "checking" });
      try {
        const res = await fetch(
          `https://api.xposedornot.com/v1/check-email/${encodeURIComponent(email)}`,
          { signal: controller.signal }
        );
        if (res.status === 404) {
          setBreach({ state: "safe" });
          return;
        }
        if (!res.ok) throw new Error("http " + res.status);
        const data: { breaches?: string[][] } = await res.json();
        const list = (data.breaches?.[0] ?? []).filter(Boolean);
        if (list.length > 0) setBreach({ state: "breached", breaches: list });
        else setBreach({ state: "safe" });
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        setBreach({ state: "error" });
      }
    }, 600);

    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [email]);

  return breach;
}
