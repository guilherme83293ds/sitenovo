import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { getMyAccount, listMyPayments, claimFirstAdmin } from "@/lib/billing.functions";
import { Eye, ArrowLeft, Loader2, Shield, CreditCard } from "lucide-react";

export const Route = createFileRoute("/_authenticated/conta")({
  component: AccountPage,
});

function AccountPage() {
  const fetchAccount = useServerFn(getMyAccount);
  const fetchMine = useServerFn(listMyPayments);
  const { data: acc, isLoading } = useQuery({ queryKey: ["account"], queryFn: () => fetchAccount({}) });
  const { data: payments } = useQuery({ queryKey: ["my-payments"], queryFn: () => fetchMine({}) });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/40 backdrop-blur-xl">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-primary shadow-glow"><Eye className="h-4 w-4 text-primary-foreground" /></div>
            <span className="text-lg font-semibold">NoxIntel</span>
          </Link>
          <Link to="/dashboard" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Painel</Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-10 space-y-8">
        <div>
          <h1 className="text-3xl font-bold">Minha conta</h1>
          <p className="text-muted-foreground">{acc?.profile?.email}</p>
        </div>

        {isLoading ? (
          <Loader2 className="h-6 w-6 animate-spin" />
        ) : (
          <>
            <section className="rounded-2xl border border-border bg-card/40 p-6">
              <h2 className="flex items-center gap-2 text-lg font-semibold"><Shield className="h-5 w-5 text-primary" /> Plano atual</h2>
              {acc?.subscription ? (
                <div className="mt-4 grid gap-4 md:grid-cols-3">
                  <Stat label="Plano" value={(acc.subscription as any).plans?.name || acc.subscription.plan_id} />
                  <Stat label="Buscas hoje" value={`${acc.today.searches} / ${(acc.subscription as any).plans?.daily_search_limit}`} />
                  <Stat label="Resultados no mês" value={`${acc.monthResults} / ${(acc.subscription as any).plans?.monthly_result_limit}`} />
                  <Stat label="Expira em" value={new Date(acc.subscription.expires_at).toLocaleDateString("pt-BR")} />
                </div>
              ) : (
                <div className="mt-4 rounded-xl border border-border bg-background/60 p-5">
                  <p className="text-sm text-muted-foreground">Você não tem plano ativo.</p>
                  <Link to="/planos" className="mt-3 inline-flex rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90">Ver planos</Link>
                </div>
              )}
            </section>

            <section className="rounded-2xl border border-border bg-card/40 p-6">
              <h2 className="flex items-center gap-2 text-lg font-semibold"><CreditCard className="h-5 w-5 text-primary" /> Pagamentos</h2>
              <div className="mt-4 divide-y divide-border">
                {(payments ?? []).length === 0 && <p className="text-sm text-muted-foreground">Nenhum pagamento ainda.</p>}
                {(payments ?? []).map((p: any) => (
                  <div key={p.id} className="flex items-center justify-between py-3 text-sm">
                    <div>
                      <div className="font-medium">{p.plans?.name || p.plan_id} — R$ {Number(p.amount_brl).toFixed(2)}</div>
                      <div className="text-xs text-muted-foreground">{new Date(p.created_at).toLocaleString("pt-BR")} • txid: {p.pix_txid}</div>
                    </div>
                    <StatusBadge status={p.status} />
                  </div>
                ))}
              </div>
            </section>

            {acc?.isAdmin ? (
              <Link to="/admin" className="inline-flex items-center gap-2 rounded-xl border border-primary px-4 py-2 text-sm font-semibold text-primary hover:bg-primary/10">
                Painel admin
              </Link>
            ) : (
              <ClaimAdmin />
            )}
          </>
        )}
      </main>
    </div>
  );
}

function ClaimAdmin() {
  const claim = useServerFn(claimFirstAdmin);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="rounded-xl border border-dashed border-border bg-background/40 p-4 text-sm">
      <p className="text-muted-foreground">Se você é o dono do sistema e ainda não há nenhum admin, clique abaixo para se tornar administrador.</p>
      <button
        onClick={async () => {
          const r: any = await claim({});
          setMsg(r?.ok ? "Você agora é admin! Recarregue a página." : "Já existe um admin no sistema.");
        }}
        className="mt-2 rounded-lg border border-border bg-background px-3 py-1.5 text-xs hover:bg-accent"
      >Tornar-me admin (apenas se nenhum admin existir)</button>
      {msg && <p className="mt-2 text-xs">{msg}</p>}
    </div>
  );
}

// useState/useServerFn already imported above

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-background/60 p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold">{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: "bg-amber-500/10 text-amber-400 border-amber-500/30",
    paid: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
    rejected: "bg-red-500/10 text-red-400 border-red-500/30",
    expired: "bg-muted text-muted-foreground border-border",
  };
  const label: Record<string, string> = { pending: "Aguardando", paid: "Aprovado", rejected: "Rejeitado", expired: "Expirado" };
  return <span className={`rounded-full border px-2.5 py-0.5 text-xs ${map[status] || ""}`}>{label[status] || status}</span>;
}
