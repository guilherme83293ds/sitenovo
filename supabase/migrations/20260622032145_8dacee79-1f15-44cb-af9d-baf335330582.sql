ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT,
  ADD COLUMN IF NOT EXISTS pix_qr_code TEXT,
  ADD COLUMN IF NOT EXISTS pix_copy_paste TEXT,
  ADD COLUMN IF NOT EXISTS pix_expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS payments_stripe_pi_idx ON public.payments(stripe_payment_intent_id);

CREATE OR REPLACE FUNCTION public.approve_payment_by_pi(_pi TEXT)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE _p RECORD; _new_expires TIMESTAMPTZ;
BEGIN
  SELECT * INTO _p FROM public.payments WHERE stripe_payment_intent_id=_pi FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'error','not_found'); END IF;
  IF _p.status='paid' THEN RETURN jsonb_build_object('ok',true,'already',true); END IF;
  UPDATE public.payments SET status='paid', reviewed_at=now() WHERE id=_p.id;
  SELECT expires_at INTO _new_expires FROM public.subscriptions
    WHERE user_id=_p.user_id AND status='active' AND expires_at>now()
    ORDER BY expires_at DESC LIMIT 1;
  IF _new_expires IS NULL THEN _new_expires := now(); END IF;
  _new_expires := _new_expires + INTERVAL '30 days';
  INSERT INTO public.subscriptions (user_id, plan_id, status, expires_at)
  VALUES (_p.user_id, _p.plan_id, 'active', _new_expires);
  RETURN jsonb_build_object('ok',true,'expires_at',_new_expires);
END $$;