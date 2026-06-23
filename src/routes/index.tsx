import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Search, Mail, User, Phone, Database, Github, MessageSquare,
  FileText, Eye, Globe, Shield, Zap, BarChart3, Gift, X,
  ArrowRight, CheckCircle2, Lock, Layers, TrendingUp, Star,
  Link2, Grid3x3, IdCard, KeyRound, UserCircle2, ChevronRight,
} from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { useReveal } from "../hooks/use-reveal";


const COUNTRIES = [
  { code: "BR", name: "Português", flag: "🇧🇷", lang: "pt" },
  { code: "US", name: "English", flag: "🇺🇸", lang: "en" },
  { code: "ES", name: "Español", flag: "🇪🇸", lang: "es" },
  { code: "FR", name: "Français", flag: "🇫🇷", lang: "fr" },
  { code: "DE", name: "Deutsch", flag: "🇩🇪", lang: "de" },
  { code: "IT", name: "Italiano", flag: "🇮🇹", lang: "it" },
  { code: "JP", name: "日本語", flag: "🇯🇵", lang: "ja" },
];

function setTranslateLang(lang: string) {
  const host = window.location.hostname;
  const expire = "Fri, 31 Dec 9999 23:59:59 GMT";
  const value = lang === "pt" ? "" : `/pt/${lang}`;
  // Only attempt domain-scoped cookies on real multi-segment hosts.
  // Single-segment hosts (e.g. "localhost") reject domain=.localhost.
  const parts = host.split(".");
  const domains: string[] = [""];
  if (parts.length > 1) {
    domains.push(host, "." + host, "." + parts.slice(-2).join("."));
  }
  for (const d of domains) {
    document.cookie = `googtrans=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${d ? `;domain=${d}` : ""}`;
    if (value) document.cookie = `googtrans=${value}; expires=${expire}; path=/${d ? `;domain=${d}` : ""}`;
  }
  window.location.reload();
}

function CountrySwitcher() {
  const [open, setOpen] = useState(false);
  const [country, setCountry] = useState(COUNTRIES[0]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const match = document.cookie.match(/googtrans=\/[^/]+\/([a-z-]+)/);
    if (match) {
      const found = COUNTRIES.find(c => c.lang === match[1]);
      if (found) setCountry(found);
    }
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div ref={ref} className="relative notranslate" translate="no">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 rounded-full border border-border bg-card/60 px-3 py-2 text-sm font-medium hover:bg-secondary"
        aria-label="Change country"
      >
        <span className="text-base leading-none">{country.flag}</span>
        <span className="hidden sm:inline">{country.code}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-48 overflow-hidden rounded-2xl border border-border bg-popover shadow-elevated">
          {COUNTRIES.map(c => (
            <button
              key={c.code}
              onClick={() => { setCountry(c); setOpen(false); setTranslateLang(c.lang); }}
              className={`flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-secondary ${country.code === c.code ? "text-primary" : ""}`}
            >
              <span className="text-base">{c.flag}</span>
              <span className="flex-1 text-left">{c.name}</span>
              <span className="text-xs text-muted-foreground">{c.code}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "NoxIntel — Inteligência OSINT para analistas e equipes" },
      { name: "description", content: "Busca OSINT profissional por e-mail, telefone, usuário, vazamentos e mais. Para pesquisadores independentes e equipes de segurança." },
      { property: "og:title", content: "NoxIntel — Inteligência OSINT" },
      { property: "og:description", content: "Busca OSINT profissional por e-mail, telefone, usuário, vazamentos e mais." },
    ],
  }),
  component: Landing,
});

function Landing() {
  const [bannerOpen, setBannerOpen] = useState(true);
  
  useReveal();


  return (
    <div className="min-h-screen text-foreground">


      {bannerOpen && (
        <div className="relative bg-gradient-primary text-primary-foreground">
          <div className="mx-auto flex max-w-7xl items-center justify-center gap-2 px-4 py-2.5 text-sm">
            <Gift className="h-4 w-4" />
            <span>Desconto na primeira compra — use o código <strong className="font-semibold underline">NOXWELCOME</strong> no checkout.</span>
          </div>
          <button onClick={() => setBannerOpen(false)} className="absolute right-3 top-1/2 -translate-y-1/2 opacity-80 hover:opacity-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Nav */}
      <header className="sticky top-0 z-40 mx-auto mt-4 max-w-6xl px-4">
        <nav className="glass flex items-center justify-between rounded-full px-3 py-2">
          <Link to="/" className="flex items-center gap-2 pl-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-primary shadow-glow">
              <Eye className="h-4 w-4 text-primary-foreground" />
            </div>
            <span className="text-sm font-bold tracking-wider">NOXINTEL</span>
          </Link>
          <div className="hidden items-center gap-1 rounded-full bg-background/30 px-2 py-1 text-sm text-muted-foreground md:flex">
            {[
              { label: "Sobre", href: "#sobre" },
              { label: "Preços", href: "/planos", route: true },
              { label: "Blog", href: "#blog" },
              { label: "CTF", href: "#ctf" },
              { label: "Contato", href: "mailto:contato@noxintel.app" },
            ].map(l => (
              l.route ? (
                <Link key={l.label} to={l.href} className="rounded-full px-3 py-1.5 hover:bg-secondary hover:text-foreground">{l.label}</Link>
              ) : (
                <a key={l.label} href={l.href} className="rounded-full px-3 py-1.5 hover:bg-secondary hover:text-foreground">{l.label}</a>
              )
            ))}
          </div>
          <div className="flex items-center gap-2">
            <CountrySwitcher />
            <Link to="/login" className="hidden rounded-full px-4 py-2 text-sm font-medium text-foreground hover:bg-secondary sm:block">Entrar</Link>
            <Link to="/login" className="rounded-full bg-gradient-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-glow transition hover:opacity-90">Cadastrar</Link>
          </div>
        </nav>
      </header>


      {/* Hero */}
      <section className="mx-auto max-w-7xl px-4 pb-16 pt-20 lg:pt-28">
        <div className="grid items-center gap-12 lg:grid-cols-2">
          <div>
            <div className="reveal inline-flex items-center gap-2 rounded-full border border-border bg-card/50 px-4 py-1.5 text-sm text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-primary shadow-glow" />
              OSINT profissional para todo tipo de usuário
            </div>
            <h1 className="reveal mt-6 text-5xl font-bold leading-[1.05] tracking-tight lg:text-7xl" data-reveal-delay="120">
              Inteligência para{" "}
              <span className="relative inline-block">
                <span className="text-gradient-primary">OSINT</span>
                <span className="absolute -inset-x-2 -inset-y-1 -z-10 rounded-md border border-primary/40" />
              </span>
              <br />
              <span className="text-foreground/90">no seu ritmo ou no do seu time</span>
            </h1>
            <p className="reveal mt-6 max-w-xl text-lg text-muted-foreground" data-reveal-delay="240">
              Pesquisadores independentes, estudantes avançados e equipes de segurança usam o mesmo motor — busca poderosa, resultados claros e APIs feitas para organizações quando você precisar.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link to="/login" className="inline-flex items-center gap-2 rounded-full bg-gradient-primary px-6 py-3 font-semibold text-primary-foreground shadow-glow transition hover:opacity-90">
                <CheckCircle2 className="h-4 w-4" /> Entrar
              </Link>
              <Link to="/planos" className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-6 py-3 font-medium hover:bg-card">
                <FileText className="h-4 w-4" /> Ver planos
              </Link>
            </div>

            <a href="#enterprise" className="mt-6 inline-flex items-center gap-1 border-b border-border pb-0.5 text-sm text-muted-foreground hover:text-foreground">
              Equipe ou empresa? Conheça o Enterprise <ArrowRight className="h-3.5 w-3.5" />
            </a>
          </div>

          {/* Feature grid card */}
          
            <div className="lift-3d relative rounded-3xl border border-border bg-gradient-card p-4 shadow-elevated">
              <div className="absolute -top-px left-1/3 right-1/3 h-px bg-gradient-to-r from-transparent via-primary to-transparent" />
              <div className="grid grid-cols-2 gap-3">
                {[
                  { icon: BarChart3, t: "Um único painel", d: "Menos abas: consultas consistentes em um só lugar." },
                  { icon: Search, t: "Busca prática", d: "E-mail, telefone, usuário e mais para fechar casos rápido." },
                  { icon: Shield, t: "Foco em privacidade", d: "Feito para quem investiga com critério e responsabilidade." },
                  { icon: Zap, t: "Cresce com você", d: "Comece sozinho; escale com API e licenças quando precisar." },
                ].map(f => (
                  <div key={f.t} className="lift-3d rounded-2xl border border-border bg-card/40 p-5">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/15 text-primary">
                      <f.icon className="h-5 w-5" />
                    </div>
                    <h3 className="mt-4 font-semibold">{f.t}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{f.d}</p>
                  </div>
                ))}
              </div>
            </div>

        </div>
      </section>


      {/* Live dashboard preview */}
      <section id="blog" className="mx-auto max-w-7xl px-4 py-16">
        <h2 className="reveal text-center text-3xl font-bold tracking-tight lg:text-4xl">O painel real, ao vivo na landing</h2>

        <div className="mt-10 overflow-hidden rounded-3xl border border-border bg-gradient-card shadow-elevated">
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-primary"><Eye className="h-3.5 w-3.5 text-primary-foreground" /></div>
              <span className="font-semibold">NoxIntel</span>
              <span className="text-sm text-muted-foreground">Painel</span>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 animate-pulse rounded-full bg-primary" />Pré-visualização ao vivo · 11</span>
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">NX</div>
            </div>
          </div>

          <div className="p-4 sm:p-6">
            {/* Category pills — como na busca real */}
            <p className="mb-3 text-xs uppercase tracking-wider text-muted-foreground">Escolha a categoria de busca</p>
            <div className="rounded-2xl border border-border bg-card/40 p-2">
              <div className="flex flex-wrap gap-2">
                {[
                  { id: "email", icon: Mail, label: "Email", active: true },
                  { id: "phone", icon: Phone, label: "Telefone" },
                  { id: "username", icon: UserCircle2, label: "Username" },
                  { id: "domain", icon: Globe, label: "Domínio" },
                  { id: "cpf", icon: IdCard, label: "CPF" },
                  { id: "password", icon: KeyRound, label: "Senha" },
                  { id: "name", icon: User, label: "Nome" },
                  { id: "link", icon: Link2, label: "Link" },
                  { id: "blockchain", icon: Grid3x3, label: "Blockchain" },
                  { id: "ip", icon: Globe, label: "IP" },
                ].map(c => (
                  <button key={c.id}
                    className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs sm:text-sm transition ${c.active ? "border-primary/60 bg-primary/10 text-primary shadow-glow" : "border-border bg-secondary/40 text-muted-foreground hover:text-foreground"}`}>
                    <c.icon className="h-3.5 w-3.5" /> {c.label}
                  </button>
                ))}
                <button className="inline-flex items-center justify-center rounded-xl border border-border bg-secondary/40 px-2 py-1.5 text-muted-foreground">
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            {/* Search input */}
            <div className="mt-4 flex gap-2">
              <div className="flex flex-1 items-center gap-2 rounded-2xl border border-border bg-input px-4 py-3 text-sm">
                <Search className="h-4 w-4 text-muted-foreground" />
                <input defaultValue="gm4257026@gmail.com" className="flex-1 bg-transparent outline-none" />
              </div>
              <button className="rounded-2xl bg-gradient-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-glow">
                <ArrowRight className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-2 text-center text-xs text-muted-foreground">Ao buscar, você concorda com os <span className="underline">Termos de uso</span>.</p>

            <p className="mt-6 text-center text-xs text-muted-foreground">
              Cada busca consulta dezenas de módulos OSINT em paralelo (SMTP, Disposable Check, HudsonRock, XposedOrNot, plataformas como Spotify, Facebook, ESPN, PolarSteps e mais) — entre na sua conta para ver os resultados completos.
            </p>
          </div>
        </div>

        <p className="mx-auto mt-6 max-w-3xl text-center text-sm text-muted-foreground">
          Feito para pesquisa legítima, segurança e conformidade regulatória. Proibimos abuso, assédio e uso ilícito.
        </p>
      </section>

      {/* Scenarios */}
      <section id="sobre" className="mx-auto max-w-7xl px-4 py-20">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">Cenários reais</p>
        <h2 className="reveal mt-2 max-w-3xl text-3xl font-bold tracking-tight lg:text-4xl">O que o NoxIntel faz por você, na prática</h2>
        <p className="mt-3 max-w-2xl text-muted-foreground">Três situações do dia a dia em que dados claros economizam tempo, dinheiro e más decisões.</p>

        <div className="mt-10 flex snap-x snap-mandatory gap-4 overflow-x-auto pb-4 md:grid md:grid-cols-3 md:gap-5 md:overflow-visible md:pb-0">
          {[
            { cat: "Jurídico & compliance", title: "Um novo cliente passa um e-mail. Ele é mesmo quem diz?", body: "Verifique se o endereço aparece em vazamentos e se os dados batem.", tool: "OSINT de E-mail", value: "maria.garcia@empresa.com", chips: ["2 vazamentos encontrados", "LinkedIn verificado"] },
            { cat: "E-commerce & suporte", title: "Um comprador apressado quer envio expresso. Confiar?", body: "Verifique telefone e usuário antes de liberar um pedido de alto valor.", tool: "OSINT de Telefone", value: "+55 11 ••• ••9", chips: ["Operadora: Vivo BR", "Risco médio · 3 denúncias"] },
            { cat: "Comunicação & mídia", title: "Uma fonte anônima entra em contato. Existe mesmo?", body: "Confirme perfis e consistência de identidade antes de publicar.", tool: "OSINT de Usuário", value: "@reporter_xyz", chips: ["Encontrado em 4 plataformas", "Ativo desde 2019"] },
          ].map(s => (
            <article key={s.title} className="lift-3d hover-blue-blur w-[85vw] shrink-0 snap-center rounded-3xl border border-border bg-gradient-card p-5 depth-shadow md:w-auto">
              <p className="text-xs font-semibold uppercase tracking-wider text-primary/80">{s.cat}</p>
              <h3 className="mt-3 text-lg font-semibold leading-snug">{s.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{s.body}</p>

              <div className="mt-4 rounded-2xl border border-border bg-background/40 p-4">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>noxintel.app</span><span>{s.tool}</span>
                </div>
                <p className="mt-2 font-mono text-sm">{s.value}</p>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {s.chips.map(c => <span key={c} className="rounded-full bg-primary/15 px-2.5 py-0.5 text-xs text-primary">{c}</span>)}
                </div>
              </div>

              <a href="#" className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">Teste com seu caso <ArrowRight className="h-3.5 w-3.5" /></a>
            </article>
          ))}
        </div>
      </section>

      {/* Plans split */}
      <section id="enterprise" className="mx-auto max-w-7xl px-4 py-20">
        <p className="text-sm font-semibold uppercase tracking-wider text-primary">Individual · Time · Empresa</p>
        <h2 className="reveal mt-2 max-w-3xl text-3xl font-bold tracking-tight lg:text-4xl">Uma plataforma, sozinho ou com muita gente</h2>

        <div className="mt-10 flex snap-x snap-mandatory gap-4 overflow-x-auto pb-4 md:grid md:grid-cols-2 md:gap-5 md:overflow-visible md:pb-0">
          {[
            { tag: "Você / freelancer", title: "Entre, investigue e decida com confiança", body: "Ideal para quem faz OSINT por conta própria ou quer resultados fortes sem complexidade corporativa.", bullets: ["Acesso web com planos diretos", "Blog e recursos para aprender no seu ritmo"], cta: "Acessar", cta2: "Ver preços" },
            { tag: "Times & empresas", title: "Quando OSINT é rotina, não exceção", body: "SOC, consultorias, jurídico, antifraude: volume, repetição e faturamento para empresa.", bullets: ["API documentada e integração de workflow", "Licenças enterprise e suporte empresarial"], cta: "NoxIntel Enterprise", cta2: "Ler o blog" },
          ].map(p => (
            <div key={p.tag} className="hover-blue-blur w-[85vw] shrink-0 snap-center rounded-3xl border border-border bg-gradient-card p-5 md:w-auto">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{p.tag}</p>
              <h3 className="mt-3 text-xl font-bold leading-tight">{p.title}</h3>
              <p className="mt-3 text-sm text-muted-foreground">{p.body}</p>
              <ul className="mt-4 space-y-2">
                {p.bullets.map(b => (
                  <li key={b} className="flex items-start gap-2 text-sm"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />{b}</li>
                ))}
              </ul>
              <div className="mt-5 flex flex-wrap gap-2">
                <button className="rounded-full bg-gradient-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-glow">{p.cta}</button>
                <button className="rounded-full border border-border bg-card/60 px-5 py-2.5 text-sm font-medium">{p.cta2}</button>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-8 flex snap-x snap-mandatory gap-4 overflow-x-auto pb-4 md:grid md:grid-cols-3 md:gap-5 md:overflow-visible md:pb-0">
          {[
            { icon: Layers, t: "Dados unificados", d: "Mesma qualidade de fonte para uma pessoa ou um departamento inteiro." },
            { icon: Zap, t: "Performance", d: "Feito para sessões longas e picos de demanda." },
            { icon: TrendingUp, t: "Caminho claro pra escalar", d: "Do usuário à integração via API sem trocar de mundo." },
          ].map(c => (
            <div key={c.t} className="w-[85vw] shrink-0 snap-center rounded-2xl border border-border bg-card/40 p-5 md:w-auto">
              <c.icon className="h-5 w-5 text-primary" />
              <h4 className="mt-3 font-semibold">{c.t}</h4>
              <p className="mt-1 text-sm text-muted-foreground">{c.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Capabilities */}
      <section id="ctf" className="mx-auto max-w-7xl px-4 py-20">
        <h2 className="reveal max-w-3xl text-3xl font-bold tracking-tight lg:text-5xl">
          Potência que te acompanha <span className="text-muted-foreground">do primeiro indício ao relatório final.</span>
        </h2>
        <div className="mt-10 flex snap-x snap-mandatory gap-4 overflow-x-auto pb-4 md:grid md:grid-cols-3 md:gap-5 md:overflow-visible md:pb-0">
          {[
            { icon: Database, t: "Ingestão massiva de dados", d: "Milhões de registros em várias fontes, unificados para buscas rápidas e consistentes." },
            { icon: BarChart3, t: "Visualizações em linha do tempo", d: "Veja picos e tendências em vazamentos com gráficos otimizados para leitura." },
            { icon: Lock, t: "Integração OSINT extrema", d: "A partir de um e-mail ou usuário, expanda por todos os vazamentos e bases vinculadas." },
          ].map(c => (
            <div key={c.t} className="lift-3d hover-blue-blur group w-[85vw] shrink-0 snap-center rounded-3xl border border-border bg-gradient-card p-5 md:w-auto">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/15 text-primary group-hover:bg-primary group-hover:text-primary-foreground">
                <c.icon className="h-5 w-5" />
              </div>
              <h3 className="mt-4 text-lg font-semibold">{c.t}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{c.d}</p>
              <a href="#" className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary">Saiba mais <ArrowRight className="h-3.5 w-3.5" /></a>
            </div>
          ))}
        </div>
      </section>

      {/* Testimonials */}
      <section className="mx-auto max-w-7xl px-4 py-20">
        <h2 className="reveal text-3xl font-bold tracking-tight lg:text-4xl">O que nossos <span className="text-gradient-primary">clientes profissionais</span> dizem</h2>
        <p className="mt-3 max-w-2xl text-muted-foreground">Pesquisadores independentes, boutiques e equipes de segurança contam como usam o NoxIntel no dia a dia.</p>

        <div className="mt-10 flex snap-x snap-mandatory gap-4 overflow-x-auto pb-4 md:grid md:grid-cols-2 md:gap-5 md:overflow-visible md:pb-0 lg:grid-cols-4">
          {[
            { q: "9/10, super recomendo. A ferramenta funciona perfeitamente e pelo preço entrega muito mais do que promete.", n: "Rox M.", i: "RM" },
            { q: "Quase um ano confiando nessa ferramenta, sempre atualizando, sempre nos surpreendendo. A melhor de OSINT do mercado.", n: "Mario Chin Fern", i: "MCF" },
            { q: "Achei pelo menos 20 vazamentos e resolvi tudo em 2 dias. Melhor ferramenta e muito acessível. 10/10.", n: "Alberto J.", i: "AJ" },
            { q: "Um dos melhores sites de OSINT que já testei. Dá pra ver que tem trabalho de verdade por trás. 10/10.", n: "Vicente", i: "V" },
          ].map(t => (
            <div key={t.n} className="lift-3d hover-blue-blur flex w-[80vw] shrink-0 snap-center flex-col rounded-3xl border border-border bg-gradient-card p-5 depth-shadow md:w-auto">
              <div className="flex gap-0.5 text-primary">
                {Array.from({ length: 5 }).map((_, i) => <Star key={i} className="h-4 w-4 fill-current" />)}
              </div>
              <p className="mt-4 flex-1 text-sm leading-relaxed text-muted-foreground">"{t.q}"</p>
              <div className="mt-5 flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/20 text-xs font-bold text-primary">{t.i}</div>
                <div>
                  <p className="text-sm font-semibold">{t.n}</p>
                  <p className="text-xs text-muted-foreground">Cliente verificado</p>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-10 rounded-3xl border border-border bg-gradient-card p-6 text-center md:mt-12 md:p-8">
          <p className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Confiado por</p>
          <p className="mt-2 text-3xl font-bold md:text-4xl lg:text-5xl"><span className="text-gradient-primary">5.200+ usuários</span> no mundo todo</p>
          <div className="mx-auto mt-6 grid max-w-3xl grid-cols-3 gap-4 md:mt-8 md:gap-6">
            {[["5.200+", "Usuários ativos"], ["99,9%", "Uptime"], ["24/7", "Suporte técnico"]].map(([n, l]) => (
              <div key={l}>
                <p className="text-xl font-bold text-primary md:text-2xl lg:text-3xl">{n}</p>
                <p className="text-xs text-muted-foreground">{l}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-5xl px-4 py-20">
        <div className="rounded-3xl border border-primary/30 bg-gradient-card p-10 text-center shadow-glow">
          <h2 className="reveal text-3xl font-bold tracking-tight lg:text-4xl">Comece em minutos ou <span className="text-gradient-primary">planeje em escala</span></h2>
          <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">Crie acesso, veja os preços ou fale com a gente se precisar de condições para times, faturamento ou implantação assistida.</p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Link to="/login" className="rounded-full bg-gradient-primary px-6 py-3 font-semibold text-primary-foreground shadow-glow transition hover:opacity-90">ACESSAR</Link>
            <a href="mailto:enterprise@noxintel.app" className="rounded-full border border-border bg-card/60 px-6 py-3 font-medium hover:bg-card">Enterprise</a>
          </div>

        </div>
      </section>

      {/* Programa de Revenda */}
      <section id="revenda" className="mx-auto max-w-5xl px-4 pb-20">
        <div className="relative overflow-hidden rounded-3xl border border-primary/40 bg-gradient-card p-10 text-center shadow-glow">
          <div aria-hidden className="pointer-events-none absolute -top-24 left-1/2 h-64 w-64 -translate-x-1/2 rounded-full bg-primary/30 blur-3xl" />
          <span className="inline-flex items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
            <TrendingUp className="h-3.5 w-3.5" /> Programa de Revenda
          </span>
          <h2 className="reveal relative mt-4 text-3xl font-bold tracking-tight lg:text-4xl">
            Seja um <span className="text-gradient-primary">revendedor oficial</span> e ganhe <span className="text-gradient-primary">20% de comissão</span>
          </h2>
          <p className="relative mx-auto mt-3 max-w-2xl text-muted-foreground">
            Indique clientes, venda os planos do NoxIntel e fature 20% sobre cada venda fechada. Suporte, materiais e link de afiliado liberados após aprovação.
          </p>
          <div className="relative mt-7 flex flex-wrap justify-center gap-3">
            <a
              href="https://t.me/controle"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-full bg-gradient-primary px-6 py-3 font-semibold text-primary-foreground shadow-glow transition hover:opacity-90"
            >
              <MessageSquare className="h-4 w-4" /> Falar com @controle no Telegram
            </a>
          </div>
          <p className="relative mt-4 text-xs text-muted-foreground">
            Contato exclusivo via Telegram: <strong className="text-foreground">@controle</strong>
          </p>
        </div>
      </section>


      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-muted-foreground md:flex-row">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-primary"><Eye className="h-3.5 w-3.5 text-primary-foreground" /></div>
            <span className="font-semibold text-foreground">NoxIntel</span>
            <span>© {new Date().getFullYear()}</span>
          </div>
          <div className="flex gap-5">
            <a href="#" className="hover:text-foreground">Termos</a>
            <a href="#" className="hover:text-foreground">Privacidade</a>
            <a href="#" className="hover:text-foreground">Cookies</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
