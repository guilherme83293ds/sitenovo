import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/stripe-webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const sig = request.headers.get("stripe-signature");
        const body = await request.text();
        const secret = process.env.STRIPE_WEBHOOK_SECRET;

        const Stripe = (await import("stripe")).default;
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2024-06-20" as any });

        let event: any;
        try {
          if (secret && sig) {
            event = await stripe.webhooks.constructEventAsync(body, sig, secret);
          } else {
            // Dev fallback: accept unsigned payload (set STRIPE_WEBHOOK_SECRET in prod)
            event = JSON.parse(body);
          }
        } catch (e: any) {
          return new Response(`Invalid signature: ${e.message}`, { status: 400 });
        }

        if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
          const session: any = event.data.object;
          const pi = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
          if (pi) {
            const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
            await supabaseAdmin.from("payments").update({ stripe_payment_intent_id: pi }).eq("pix_txid", session.id);
            await supabaseAdmin.rpc("approve_payment_by_pi", { _pi: pi });
          }
        }

        if (event.type === "payment_intent.succeeded") {
          const pi = event.data.object;
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          await supabaseAdmin.rpc("approve_payment_by_pi", { _pi: pi.id });
        }

        return Response.json({ received: true });
      },
    },
  },
});
