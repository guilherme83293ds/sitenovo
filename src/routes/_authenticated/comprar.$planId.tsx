import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect } from "react";
import { Check, Loader2, ArrowLeft, Eye, Clock, ExternalLink } from "lucide-react";
import { listPlans, createPixPayment, listMyPayments, checkPaymentStatus } from "@/lib/billing.functions";

export const Route = createFileRoute("/_authenticated/comprar/$planId")({
  component: BuyPage,
});

function BuyPage() {
  const { planId } = useParams({ from: "/_authenticated/comprar/$planId" });
  const qc = useQueryClient();
  const fetchPlans = useServerFn(listPlans);
  const fetchMine = useServerFn(listMyPayments);
  const createPay = useServerFn(createPixPayment);
  const checkStatus = useServerFn(checkPaymentStatus);

  const { data: plans } = useQuery({ queryKey: ["plans"], queryFn: () => fetchPlans({}) });
  const { data: mine, refetch } = useQuery({ queryKey: ["my-payments"], queryFn: () => fetchMine({}), refetchInterval: 5000 });

  const plan = (plans ?? []).find((p: any) => p.id === planId);
  const pending = (mine ?? []).find((p: any) => p.plan_id === planId && p.status === "pending");
  const recentlyPaid = (mine ?? []).find((p: any) => p.plan_id === planId && p.status === "paid");

  const create = useMutation({
    mutationFn: () => createPay({ data: { planId } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["my-payments"] }); refetch(); },
  });

  useEffect(() => {
    if (plans && mine && !pending && !recentlyPaid && !create.isPending && !create.data) {
      create.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plans, mine]);

  // Poll Stripe directly while pending (in case webhook isn't configured yet)
  useEffect(() => {
    if (!pending) return;
    const i = setInterval(() => {
      checkStatus({ data: { paymentId: pending.id } }).then((r: any) => {
        if (r.status === "paid") { refetch(); qc.invalidateQueries({ queryKey: ["my-payments"] }); }
      }).catch(() => {});
    }, 4000);
    return () => clearInterval(i);
  }, [pending?.id]);

  if (!plan) return <div className="p-10">Plano não encontrado.</div>;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/40 backdrop-blur-xl">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-primary shadow-glow"><Eye className="h-4 w-4 text-primary-foreground" /></div>
            <span className="text-lg font-semibold">NoxIntel</span>
          </Link>
          <Link to="/planos" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Outros planos</Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-12">
        <h1 className="text-3xl font-bold">Pagar com Pix — {plan.name}</h1>
        <p className="mt-1 text-muted-foreground">R$ {Number(plan.price_brl).toFixed(2)} • {plan.daily_search_limit} buscas/dia • {plan.monthly_result_limit} resultados/mês</p>

        {recentlyPaid ? (
          <div className="mt-8 rounded-2xl border border-emerald-500/40 bg-emerald-500/5 p-6">
            <div className="flex items-center gap-2 text-emerald-400"><Check className="h-5 w-5" /> Pagamento aprovado! Plano ativo.</div>
            <Link to="/dashboard" className="mt-4 inline-flex rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">Ir para o painel</Link>
          </div>
        ) : pending ? (
          <div className="mt-8 rounded-2xl border border-border bg-card/40 p-6">
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-sm text-amber-500"><Clock className="h-4 w-4" /> Aguardando pagamento — confirma automaticamente</div>

              <div className="rounded-xl border border-border bg-background/60 p-4">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Valor</div>
                <div className="mt-1 text-3xl font-bold">R$ {Number(pending.amount_brl).toFixed(2)}</div>
              </div>

              {pending.pix_copy_paste && (
                <a href={pending.pix_copy_paste} className="inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground hover:opacity-90">
                  Abrir Pix seguro <ExternalLink className="h-4 w-4" />
                </a>
              )}

              {pending.pix_expires_at && (
                <div className="text-xs text-muted-foreground">Válido até {new Date(pending.pix_expires_at).toLocaleString("pt-BR")}</div>
              )}

              <Link to="/conta" className="block text-sm text-primary hover:underline">
                Ver status no painel <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>
        ) : (
          <div className="mt-8 flex flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-card/40 p-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <div className="text-sm text-muted-foreground">Gerando seu Pix no Stripe…</div>
            {create.isError && <div className="text-xs text-red-400">{(create.error as any)?.message}</div>}
          </div>
        )}
      </main>
    </div>
  );
}
