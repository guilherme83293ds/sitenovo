import { useEffect, useState } from "react";
import { Eye } from "lucide-react";

export function LoadingScreen({ durationMs = 1600 }: { durationMs?: number }) {
  const [show, setShow] = useState(true);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    const t1 = setTimeout(() => setFading(true), durationMs - 350);
    const t2 = setTimeout(() => setShow(false), durationMs);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [durationMs]);

  if (!show) return null;

  return (
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center bg-background transition-opacity duration-300 ${
        fading ? "opacity-0" : "opacity-100"
      }`}
      aria-hidden={fading}
    >
      {/* animated grid */}
      <div className="loader-grid absolute inset-0 opacity-40" />
      {/* radial glow */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_50%_40%_at_50%_50%,oklch(0.5_0.22_260/0.35),transparent_70%)]" />

      <div className="relative flex flex-col items-center" style={{ perspective: "1200px" }}>
        {/* 3D orb */}
        <div className="loader-orb relative h-32 w-32">
          <div className="loader-ring loader-ring-1" />
          <div className="loader-ring loader-ring-2" />
          <div className="loader-ring loader-ring-3" />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="loader-core flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-primary shadow-glow">
              <Eye className="h-7 w-7 text-primary-foreground" />
            </div>
          </div>
        </div>

        <div className="mt-10 flex flex-col items-center">
          <span className="text-sm font-bold tracking-[0.4em] text-foreground">
            NOXINTEL
          </span>
          <span className="mt-2 text-xs uppercase tracking-[0.3em] text-muted-foreground">
            Inicializando inteligência
          </span>
          {/* progress bar */}
          <div className="mt-5 h-[3px] w-48 overflow-hidden rounded-full bg-secondary">
            <div className="loader-bar h-full w-1/3 rounded-full bg-gradient-primary" />
          </div>
        </div>
      </div>
    </div>
  );
}
