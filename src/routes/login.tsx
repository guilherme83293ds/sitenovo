import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Eye, Mail, Lock, User, ArrowRight, ShieldCheck, AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable";

const TURNSTILE_SITE_KEY = "0x4AAAAAADo3ucHJnswZ2oYZLsiL5BBRTdg";

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: any) => string;
      reset: (id?: string) => void;
      remove: (id?: string) => void;
    };
  }
}

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Entrar — NoxIntel" },
      { name: "description", content: "Acesse sua conta NoxIntel e continue suas investigações OSINT." },
    ],
    scripts: [{ src: "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", async: true, defer: true }],
  }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const captchaRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

  // 3D tilt
  const cardRef = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ rx: 0, ry: 0, mx: 50, my: 50 });
  function onMouseMove(e: React.MouseEvent) {
    const r = cardRef.current?.getBoundingClientRect();
    if (!r) return;
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    setTilt({ rx: (0.5 - y) * 8, ry: (x - 0.5) * 10, mx: x * 100, my: y * 100 });
  }
  function onMouseLeave() { setTilt({ rx: 0, ry: 0, mx: 50, my: 50 }); }

  type BreachStatus = { state: "idle" | "checking" | "safe" | "error" } | { state: "breached"; breaches: string[] };
  const [breach, setBreach] = useState<BreachStatus>({ state: "idle" });

  useEffect(() => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setBreach({ state: "idle" }); return; }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setBreach({ state: "checking" });
      try {
        const res = await fetch(`https://api.xposedornot.com/v1/check-email/${encodeURIComponent(email)}`, { signal: ctrl.signal });
        if (res.status === 404) return setBreach({ state: "safe" });
        if (!res.ok) throw new Error();
        const data: { breaches?: string[][] } = await res.json();
        const list = (data.breaches?.[0] ?? []).filter(Boolean);
        setBreach(list.length ? { state: "breached", breaches: list } : { state: "safe" });
      } catch (err) {
        if ((err as any).name !== "AbortError") setBreach({ state: "error" });
      }
    }, 600);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [email]);

  useEffect(() => {
    let cancelled = false;
    const render = () => {
      if (cancelled) return;
      if (!window.turnstile || !captchaRef.current || widgetIdRef.current) {
        if (!window.turnstile) setTimeout(render, 200);
        return;
      }
      widgetIdRef.current = window.turnstile.render(captchaRef.current, {
        sitekey: TURNSTILE_SITE_KEY,
        theme: "dark",
        callback: (t: string) => setCaptchaToken(t),
        "expired-callback": () => setCaptchaToken(null),
      });
    };
    render();
    return () => {
      cancelled = true;
      if (widgetIdRef.current && window.turnstile) { try { window.turnstile.remove(widgetIdRef.current); } catch {} widgetIdRef.current = null; }
    };
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setInfo(null);
    setLoading(true);
    try {
      const securityOptions = captchaToken ? { captchaToken } : {};
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email, password,
          options: { data: { full_name: name }, emailRedirectTo: `${window.location.origin}/dashboard`, ...securityOptions },
        });
        if (error) throw error;
        if (data.session) navigate({ to: "/dashboard" });
        else {
          const { error: signInError } = await supabase.auth.signInWithPassword({ email, password, options: securityOptions });
          if (signInError) setInfo("Conta criada! Entre com seu e-mail e senha para continuar.");
          else navigate({ to: "/dashboard" });
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password, options: securityOptions });
        if (error) throw error;
        navigate({ to: "/dashboard" });
      }
    } catch (err: any) {
      setError(err.message || "Erro ao autenticar");
      if (window.turnstile && widgetIdRef.current) { try { window.turnstile.reset(widgetIdRef.current); } catch {} setCaptchaToken(null); }
    } finally { setLoading(false); }
  }

  async function googleLogin() {
    setError(null);
    const result: any = await lovable.auth.signInWithOAuth("google", { redirect_uri: `${window.location.origin}/dashboard` });
    if (result?.error) setError(result.error.message || "Falha no login Google");
    else if (!result?.redirected) navigate({ to: "/dashboard" });
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground" style={{ perspective: "1200px" }}>
      {/* Animated background */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute -top-40 left-1/2 h-[520px] w-[520px] -translate-x-1/2 rounded-full bg-primary/25 blur-3xl animate-pulse" />
        <div className="absolute bottom-0 right-0 h-[400px] w-[400px] rounded-full bg-blue-500/15 blur-3xl animate-pulse" style={{ animationDelay: "1.5s" }} />
        <div className="absolute top-1/3 -left-20 h-[300px] w-[300px] rounded-full bg-cyan-500/10 blur-3xl animate-pulse" style={{ animationDelay: "3s" }} />
        {/* Grid */}
        <div className="absolute inset-0 opacity-[0.04]" style={{ backgroundImage: "linear-gradient(rgba(255,255,255,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.5) 1px, transparent 1px)", backgroundSize: "48px 48px" }} />
      </div>

      <div className="mx-auto flex min-h-screen max-w-md flex-col px-6 py-10">
        <Link to="/" className="flex items-center gap-2 self-start">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-gradient-primary shadow-glow"><Eye className="h-4 w-4 text-primary-foreground" /></div>
          <span className="text-sm font-bold tracking-wider">NOXINTEL</span>
        </Link>

        <div className="my-auto">
          {/* Card with 3D tilt + blue hover blur */}
          <div
            ref={cardRef}
            onMouseMove={onMouseMove}
            onMouseLeave={onMouseLeave}
            className="group relative rounded-3xl transition-transform duration-200 ease-out"
            style={{ transform: `rotateX(${tilt.rx}deg) rotateY(${tilt.ry}deg)`, transformStyle: "preserve-3d" }}
          >
            {/* Spotlight blue glow following mouse */}
            <div
              aria-hidden
              className="pointer-events-none absolute -inset-px rounded-3xl opacity-0 transition-opacity duration-300 group-hover:opacity-100"
              style={{ background: `radial-gradient(360px circle at ${tilt.mx}% ${tilt.my}%, rgba(59,130,246,0.35), transparent 60%)`, filter: "blur(24px)" }}
            />
            {/* Animated gradient border */}
            <div aria-hidden className="pointer-events-none absolute -inset-[1px] rounded-3xl opacity-60 group-hover:opacity-100 transition-opacity"
              style={{ background: "conic-gradient(from var(--angle,0deg), transparent 30%, rgba(59,130,246,0.8), rgba(99,102,241,0.6), transparent 70%)", animation: "spin 6s linear infinite", WebkitMask: "linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)", WebkitMaskComposite: "xor", maskComposite: "exclude", padding: "1px" }}
            />

            <div className="relative rounded-3xl border border-border bg-gradient-card p-8 shadow-elevated backdrop-blur-xl" style={{ transform: "translateZ(40px)" }}>
              {/* Mode toggle */}
              <div className="mb-6 flex rounded-xl border border-border bg-input/40 p-1">
                {(["signin", "signup"] as const).map((m) => (
                  <button key={m} type="button" onClick={() => { setMode(m); setError(null); setInfo(null); }}
                    className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition ${mode === m ? "bg-primary text-primary-foreground shadow-glow" : "text-muted-foreground hover:text-foreground"}`}>
                    {m === "signin" ? "Entrar" : "Cadastrar"}
                  </button>
                ))}
              </div>

              <h1 className="text-2xl font-bold tracking-tight lg:text-3xl animate-fade-in">
                {mode === "signin" ? "Bem-vindo de volta" : "Crie sua conta"}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {mode === "signin" ? "Entre para continuar investigando." : "Comece em segundos. Sem cartão."}
              </p>

              <form onSubmit={onSubmit} className="mt-7 space-y-4">
                {mode === "signup" && (
                  <label className="block animate-fade-in">
                    <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Nome</span>
                    <div className="flex items-center gap-2 rounded-xl border border-border bg-input px-3 py-2.5 transition focus-within:border-primary focus-within:shadow-[0_0_0_3px_rgba(59,130,246,0.15)]">
                      <User className="h-4 w-4 text-muted-foreground" />
                      <input value={name} onChange={e => setName(e.target.value)} required placeholder="Seu nome" className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60" />
                    </div>
                  </label>
                )}

                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-muted-foreground">E-mail</span>
                  <div className="flex items-center gap-2 rounded-xl border border-border bg-input px-3 py-2.5 transition focus-within:border-primary focus-within:shadow-[0_0_0_3px_rgba(59,130,246,0.15)]">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                    <input type="email" required value={email} onChange={e => setEmail(e.target.value)} placeholder="voce@exemplo.com" className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60" />
                  </div>
                  {breach.state === "checking" && <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />Verificando vazamentos...</p>}
                  {breach.state === "safe" && <p className="mt-1.5 flex items-center gap-1.5 text-xs text-emerald-400"><CheckCircle2 className="h-3 w-3" />Nenhum vazamento conhecido.</p>}
                  {breach.state === "breached" && (
                    <div className="mt-1.5 rounded-lg border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
                      <p className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="h-3.5 w-3.5" />Apareceu em {breach.breaches.length} vazamento(s)</p>
                      <p className="mt-1 text-destructive/80">{breach.breaches.slice(0, 4).join(", ")}{breach.breaches.length > 4 ? "..." : ""}</p>
                    </div>
                  )}
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-xs font-medium text-muted-foreground">Senha</span>
                  <div className="flex items-center gap-2 rounded-xl border border-border bg-input px-3 py-2.5 transition focus-within:border-primary focus-within:shadow-[0_0_0_3px_rgba(59,130,246,0.15)]">
                    <Lock className="h-4 w-4 text-muted-foreground" />
                    <input type={show ? "text" : "password"} required minLength={6} value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••" className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60" />
                    <button type="button" onClick={() => setShow(s => !s)} className="text-xs font-medium text-muted-foreground hover:text-foreground">{show ? "Ocultar" : "Mostrar"}</button>
                  </div>
                </label>

                <div className="rounded-xl border border-border bg-input/40 p-3">
                  <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground"><ShieldCheck className="h-3.5 w-3.5 text-primary" />Verificação de segurança</div>
                  <div ref={captchaRef} className="flex min-h-[65px] items-center justify-center" />
                </div>

                {error && <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive animate-fade-in">{error}</p>}
                {info && <p className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400 animate-fade-in">{info}</p>}

                <button type="submit" aria-busy={loading}
                  className="group/btn relative inline-flex w-full cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-xl bg-gradient-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-glow transition hover:scale-[1.02] hover:shadow-[0_0_40px_rgba(59,130,246,0.5)] active:scale-[0.98] aria-busy:opacity-70">
                  <span aria-hidden className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-white/20 to-transparent transition-transform duration-700 group-hover/btn:translate-x-full" />
                  {loading ? <><Loader2 className="h-4 w-4 animate-spin" />Processando...</> : <>{mode === "signin" ? "Entrar" : "Criar conta"}<ArrowRight className="h-4 w-4 transition-transform group-hover/btn:translate-x-1" /></>}
                </button>
              </form>

              <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground">
                <div className="h-px flex-1 bg-border" />ou continue com<div className="h-px flex-1 bg-border" />
              </div>

              <button onClick={googleLogin}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-border bg-card/60 px-4 py-2.5 text-sm font-medium transition hover:bg-card hover:border-primary/50 hover:shadow-[0_0_20px_rgba(59,130,246,0.2)]">
                <svg className="h-4 w-4" viewBox="0 0 24 24"><path fill="currentColor" d="M21.35 11.1H12v2.9h5.35c-.23 1.5-1.7 4.4-5.35 4.4-3.22 0-5.85-2.67-5.85-5.95s2.63-5.95 5.85-5.95c1.84 0 3.07.78 3.78 1.45l2.57-2.48C16.78 3.94 14.65 3 12 3 6.98 3 2.95 7.03 2.95 12s4.03 9 9.05 9c5.22 0 8.68-3.66 8.68-8.83 0-.59-.06-1.04-.13-1.07z"/></svg>
                Continuar com Google
              </button>
            </div>
          </div>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            {mode === "signin" ? "Não tem conta? " : "Já tem conta? "}
            <button onClick={() => { setMode(mode === "signin" ? "signup" : "signin"); setError(null); setInfo(null); }} className="font-semibold text-primary hover:underline">
              {mode === "signin" ? "Cadastre-se" : "Entrar"}
            </button>
          </p>
        </div>

        <p className="mt-8 text-center text-xs text-muted-foreground">
          Protegido por Cloudflare Turnstile · <a href="#" className="hover:text-foreground">Termos</a> e <a href="#" className="hover:text-foreground">Privacidade</a>.
        </p>
      </div>

      <style>{`
        @property --angle { syntax: '<angle>'; initial-value: 0deg; inherits: false; }
        @keyframes spin { to { --angle: 360deg; } }
      `}</style>
    </div>
  );
}
