import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listAllPayments, adminApprovePayment, adminRejectPayment, getPixSettings, adminUpdatePixSettings, getMyAccount } from "@/lib/billing.functions";
import { Eye, ArrowLeft, Check, X, Loader2, Settings } from "lucide-react";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/_authenticated/admin")({
  component: AdminPage,
});

function AdminPage() {
  const qc = useQueryClient();
  const fetchAcc = useServerFn(getMyAccount);
  const fetchAll = useServerFn(listAllPayments);
  const fetchPix = useServerFn(getPixSettings);
  const approve = useServerFn(adminApprovePayment);
  const reject = useServerFn(adminRejectPayment);
  const savePix = useServerFn(adminUpdatePixSettings);

  const { data: acc } = useQuery({ queryKey: ["account"], queryFn: () => fetchAcc({}) });
  const { data: payments, isLoading } = useQuery({ queryKey: ["all-payments"], queryFn: () => fetchAll({}), enabled: !!acc?.isAdmin });
  const { data: pix } = useQuery({ queryKey: ["pix"], queryFn: () => fetchPix({}) });

  const [form, setForm] = useState({ pix_key: "", pix_receiver_name: "", pix_city: "" });
  useEffect(() => { if (pix) setForm(pix); }, [pix]);

  const aprovar = useMutation({
    mutationFn: (id: string) => approve({ data: { paymentId: id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["all-payments"] }),
  });
  const rejeitar = useMutation({
    mutationFn: (id: string) => reject({ data: { paymentId: id, reason: "Pagamento não localizado" } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["all-payments"] }),
  });
  const salvar = useMutation({
    mutationFn: () => savePix({ data: form }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pix"] }),
  });

  if (acc && !acc.isAdmin) {
    return <div className="p-10 text-center text-muted-foreground">Acesso restrito a administradores.</div>;
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/40 backdrop-blur-xl">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-primary shadow-glow"><Eye className="h-4 w-4 text-primary-foreground" /></div>
            <span className="text-lg font-semibold">NoxIntel <span className="text-xs text-primary">admin</span></span>
          </Link>
          <Link to="/dashboard" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Painel</Link>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-8 px-6 py-10">
        <section className="rounded-2xl border border-border bg-card/40 p-6">
          <h2 className="flex items-center gap-2 text-lg font-semibold"><Settings className="h-5 w-5 text-primary" /> Configuração Pix</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <Input label="Chave Pix" value={form.pix_key} onChange={(v) => setForm({ ...form, pix_key: v })} />
            <Input label="Nome do recebedor" value={form.pix_receiver_name} onChange={(v) => setForm({ ...form, pix_receiver_name: v })} />
            <Input label="Cidade" value={form.pix_city} onChange={(v) => setForm({ ...form, pix_city: v })} />
          </div>
          <button onClick={() => salvar.mutate()} disabled={salvar.isPending} className="mt-4 inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
            {salvar.isPending && <Loader2 className="h-4 w-4 animate-spin" />} Salvar
          </button>
        </section>

        <section className="rounded-2xl border border-border bg-card/40 p-6">
          <h2 className="text-lg font-semibold">Pagamentos pendentes</h2>
          {isLoading ? <Loader2 className="mt-4 h-5 w-5 animate-spin" /> : (
            <div className="mt-4 divide-y divide-border">
              {(payments ?? []).length === 0 && <p className="text-sm text-muted-foreground">Nenhum pagamento.</p>}
              {(payments ?? []).map((p: any) => (
                <div key={p.id} className="flex flex-col gap-3 py-4 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{p.plans?.name || p.plan_id} — R$ {Number(p.amount_brl).toFixed(2)} • <span className={p.status === "pending" ? "text-amber-400" : p.status === "paid" ? "text-emerald-400" : "text-red-400"}>{p.status}</span></div>
                    <div className="text-xs text-muted-foreground">user: {p.user_id} • txid: {p.pix_txid} • {new Date(p.created_at).toLocaleString("pt-BR")}</div>
                    {p.proof_note && <div className="mt-1 text-xs">📄 {p.proof_note}</div>}
                  </div>
                  {p.status === "pending" && (
                    <div className="flex gap-2">
                      <button onClick={() => aprovar.mutate(p.id)} disabled={aprovar.isPending} className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600 disabled:opacity-50"><Check className="h-3.5 w-3.5" /> Aprovar</button>
                      <button onClick={() => rejeitar.mutate(p.id)} disabled={rejeitar.isPending} className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-3 py-1.5 text-xs hover:bg-accent disabled:opacity-50"><X className="h-3.5 w-3.5" /> Rejeitar</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

function Input({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full rounded-xl border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary" />
    </label>
  );
}
