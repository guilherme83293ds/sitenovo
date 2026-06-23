
-- 1) app_settings: admin-only SELECT
DROP POLICY IF EXISTS "settings auth read" ON public.app_settings;
CREATE POLICY "settings admin read"
  ON public.app_settings FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

-- 2) payments: trigger to prevent non-admin users from modifying anything other than proof_note/proof_url
CREATE OR REPLACE FUNCTION public.payments_restrict_user_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.has_role(auth.uid(), 'admin'::app_role) THEN
    RETURN NEW;
  END IF;
  -- Force all fields except proof_note/proof_url back to OLD values
  NEW.user_id := OLD.user_id;
  NEW.plan_id := OLD.plan_id;
  NEW.amount_brl := OLD.amount_brl;
  NEW.status := OLD.status;
  NEW.reviewed_by := OLD.reviewed_by;
  NEW.reviewed_at := OLD.reviewed_at;
  NEW.created_at := OLD.created_at;
  NEW.stripe_payment_intent_id := COALESCE(OLD.stripe_payment_intent_id, NEW.stripe_payment_intent_id);
  -- Preserve any PIX/identifier columns if they exist
  BEGIN NEW.pix_key := OLD.pix_key; EXCEPTION WHEN undefined_column THEN NULL; END;
  BEGIN NEW.pix_txid := OLD.pix_txid; EXCEPTION WHEN undefined_column THEN NULL; END;
  BEGIN NEW.currency := OLD.currency; EXCEPTION WHEN undefined_column THEN NULL; END;
  BEGIN NEW.method := OLD.method; EXCEPTION WHEN undefined_column THEN NULL; END;
  BEGIN NEW.stripe_session_id := OLD.stripe_session_id; EXCEPTION WHEN undefined_column THEN NULL; END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS payments_restrict_user_update ON public.payments;
CREATE TRIGGER payments_restrict_user_update
  BEFORE UPDATE ON public.payments
  FOR EACH ROW EXECUTE FUNCTION public.payments_restrict_user_update();

-- 3) user_roles: explicit deny by admin-only policies for write operations
CREATE POLICY "admins insert roles"
  ON public.user_roles FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "admins update roles"
  ON public.user_roles FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "admins delete roles"
  ON public.user_roles FOR DELETE TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "admins read all roles"
  ON public.user_roles FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role));

-- 4) Restrict sensitive SECURITY DEFINER functions to admins/service_role
REVOKE EXECUTE ON FUNCTION public.approve_payment(uuid) FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.approve_payment_by_pi(text) FROM authenticated, anon, PUBLIC;
-- claim_first_admin guards itself (no-op once an admin exists); keep callable for bootstrap
