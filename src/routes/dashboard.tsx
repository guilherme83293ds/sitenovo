import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Eye, Search, Mail, User, Phone, FileText, Settings, LogOut, Bell,
  ChevronDown, Activity, TrendingUp, Shield, Clock, Filter, Download,
  Menu, X, Database, Sparkles, Zap, ArrowUpRight, Globe2,
  AlertTriangle, CheckCircle2, Loader2, Lock, EyeOff,
  CreditCard, Wallet, Link2, Share2, ShieldAlert, Network, Cloud, MapPin,
  UserSearch, Key, Globe, Fingerprint, Hash, Copy,
} from "lucide-react";
import { useState } from "react";
import { useEmailBreach } from "@/hooks/useEmailBreach";
import { usePwnedPassword } from "@/hooks/usePwnedPassword";

export const Route = createFileRoute("/dashboard")({
  head: () => ({
    meta: [
      { title: "Painel — NoxIntel" },
      { name: "description", content: "Painel de controle NoxIntel: ferramentas OSINT, histórico e estatísticas." },
      { property: "og:title", content: "Painel — NoxIntel" },
      { property: "og:description", content: "Painel de controle NoxIntel." },
    ],
  }),
  component: Dashboard,
});

const TOOLS: { id: string; icon: typeof Mail; label: string; desc: string; sample: string; soon?: boolean; tag?: string }[] = [
  { id: "geo", icon: MapPin, label: "GeoIP", desc: "Geolocalização de endereço IP, ISP e informações de localização.", sample: "200.150.10.42" },
  { id: "domain", icon: Globe2, label: "WHOIS", desc: "Informações WHOIS, DNS e detalhes de domínio.", sample: "exemplo.com.br" },
];

const STATS = [
  { icon: Search, label: "Buscas hoje", value: "37", trend: "+12%", spark: [4, 8, 6, 12, 10, 18, 22, 19, 28, 31, 37], accent: true },
  { icon: Database, label: "Vazamentos encontrados", value: "184", trend: "+8%", spark: [40, 55, 48, 80, 95, 120, 140, 138, 160, 170, 184] },
  { icon: Activity, label: "Consultas no mês", value: "412", trend: "+24%", spark: [80, 120, 160, 200, 240, 260, 300, 340, 360, 390, 412] },
  { icon: Shield, label: "Alertas ativos", value: "3", trend: "estável", spark: [2, 3, 2, 4, 3, 3, 2, 3, 3, 3, 3] },
];

const ACTIVITY = [
  { icon: Mail, t: "Busca por e-mail", v: "joao.silva@empresa.com", h: "há 4 min", status: "ok" },
  { icon: User, t: "Busca por usuário", v: "@reporter_xyz", h: "há 22 min", status: "alert" },
  { icon: Phone, t: "Busca por telefone", v: "+55 11 9••••-••99", h: "há 1 h", status: "ok" },
  { icon: Globe2, t: "Análise web", v: "loja-suspeita.shop", h: "há 3 h", status: "alert" },
  { icon: FileText, t: "Metadados", v: "relatorio_q2.pdf", h: "ontem", status: "ok" },
];

function Sparkline({ data, accent = false }: { data: number[]; accent?: boolean }) {
  const max = Math.max(...data);
  const min = Math.min(...data);
  const w = 100, h = 28;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / Math.max(1, max - min)) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const area = `0,${h} ${pts} ${w},${h}`;
  const id = `sg-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-7 w-full">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity={accent ? 0.5 : 0.3} />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill={`url(#${id})`} className="text-primary" />
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary" />
    </svg>
  );
}

function Dashboard() {
  const [activeTool, setActiveTool] = useState("geo");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const tool = TOOLS.find(t => t.id === activeTool)!;
  const [query, setQuery] = useState(tool.sample);
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const emailToCheck = activeTool === "email" ? query : "";
  const breach = useEmailBreach(emailToCheck);
  const pwn = usePwnedPassword(activeTool === "email" ? password : "");

  type Field = { label: string; value: string; mono?: boolean; warn?: boolean; ok?: boolean };
  type Section = { title: string; icon?: string; collapsible?: boolean; fields?: Field[]; list?: string[]; creds?: { email: string; password: string; telefone?: string; url?: string; domain?: string }[]; links?: { label: string; url: string }[] };
  type OsintResult = { ok: boolean; tool: string; query: string; summary?: string; sections: Section[]; sources: string[]; error?: string };
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OsintResult | null>(null);
  const [openSections, setOpenSections] = useState<Record<number, boolean>>({});
  const [credPage, setCredPage] = useState(0);
  const CREDS_PER_PAGE = 30;

  async function runSearch() {
    if (!query.trim() || tool.soon) return;
    setBusy(true);
    setResult(null);
    setCredPage(0);
    try {
      const { supabase } = await import("@/integrations/supabase/client");
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setResult({ ok: false, tool: activeTool, query, error: "Faça login para usar as ferramentas.", sections: [], sources: [] });
        setBusy(false);
        return;
      }
      const r = await fetch("/api/osint", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ tool: activeTool, query: activeTool === "password" ? password || query : query }),
      });
      const data = await r.json() as OsintResult;
      setResult(data);
    } catch (e) {
      setResult({ ok: false, tool: activeTool, query, error: e instanceof Error ? e.message : "Erro de rede", sections: [], sources: [] });
    } finally {
      setBusy(false);
    }
  }


  function exportJson() {
    if (!result) return;
    const blob = new Blob([JSON.stringify(result, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `osint-${activeTool}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="relative flex min-h-screen bg-background text-foreground">
      {/* Ambient background */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-40 left-1/3 h-[420px] w-[420px] rounded-full bg-primary/20 blur-[120px]" />
        <div className="absolute top-1/3 -right-32 h-[380px] w-[380px] rounded-full bg-primary-glow/15 blur-[120px]" />
        <div className="absolute inset-0 bg-[linear-gradient(to_right,oklch(0.4_0.1_260/0.06)_1px,transparent_1px),linear-gradient(to_bottom,oklch(0.4_0.1_260/0.06)_1px,transparent_1px)] bg-[size:48px_48px] [mask-image:radial-gradient(ellipse_at_top,black_30%,transparent_70%)]" />
      </div>

      {/* Sidebar */}
      <aside className={`fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-border bg-card/60 backdrop-blur-xl transition-transform lg:static lg:translate-x-0 ${sidebarOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <Link to="/" className="group flex items-center gap-2.5">
            <div className="relative flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-primary shadow-glow transition group-hover:scale-105">
              <Eye className="h-4 w-4 text-primary-foreground" />
              <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary-glow shadow-glow" />
            </div>
            <div className="flex flex-col leading-none">
              <span className="text-sm font-bold tracking-[0.2em]">NOXINTEL</span>
              <span className="mt-0.5 text-[9px] uppercase tracking-widest text-muted-foreground">OSINT Suite</span>
            </div>
          </Link>
          <button onClick={() => setSidebarOpen(false)} className="lg:hidden" aria-label="Fechar menu">
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-3">
          <p className="px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Ferramentas OSINT</p>
          <div className="space-y-1">
            {TOOLS.map(t => {
              const active = activeTool === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => { if (t.soon) return; setActiveTool(t.id); setQuery(t.sample); setResult(null); setSidebarOpen(false); }}
                  className={`group relative flex w-full items-center gap-2.5 overflow-hidden rounded-xl px-3 py-2.5 text-sm transition ${active ? "bg-primary/15 text-primary shadow-[inset_0_0_0_1px_oklch(0.5_0.18_260/0.35)]" : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground"} ${t.soon ? "opacity-60" : ""}`}
                >
                  {active && <span className="absolute inset-y-1.5 left-0 w-0.5 rounded-r bg-gradient-primary" />}
                  <t.icon className="h-4 w-4" />
                  <span className="font-medium">{t.label}</span>
                  {t.tag && !t.soon && (
                    <span className="ml-auto rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-primary">{t.tag}</span>
                  )}
                  {t.soon && (
                    <span className="ml-auto rounded-full border border-border bg-secondary/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">Em breve</span>
                  )}
                  {active && !t.tag && !t.soon && <ArrowUpRight className="ml-auto h-3.5 w-3.5 opacity-70" />}
                </button>
              );
            })}
          </div>

          <p className="mt-6 px-3 pb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Geral</p>
          <div className="space-y-1">
            <Link to="/planos" className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm text-muted-foreground transition hover:bg-secondary/70 hover:text-foreground">
              <CreditCard className="h-4 w-4" /> Planos & Pix
            </Link>
            <Link to="/conta" className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm text-muted-foreground transition hover:bg-secondary/70 hover:text-foreground">
              <Settings className="h-4 w-4" /> Minha conta
            </Link>
            <button
              onClick={async () => {
                const { supabase } = await import("@/integrations/supabase/client");
                await supabase.auth.signOut();
                window.location.href = "/";
              }}
              className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm text-muted-foreground transition hover:bg-secondary/70 hover:text-foreground"
            >
              <LogOut className="h-4 w-4" /> Sair
            </button>
          </div>

        </nav>

        <div className="border-t border-border p-4">
          <div className="relative overflow-hidden rounded-2xl border border-primary/30 bg-gradient-card p-4">
            <div className="absolute -right-6 -top-6 h-20 w-20 rounded-full bg-primary/30 blur-2xl" />
            <div className="relative">
              <div className="flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5 text-primary" />
                <p className="text-xs font-semibold tracking-wide">Plano Pro</p>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">Buscas: <span className="font-medium text-foreground">412</span> / 1.000</p>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
                <div className="h-full w-[41%] rounded-full bg-gradient-primary shadow-glow" />
              </div>
              <button className="mt-3 w-full rounded-full bg-gradient-primary py-1.5 text-xs font-semibold text-primary-foreground shadow-glow transition hover:brightness-110">
                Fazer upgrade
              </button>
            </div>
          </div>
        </div>
      </aside>

      {sidebarOpen && (
        <div onClick={() => setSidebarOpen(false)} className="fixed inset-0 z-30 bg-background/70 backdrop-blur-sm lg:hidden" />
      )}

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Topbar */}
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-border bg-background/70 px-5 py-3 backdrop-blur-xl">
          <div className="flex items-center gap-3">
            <button onClick={() => setSidebarOpen(true)} className="lg:hidden" aria-label="Abrir menu">
              <Menu className="h-5 w-5" />
            </button>
            <div>
              <p className="text-[11px] uppercase tracking-widest text-muted-foreground">Painel</p>
              <h1 className="text-base font-semibold">Bem-vindo de volta, <span className="text-gradient-primary">Analista</span></h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1.5 text-xs text-muted-foreground md:flex">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
              </span>
              Sistemas operacionais
            </div>
            <button className="relative rounded-full border border-border bg-card/60 p-2 transition hover:bg-secondary" aria-label="Notificações">
              <Bell className="h-4 w-4" />
              <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-primary" />
            </button>
            <button className="flex items-center gap-2 rounded-full border border-border bg-card/60 px-2 py-1.5 transition hover:bg-secondary">
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-primary text-xs font-bold text-primary-foreground shadow-glow">NX</div>
              <span className="hidden text-sm font-medium sm:inline">Analista</span>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </div>
        </header>

        <main className="flex-1 space-y-6 p-5 lg:p-8">
          {/* Stats */}
          <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:grid sm:snap-none sm:gap-4 sm:overflow-visible sm:px-0 sm:pb-0 sm:grid-cols-2 lg:grid-cols-4">
            {STATS.map((s, idx) => (
              <div
                key={s.label}
                className={`group relative w-[60vw] shrink-0 snap-center overflow-hidden rounded-2xl border bg-gradient-card p-3 transition hover:-translate-y-0.5 hover:border-primary/40 sm:w-auto sm:p-5 ${s.accent ? "border-primary/40 shadow-glow" : "border-border"}`}
              >
                {s.accent && <div className="absolute -right-8 -top-8 h-24 w-24 rounded-full bg-primary/25 blur-2xl" />}
                <div className="relative flex items-center justify-between">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/15 text-primary ring-1 ring-primary/20 sm:h-9 sm:w-9 sm:rounded-xl">
                    <s.icon className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  </div>
                  <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                    <TrendingUp className="h-3 w-3" /> {s.trend}
                  </span>
                </div>
                <p className="relative mt-2 text-xl font-bold tracking-tight tabular-nums sm:mt-4 sm:text-3xl">{s.value}</p>
                <p className="relative text-[11px] text-muted-foreground sm:text-xs">{s.label}</p>
                <div className="relative mt-2 opacity-80 sm:mt-3">
                  <Sparkline data={s.spark} accent={s.accent} />
                </div>
              </div>
            ))}
          </div>

          {/* Tool chips */}
          <div className="flex flex-wrap gap-2">
            {TOOLS.map(t => {
              const active = activeTool === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => { if (t.soon) return; setActiveTool(t.id); setQuery(t.sample); setResult(null); }}
                  className={`inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-xs font-medium transition ${active ? "border-primary/50 bg-primary/15 text-primary shadow-glow" : "border-border bg-card/40 text-muted-foreground hover:border-primary/30 hover:text-foreground"} ${t.soon ? "opacity-50 cursor-not-allowed" : ""}`}
                  disabled={t.soon}
                >
                  <t.icon className="h-3.5 w-3.5" /> {t.label}
                  {t.soon && <span className="text-[9px] uppercase tracking-wider text-muted-foreground/70">soon</span>}
                </button>
              );
            })}
          </div>

          {/* Search card */}
          <section className="relative overflow-hidden rounded-3xl border border-border bg-gradient-card shadow-elevated">
            <div className="absolute -right-20 -top-20 h-64 w-64 rounded-full bg-primary/15 blur-3xl" />
            <div className="relative flex items-center gap-3 border-b border-border p-5">
              <div className="relative flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-primary text-primary-foreground shadow-glow">
                <tool.icon className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-semibold">{tool.label}</h2>
                <p className="truncate text-sm text-muted-foreground">{tool.desc}</p>
              </div>
              <span className="hidden items-center gap-1 rounded-full border border-border bg-background/50 px-2.5 py-1 text-[10px] uppercase tracking-wider text-muted-foreground sm:inline-flex">
                <Zap className="h-3 w-3 text-primary" /> Tempo real
              </span>
            </div>

            <div className="relative p-5">
              <div className="group flex flex-col gap-2 rounded-2xl border border-border bg-background/40 p-2 transition focus-within:border-primary/60 focus-within:shadow-glow sm:flex-row sm:items-center">
                <div className="flex flex-1 items-center gap-2 px-2">
                  <Search className="h-4 w-4 text-muted-foreground" />
                  <input
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") runSearch(); }}
                    className="w-full bg-transparent py-2.5 text-sm outline-none placeholder:text-muted-foreground"
                    placeholder={`Digite para buscar em ${tool.label}...`}
                  />
                </div>
                <div className="flex gap-2">
                  <button className="flex items-center gap-2 rounded-xl border border-border bg-card/60 px-3 py-2 text-xs font-medium transition hover:bg-card">
                    <Filter className="h-3.5 w-3.5" /> Filtros
                  </button>
                  <button
                    onClick={runSearch}
                    disabled={busy || tool.soon}
                    className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-glow transition hover:brightness-110 disabled:opacity-50"
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                    {busy ? "Buscando..." : "Buscar"}
                  </button>
                </div>
              </div>

              {activeTool === "email" && breach.state !== "idle" && (
                <div className="mt-3">
                  {breach.state === "checking" && (
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Verificando vazamentos...
                    </p>
                  )}
                  {breach.state === "safe" && (
                    <p className="flex items-center gap-1.5 text-xs text-emerald-400">
                      <CheckCircle2 className="h-3 w-3" />
                      Nenhum vazamento conhecido para este email.
                    </p>
                  )}
                  {breach.state === "breached" && (
                    <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
                      <p className="flex items-center gap-1.5 font-semibold">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        Este email apareceu em {breach.breaches.length} vazamento(s)
                      </p>
                      <p className="mt-1 text-destructive/80">
                        {breach.breaches.slice(0, 4).join(", ")}
                        {breach.breaches.length > 4 ? "..." : ""}
                      </p>
                      <p className="mt-1.5 text-destructive/70">
                        Recomendamos trocar a senha e ativar 2FA.
                      </p>
                    </div>
                  )}
                  {breach.state === "error" && (
                    <p className="text-xs text-muted-foreground/70">
                      Não foi possível verificar vazamentos no momento.
                    </p>
                  )}
                </div>
              )}

              {activeTool === "email" && (
                <div className="mt-3 space-y-2">
                  <div className="group flex items-center gap-2 rounded-2xl border border-border bg-background/40 p-2 transition focus-within:border-primary/60">
                    <Lock className="ml-2 h-4 w-4 text-muted-foreground" />
                    <input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="w-full bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground"
                      placeholder="Verificar se uma senha vazou (opcional)"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="mr-2 rounded-md p-1 text-muted-foreground hover:text-foreground"
                      aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                  {pwn.state === "checking" && (
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Verificando senha...
                    </p>
                  )}
                  {pwn.state === "safe" && (
                    <p className="flex items-center gap-1.5 text-xs text-emerald-400">
                      <CheckCircle2 className="h-3 w-3" />
                      Senha não encontrada em vazamentos conhecidos.
                    </p>
                  )}
                  {pwn.state === "pwned" && (
                    <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
                      <p className="flex items-center gap-1.5 font-semibold">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        Senha vazada {pwn.count.toLocaleString("pt-BR")} vez(es)
                      </p>
                      <p className="mt-1 text-destructive/80">
                        Esta senha aparece em bases públicas de vazamento. Troque imediatamente.
                      </p>
                    </div>
                  )}
                  {pwn.state === "error" && (
                    <p className="text-xs text-muted-foreground/70">
                      Não foi possível verificar a senha agora.
                    </p>
                  )}
                  <p className="text-[10px] text-muted-foreground/60">
                    A senha nunca é enviada — usamos k-anonymity (SHA-1, primeiros 5 caracteres) via HIBP.
                  </p>
                </div>
              )}

              <div className="mt-6 flex flex-wrap items-center justify-between gap-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium">Resultados</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] ${busy ? "bg-primary/20 text-primary" : result ? (result.ok ? "bg-emerald-500/15 text-emerald-400" : "bg-destructive/15 text-destructive") : "bg-secondary text-muted-foreground"}`}>
                    {busy ? "buscando" : result ? (result.ok ? "concluído" : "erro") : "aguardando"}
                  </span>
                </div>
                <button
                  onClick={exportJson}
                  disabled={!result}
                  className="flex items-center gap-1 rounded-full border border-border bg-card/60 px-3 py-1 text-xs text-muted-foreground hover:bg-card disabled:opacity-50"
                >
                  <Download className="h-3 w-3" /> Exportar
                </button>
              </div>

              {!result && !busy && (
                <div className="mt-3 flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-background/30 px-6 py-10 text-center">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Search className="h-4 w-4" />
                  </div>
                  <p className="text-sm font-medium">Nenhuma busca realizada</p>
                  <p className="text-xs text-muted-foreground">Digite um termo acima e clique em Buscar para começar.</p>
                </div>
              )}

              {busy && (
                <div className="mt-3 flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-background/30 px-6 py-10 text-center">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  <p className="text-sm text-muted-foreground">Consultando fontes públicas...</p>
                </div>
              )}

              {result && !result.ok && (
                <div className="mt-3 rounded-2xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                  <p className="flex items-center gap-2 font-semibold">
                    <AlertTriangle className="h-4 w-4" /> Falha na busca
                  </p>
                  <p className="mt-1 text-destructive/80">{result.error}</p>
                </div>
              )}

              {result && result.ok && (
                <div className="mt-3 space-y-4">
                  {(() => {
                    const collapsibles = result.sections.map((s, i) => ({ s, i })).filter(x => x.s.collapsible && x.s.icon);
                    const regular = result.sections.map((s, i) => ({ s, i })).filter(x => !(x.s.collapsible && x.s.icon));
                    return (
                      <>
                        {regular.map(({ s: sec, i }) => (
                          <div key={i} className="rounded-2xl border border-border/50 bg-gradient-to-br from-background/60 to-background/30 p-4 shadow-sm">
                            <h4 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
                              <span className="inline-flex items-center justify-center w-6 h-6 rounded-lg bg-primary/10 text-primary">
                                <Database className="h-3.5 w-3.5" />
                              </span>
                              {sec.title}
                            </h4>
                            {sec.fields && sec.fields.length > 0 && (
                              <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                                {sec.fields.map((f, j) => (
                                  <div key={j} className="flex flex-col rounded-xl border border-border/40 bg-card/50 p-3 hover:border-primary/30 hover:bg-card/80 transition-all">
                                    <dt className="text-[10px] uppercase tracking-wider text-muted-foreground/70">{f.label}</dt>
                                    <dd className={`mt-1 break-all text-sm ${f.mono ? "font-mono" : ""} ${f.warn ? "text-destructive font-medium" : ""} ${f.ok ? "text-emerald-400 font-medium" : "text-foreground"}`}>{f.value}</dd>
                                  </div>
                                ))}
                              </dl>
                            )}
                            {sec.creds && sec.creds.length > 0 && (() => {
                              const totalPages = Math.ceil(sec.creds.length / CREDS_PER_PAGE);
                              const pageCreds = sec.creds.slice(credPage * CREDS_PER_PAGE, (credPage + 1) * CREDS_PER_PAGE);
                              return (
                                <div>
                                  <div className="flex items-center gap-2 mb-3">
                                    <span className="inline-flex items-center gap-1.5 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-1 text-xs font-bold uppercase tracking-wider text-red-400">
                                      <ShieldAlert className="h-3.5 w-3.5" /> Credenciais
                                    </span>
                                    <span className="text-xs text-muted-foreground">{sec.creds.length} pares únicos</span>
                                  </div>
                                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-4 gap-2 w-full">
                                    {pageCreds.map((c, j) => {
                                      const idx = credPage * CREDS_PER_PAGE + j;
                                      const emailKey = `e-${idx}`;
                                      const passKey = `p-${idx}`;
                                      return (
                                        <div key={idx} className="group relative rounded-xl border border-border/50 bg-gradient-to-br from-card/60 to-card/40 p-3 transition-all hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5">
                                          <div className="flex items-center justify-between mb-2.5">
                                            <span className="font-mono text-[10px] text-muted-foreground/50">#{idx + 1}</span>
                                            {c.domain && <span className="inline-flex items-center gap-1 rounded-md bg-primary/10 border border-primary/20 px-2 py-0.5 font-mono text-[10px] text-primary truncate max-w-[150px]" title={c.domain}><Globe className="h-2.5 w-2.5 shrink-0" />{c.domain}</span>}
                                          </div>
                                          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                            <div className="group/cred relative overflow-hidden rounded-xl border border-red-500/20 bg-gradient-to-br from-red-950/30 via-red-900/10 to-transparent p-3 shadow-sm transition-all duration-300 hover:border-red-400/40 hover:shadow-lg hover:shadow-red-500/10 hover:from-red-900/40 hover:via-red-800/20">
                                              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(239,68,68,0.08),transparent_70%)]" />
                                              <div className="relative z-10 flex items-center gap-1.5 mb-1">
                                                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-red-400/15">
                                                  <Mail className="h-2.5 w-2.5 text-red-400" />
                                                </div>
                                                <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-red-400/70">Email</span>
                                              </div>
                                              <div className="relative z-10 rounded-lg bg-black/30 px-3 py-2 font-mono text-[11px] leading-relaxed tracking-wide text-red-200/90 break-all ring-1 ring-inset ring-red-500/15 shadow-inner">
                                                {c.email}
                                              </div>
                                            </div>
                                            <div className="group/cred relative overflow-hidden rounded-xl border border-amber-500/20 bg-gradient-to-br from-amber-950/30 via-amber-900/10 to-transparent p-3 shadow-sm transition-all duration-300 hover:border-amber-400/40 hover:shadow-lg hover:shadow-amber-500/10 hover:from-amber-900/40 hover:via-amber-800/20">
                                              <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_right,rgba(217,119,6,0.08),transparent_70%)]" />
                                              <div className="relative z-10 flex items-center gap-1.5 mb-1">
                                                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-amber-400/15">
                                                  <Lock className="h-2.5 w-2.5 text-amber-400" />
                                                </div>
                                                <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-amber-400/70">Senha</span>
                                              </div>
                                              <div className="relative z-10 rounded-lg bg-black/30 px-3 py-2 font-mono text-[11px] leading-relaxed tracking-wide text-amber-200/90 break-all ring-1 ring-inset ring-amber-500/15 shadow-inner">
                                                {c.password}
                                              </div>
                                            </div>
                                            {c.telefone && (
                                              <div className="sm:col-span-2 flex items-center gap-2 rounded-lg border border-border/30 bg-background/20 px-3 py-2">
                                                <Phone className="h-3 w-3 text-muted-foreground/60" />
                                                <span className="font-mono text-[11px] text-muted-foreground/70">{c.telefone}</span>
                                              </div>
                                            )}
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              );
                            })()}
                            {sec.list && sec.list.length > 0 && (
                              <div className="space-y-1.5">
                                {sec.list.map((it, j) => (
                                  <div key={j} className="flex items-center gap-2 rounded-lg border border-border/50 bg-card/40 px-3 py-2 font-mono text-xs transition hover:border-primary/30 hover:bg-card/60">
                                    <span className="text-muted-foreground/50">•</span>
                                    <span className="break-all text-foreground">{it}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                            {sec.links && sec.links.length > 0 && (
                              <div className="flex flex-wrap gap-2">
                                {sec.links.map((l, j) => (
                                  <a key={j} href={l.url} target="_blank" rel="noopener noreferrer" className="group inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card/60 px-3 py-1.5 text-xs text-muted-foreground transition hover:border-primary/40 hover:text-primary hover:bg-primary/5 hover:shadow-sm">
                                    {l.label}
                                    <ArrowUpRight className="h-3 w-3 group-hover:translate-x-0.5 transition-transform" />
                                  </a>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                        {collapsibles.length > 0 && (
                          <div className="rounded-2xl border border-border/50 bg-gradient-to-br from-background/60 to-background/30 p-4 shadow-sm">
                            <h4 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
                              <span className="inline-flex items-center justify-center w-6 h-6 rounded-lg bg-primary/10 text-primary">
                                <Network className="h-3.5 w-3.5" />
                              </span>
                              Plataformas verificadas <span className="text-xs font-normal text-muted-foreground">({collapsibles.length})</span>
                            </h4>
                            <div className="flex flex-wrap gap-2">
                              {collapsibles.map(({ s: sec, i }) => {
                                const open = !!openSections[i];
                                const name = sec.title.split(" — ")[0];
                                const found = sec.fields?.[0]?.ok;
                                return (
                                  <div key={i} className="w-full sm:w-auto">
                                    <button
                                      onClick={() => setOpenSections(o => ({ ...o, [i]: !o[i] }))}
                                      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition ${open ? "border-primary/50 bg-primary/10 text-primary shadow-sm shadow-primary/5" : "border-border/60 bg-card/60 text-foreground hover:border-primary/40 hover:bg-primary/5"} ${found ? "ring-1 ring-destructive/40" : ""}`}
                                      title={sec.title}
                                    >
                                      <img src={sec.icon} alt="" className="h-4 w-4 rounded-sm" loading="lazy" />
                                      <span>{name}</span>
                                      {found && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-destructive animate-pulse" />}
                                    </button>
                                    {open && sec.fields && (
                                      <div className="mt-2 rounded-xl border border-border/40 bg-card/50 p-3 animate-slide-down">
                                        <div className="mb-2 flex items-center gap-2">
                                          <img src={sec.icon} alt="" className="h-4 w-4 rounded-sm" />
                                          <span className="text-xs font-semibold">{sec.title}</span>
                                        </div>
                                        <dl className="grid gap-1.5 sm:grid-cols-2">
                                          {sec.fields.map((f, j) => (
                                            <div key={j} className="flex flex-col rounded-lg border border-border/40 bg-background/40 p-2.5 hover:border-primary/30 hover:bg-background/60 transition-all">
                                              <dt className="text-[10px] uppercase tracking-wider text-muted-foreground/70">{f.label}</dt>
                                              <dd className={`mt-0.5 break-all text-xs ${f.mono ? "font-mono" : ""} ${f.warn ? "text-destructive font-medium" : ""} ${f.ok ? "text-emerald-400 font-medium" : "text-foreground"}`}>{f.value}</dd>
                                            </div>
                                          ))}
                                        </dl>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </>
                    );
                  }                    )()}
                </div>
              )}
            </div>
          </section>

          {/* History + tips */}
          <section className="grid gap-5 lg:grid-cols-3">
            <div className="rounded-3xl border border-border bg-gradient-card p-5 lg:col-span-2">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h3 className="font-semibold">Atividade recente</h3>
                  <p className="text-xs text-muted-foreground">Últimas consultas realizadas na sua conta</p>
                </div>
                <a href="#" className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                  Ver tudo <ArrowUpRight className="h-3 w-3" />
                </a>
              </div>
              <div className="space-y-2">
                {ACTIVITY.map((h, i) => (
                  <div
                    key={i}
                    className="group flex items-center gap-3 rounded-2xl border border-border bg-background/40 px-4 py-3 text-sm transition hover:-translate-y-0.5 hover:border-primary/40 hover:bg-background/60"
                  >
                    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1 ${h.status === "alert" ? "bg-destructive/10 text-destructive ring-destructive/20" : "bg-primary/10 text-primary ring-primary/20"}`}>
                      <h.icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{h.t}</p>
                      <p className="truncate text-xs text-muted-foreground">{h.v}</p>
                    </div>
                    <span className="inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" /> {h.h}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="relative overflow-hidden rounded-3xl border border-border bg-gradient-card p-5">
              <div className="absolute -right-10 -bottom-10 h-40 w-40 rounded-full bg-primary/15 blur-3xl" />
              <div className="relative">
                <div className="mb-4 flex items-center gap-2">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/15 text-primary">
                    <Sparkles className="h-3.5 w-3.5" />
                  </div>
                  <h3 className="font-semibold">Dicas rápidas</h3>
                </div>
                <ul className="space-y-3 text-sm">
                  {[
                    "Combine e-mail e usuário para reduzir falsos positivos.",
                    "Use filtros por data para isolar vazamentos recentes.",
                    "Exporte os resultados em JSON para integrar ao seu workflow.",
                    "Ative monitoramento contínuo para alvos prioritários.",
                  ].map((tip, i) => (
                    <li key={i} className="flex gap-2.5 text-muted-foreground">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-gradient-primary shadow-glow" />
                      <span>{tip}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
