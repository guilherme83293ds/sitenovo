import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, Eye, Sparkles, Zap, Crown, Loader2, ArrowLeft } from "lucide-react";
import { listPlans } from "@/lib/billing.functions";
import { supabase } from "@/integrations/supabase/client";
import { useState } from "react";

export const Route = createFileRoute("/planos")({
  head: () => ({
    meta: [
      { title: "Planos — NoxIntel" },
      { name: "description", content: "Escolha o plano ideal: Starter, Pro ou Super. Pagamento via Pix." },
      { property: "og:title", content: "Planos — NoxIntel" },
      { property: "og:description", content: "Planos OSINT com pagamento via Pix." },
    ],
  }),
  component: PlansPage,
});

const ICONS: Record<string, typeof Sparkles> = { starter: Sparkles, pro: Zap, super: Crown };

function PlansPage() {
  const navigate = useNavigate();
  const fetchPlans = useServerFn(listPlans);
  const [going, setGoing] = useState<string | null>(null);
  const { data: plans, isLoading } = useQuery({
    queryKey: ["plans"],
    queryFn: () => fetchPlans({}),
  });

  async function choose(planId: string) {
    setGoing(planId);
    window.open("https://t.me/controletotal", "_blank", "noopener,noreferrer");
    setGoing(null);
  }


  return (
    <div className="min-h-screen bg-background text-foreground">
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-40 left-1/3 h-[420px] w-[420px] rounded-full bg-primary/20 blur-[120px]" />
        <div className="absolute top-1/3 -right-32 h-[380px] w-[380px] rounded-full bg-primary-glow/15 blur-[120px]" />
      </div>
      <header className="border-b border-border bg-card/40 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-primary shadow-glow">
              <Eye className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="text-lg font-semibold">NoxIntel</span>
          </Link>
          <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> Voltar
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-16">
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight md:text-5xl">Escolha seu plano</h1>
          <p className="mx-auto mt-3 max-w-xl text-muted-foreground">
            Acesso completo a todas as ferramentas OSINT. Pagamento único mensal via <span className="font-semibold text-foreground">Pix</span>.
          </p>
        </div>

        {isLoading ? (
          <div className="mt-16 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="mt-12 grid gap-6 md:grid-cols-3">
            {(plans ?? []).map((p: any) => {
              const Icon = ICONS[p.id] || Sparkles;
              const highlight = p.id === "pro";
              return (
                <div
                  key={p.id}
                  className={`relative flex flex-col rounded-2xl border p-8 ${highlight ? "border-primary bg-card/80 shadow-glow" : "border-border bg-card/40"}`}
                >
                  {highlight && (
                    <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground">
                      Mais popular
                    </span>
                  )}
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Icon className="h-5 w-5" />
                    </div>
                    <h3 className="text-xl font-semibold">{p.name}</h3>
                  </div>
                  <div className="mt-6 flex items-baseline gap-1">
                    <span className="text-4xl font-bold">R$ {Number(p.price_brl).toFixed(0)}</span>
                    <span className="text-sm text-muted-foreground">/mês</span>
                  </div>
                  <ul className="mt-6 flex-1 space-y-2.5 text-sm">
                    {(p.features as string[]).map((f) => (
                      <li key={f} className="flex items-start gap-2">
                        <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-primary" />
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                  <button
                    onClick={() => choose(p.id)}
                    disabled={going === p.id}
                    className={`mt-8 inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:opacity-50 ${highlight ? "bg-primary text-primary-foreground hover:bg-primary/90" : "border border-border bg-background hover:bg-accent"}`}
                  >
                    {going === p.id ? <Loader2 className="h-4 w-4 animate-spin" /> : "Pagar com Pix"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
