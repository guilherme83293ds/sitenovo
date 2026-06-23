import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";

function publicClient() {
  return createClient<Database>(process.env.SUPABASE_URL!, process.env.SUPABASE_PUBLISHABLE_KEY!, {
    auth: { storage: undefined, persistSession: false, autoRefreshToken: false },
  });
}

export const listPlans = createServerFn({ method: "GET" }).handler(async () => {
  const sb = publicClient();
  const { data, error } = await sb.from("plans").select("*").eq("active", true).order("sort");
  if (error) throw new Error(error.message);
  return data ?? [];
});

export const getPixSettings = createServerFn({ method: "GET" }).handler(async () => {
  const sb = publicClient();
  const { data } = await sb.from("app_settings").select("key,value").in("key", ["pix_key", "pix_receiver_name", "pix_city"]);
  const map: Record<string, string> = {};
  (data ?? []).forEach((r: any) => (map[r.key] = r.value));
  return {
    pix_key: map.pix_key || "",
    pix_receiver_name: map.pix_receiver_name || "NoxIntel",
    pix_city: map.pix_city || "SAO PAULO",
  };
});

export const getMyAccount = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }: any) => {
    const sb = context.supabase;
    const userId = context.userId;
    const [{ data: sub }, { data: usage }, { data: roles }, { data: profile }] = await Promise.all([
      sb.from("subscriptions").select("*, plans(*)").eq("user_id", userId).eq("status", "active").gt("expires_at", new Date().toISOString()).order("expires_at", { ascending: false }).limit(1).maybeSingle(),
      sb.from("search_usage").select("*").eq("user_id", userId).order("day", { ascending: false }).limit(31),
      sb.from("user_roles").select("role").eq("user_id", userId),
      sb.from("profiles").select("*").eq("id", userId).maybeSingle(),
    ]);
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
    const todayRow = (usage ?? []).find((u: any) => u.day === today);
    const monthStart = today.slice(0, 7);
    const monthResults = (usage ?? []).filter((u: any) => u.day.startsWith(monthStart)).reduce((a: number, u: any) => a + (u.results || 0), 0);
    return {
      profile,
      subscription: sub,
      isAdmin: (roles ?? []).some((r: any) => r.role === "admin"),
      today: { searches: todayRow?.searches || 0, results: todayRow?.results || 0 },
      monthResults,
    };
  });

export const listMyPayments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }: any) => {
    const { data, error } = await context.supabase.from("payments").select("*, plans(name)").eq("user_id", context.userId).order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const createPixPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { planId: string }) => d)
  .handler(async ({ data, context }: any) => {
    const sb = context.supabase;
    const { data: plan, error: pErr } = await sb.from("plans").select("*").eq("id", data.planId).eq("active", true).maybeSingle();
    if (pErr || !plan) throw new Error("Plano não encontrado");

    const { data: profile } = await sb.from("profiles").select("email,full_name").eq("id", context.userId).maybeSingle();

    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2024-06-20" as any });

    const amountCents = Math.round(Number(plan.price_brl) * 100);
    const origin = getRequestHeader("origin") || process.env.SITE_URL || "http://localhost:8080";
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["pix"],
      customer_email: profile?.email || undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "brl",
          unit_amount: amountCents,
          product_data: { name: `NoxIntel — ${plan.name}` },
        },
      }],
      payment_intent_data: {
        description: `NoxIntel — ${plan.name}`,
        receipt_email: profile?.email || undefined,
        metadata: { user_id: context.userId, plan_id: plan.id, plan_name: plan.name },
      },
      success_url: `${origin}/conta`,
      cancel_url: `${origin}/planos`,
    });

    const { data: payment, error } = await sb.from("payments").insert({
      user_id: context.userId,
      plan_id: plan.id,
      amount_brl: plan.price_brl,
      pix_key: "stripe_checkout",
      pix_txid: session.id,
      stripe_payment_intent_id: typeof session.payment_intent === "string" ? session.payment_intent : null,
      pix_qr_code: null,
      pix_copy_paste: session.url,
      pix_expires_at: session.expires_at ? new Date(session.expires_at * 1000).toISOString() : null,
      status: "pending",
    }).select().single();
    if (error) throw new Error(error.message);
    return payment;
  });

export const checkPaymentStatus = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { paymentId: string }) => d)
  .handler(async ({ data, context }: any) => {
    const sb = context.supabase;
    const { data: p } = await sb.from("payments").select("*").eq("id", data.paymentId).eq("user_id", context.userId).maybeSingle();
    if (!p) throw new Error("not_found");
    if (p.status === "paid") return { status: "paid" };

    const Stripe = (await import("stripe")).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2024-06-20" as any });
    if (!p.stripe_payment_intent_id && p.pix_txid?.startsWith("cs_")) {
      const session: any = await stripe.checkout.sessions.retrieve(p.pix_txid, { expand: ["payment_intent"] });
      const piId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
      if (piId) await sb.from("payments").update({ stripe_payment_intent_id: piId }).eq("id", p.id).eq("user_id", context.userId);
      if (session.payment_status === "paid") {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        await supabaseAdmin.rpc("approve_payment_by_pi", { _pi: piId || p.pix_txid });
        return { status: "paid" };
      }
      return { status: p.status, stripeStatus: session.payment_status };
    }
    if (!p.stripe_payment_intent_id) return { status: p.status };

    const pi = await stripe.paymentIntents.retrieve(p.stripe_payment_intent_id);
    if (pi.status === "succeeded") {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      await supabaseAdmin.rpc("approve_payment_by_pi", { _pi: pi.id });
      return { status: "paid" };
    }
    return { status: p.status, stripeStatus: pi.status };
  });

export const submitPaymentProof = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { paymentId: string; note: string }) => d)
  .handler(async ({ data, context }: any) => {
    const { error } = await context.supabase.from("payments").update({ proof_note: data.note }).eq("id", data.paymentId).eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listAllPayments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }: any) => {
    const sb = context.supabase;
    const { data: roles } = await sb.from("user_roles").select("role").eq("user_id", context.userId);
    if (!(roles ?? []).some((r: any) => r.role === "admin")) throw new Error("forbidden");
    const { data, error } = await sb.from("payments").select("*, plans(name), profiles!payments_user_id_fkey(email,full_name)").order("created_at", { ascending: false }).limit(200);
    if (error) {
      // fallback without join if relation hint fails
      const r2 = await sb.from("payments").select("*, plans(name)").order("created_at", { ascending: false }).limit(200);
      return r2.data ?? [];
    }
    return data ?? [];
  });

export const adminApprovePayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { paymentId: string }) => d)
  .handler(async ({ data, context }: any) => {
    const { data: res, error } = await context.supabase.rpc("approve_payment", { _payment_id: data.paymentId });
    if (error) throw new Error(error.message);
    return res;
  });

export const adminRejectPayment = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { paymentId: string; reason?: string }) => d)
  .handler(async ({ data, context }: any) => {
    const sb = context.supabase;
    const { data: roles } = await sb.from("user_roles").select("role").eq("user_id", context.userId);
    if (!(roles ?? []).some((r: any) => r.role === "admin")) throw new Error("forbidden");
    const { error } = await sb.from("payments").update({ status: "rejected", reviewed_by: context.userId, reviewed_at: new Date().toISOString(), proof_note: data.reason || null }).eq("id", data.paymentId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const adminUpdatePixSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { pix_key: string; pix_receiver_name: string; pix_city: string }) => d)
  .handler(async ({ data, context }: any) => {
    const sb = context.supabase;
    const { data: roles } = await sb.from("user_roles").select("role").eq("user_id", context.userId);
    if (!(roles ?? []).some((r: any) => r.role === "admin")) throw new Error("forbidden");
    for (const [k, v] of Object.entries(data)) {
      const { error } = await sb.from("app_settings").upsert({ key: k, value: v, updated_at: new Date().toISOString() });
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });

export const claimFirstAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }: any) => {
    const { data, error } = await context.supabase.rpc("claim_first_admin");
    if (error) throw new Error(error.message);
    return data;
  });
