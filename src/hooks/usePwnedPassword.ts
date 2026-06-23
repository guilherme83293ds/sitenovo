import { useEffect, useState } from "react";

export type PwnStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "safe" }
  | { state: "pwned"; count: number }
  | { state: "error" };

async function sha1Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

export function usePwnedPassword(password: string): PwnStatus {
  const [status, setStatus] = useState<PwnStatus>({ state: "idle" });

  useEffect(() => {
    if (!password || password.length < 4) {
      setStatus({ state: "idle" });
      return;
    }
    const controller = new AbortController();
    const t = setTimeout(async () => {
      setStatus({ state: "checking" });
      try {
        const hash = await sha1Hex(password);
        const prefix = hash.slice(0, 5);
        const suffix = hash.slice(5);
        const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error("http " + res.status);
        const text = await res.text();
        const line = text
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.toUpperCase().startsWith(suffix));
        if (line) {
          const count = parseInt(line.split(":")[1] ?? "0", 10);
          setStatus({ state: "pwned", count });
        } else {
          setStatus({ state: "safe" });
        }
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        setStatus({ state: "error" });
      }
    }, 500);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [password]);

  return status;
}
