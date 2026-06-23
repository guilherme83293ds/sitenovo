
-- Roles
CREATE TYPE public.app_role AS ENUM ('admin','user');

CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users read own roles" ON public.user_roles FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role public.app_role)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$$;

-- Profiles
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  full_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own profile select" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
CREATE POLICY "own profile update" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id);
CREATE POLICY "admin read profiles" ON public.profiles FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin'));

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (NEW.id, NEW.email, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', NEW.email));
  RETURN NEW;
END $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Plans
CREATE TABLE public.plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  price_brl NUMERIC(10,2) NOT NULL,
  daily_search_limit INT NOT NULL,
  monthly_result_limit INT NOT NULL,
  features JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort INT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.plans TO anon, authenticated;
GRANT ALL ON public.plans TO service_role;
ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "plans public read" ON public.plans FOR SELECT TO anon, authenticated USING (active = true);

INSERT INTO public.plans (id,name,price_brl,daily_search_limit,monthly_result_limit,sort,features) VALUES
('starter','Starter',20.00,100,2000,1,'["100 buscas por dia","2.000 resultados/mês","Todas as ferramentas OSINT","Exportar JSON"]'::jsonb),
('pro','Pro',50.00,500,5000,2,'["500 buscas por dia","5.000 resultados/mês","Todas as ferramentas OSINT","Exportar JSON","Suporte prioritário"]'::jsonb),
('super','Super',120.00,2500,20000,3,'["2.500 buscas por dia","20.000 resultados/mês","Todas as ferramentas OSINT","Exportar JSON","Suporte VIP","API (em breve)"]'::jsonb);

-- Subscriptions (one active per user)
CREATE TABLE public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES public.plans(id),
  status TEXT NOT NULL DEFAULT 'active',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX subscriptions_user_active ON public.subscriptions(user_id) WHERE status = 'active';
GRANT SELECT ON public.subscriptions TO authenticated;
GRANT ALL ON public.subscriptions TO service_role;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own subscriptions" ON public.subscriptions FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "admin read subs" ON public.subscriptions FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin'));

-- Payments
CREATE TABLE public.payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES public.plans(id),
  amount_brl NUMERIC(10,2) NOT NULL,
  pix_key TEXT NOT NULL,
  pix_txid TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending', -- pending|paid|rejected|expired
  proof_note TEXT,
  proof_url TEXT,
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.payments TO authenticated;
GRANT ALL ON public.payments TO service_role;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own payments select" ON public.payments FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own payments insert" ON public.payments FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id AND status = 'pending');
CREATE POLICY "own payments update proof" ON public.payments FOR UPDATE TO authenticated USING (auth.uid() = user_id AND status = 'pending') WITH CHECK (auth.uid() = user_id);
CREATE POLICY "admin read payments" ON public.payments FOR SELECT TO authenticated USING (public.has_role(auth.uid(),'admin'));
CREATE POLICY "admin update payments" ON public.payments FOR UPDATE TO authenticated USING (public.has_role(auth.uid(),'admin'));

-- Search usage per day
CREATE TABLE public.search_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  searches INT NOT NULL DEFAULT 0,
  results INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, day)
);
GRANT SELECT ON public.search_usage TO authenticated;
GRANT ALL ON public.search_usage TO service_role;
ALTER TABLE public.search_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own usage" ON public.search_usage FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- Settings (Pix key etc)
CREATE TABLE public.app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT ON public.app_settings TO authenticated;
GRANT ALL ON public.app_settings TO service_role;
ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "settings auth read" ON public.app_settings FOR SELECT TO authenticated USING (true);
CREATE POLICY "settings admin write" ON public.app_settings FOR ALL TO authenticated USING (public.has_role(auth.uid(),'admin')) WITH CHECK (public.has_role(auth.uid(),'admin'));
INSERT INTO public.app_settings (key,value) VALUES
('pix_key','CONFIGURE_NO_PAINEL_ADMIN'),
('pix_receiver_name','NoxIntel'),
('pix_city','SAO PAULO');

-- Consume search RPC
CREATE OR REPLACE FUNCTION public.consume_search(_results INT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _uid UUID := auth.uid();
  _sub RECORD;
  _plan RECORD;
  _today DATE := (now() AT TIME ZONE 'America/Sao_Paulo')::DATE;
  _usage RECORD;
  _month_start DATE := date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo'))::DATE;
  _month_results INT;
BEGIN
  IF _uid IS NULL THEN
    RETURN jsonb_build_object('ok',false,'error','unauthenticated');
  END IF;

  SELECT * INTO _sub FROM public.subscriptions
   WHERE user_id = _uid AND status = 'active' AND expires_at > now()
   ORDER BY expires_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok',false,'error','no_plan');
  END IF;
  SELECT * INTO _plan FROM public.plans WHERE id = _sub.plan_id;

  SELECT COALESCE(SUM(results),0) INTO _month_results FROM public.search_usage
    WHERE user_id = _uid AND day >= _month_start;
  IF _month_results + _results > _plan.monthly_result_limit THEN
    RETURN jsonb_build_object('ok',false,'error','monthly_results_exceeded','limit',_plan.monthly_result_limit,'used',_month_results);
  END IF;

  INSERT INTO public.search_usage (user_id, day, searches, results)
  VALUES (_uid, _today, 1, _results)
  ON CONFLICT (user_id, day) DO UPDATE SET searches = search_usage.searches + 1, results = search_usage.results + EXCLUDED.results, updated_at = now()
  RETURNING * INTO _usage;

  IF _usage.searches > _plan.daily_search_limit THEN
    -- rollback this usage (decrement)
    UPDATE public.search_usage SET searches = searches - 1, results = results - _results WHERE id = _usage.id;
    RETURN jsonb_build_object('ok',false,'error','daily_limit_exceeded','limit',_plan.daily_search_limit);
  END IF;

  RETURN jsonb_build_object(
    'ok',true,
    'plan',_plan.id,
    'daily_used',_usage.searches,
    'daily_limit',_plan.daily_search_limit,
    'monthly_used',_month_results + _results,
    'monthly_limit',_plan.monthly_result_limit
  );
END $$;

-- Approve payment RPC (admin only)
CREATE OR REPLACE FUNCTION public.approve_payment(_payment_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _p RECORD; _new_expires TIMESTAMPTZ;
BEGIN
  IF NOT public.has_role(auth.uid(),'admin') THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  SELECT * INTO _p FROM public.payments WHERE id = _payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'payment_not_found'; END IF;
  IF _p.status <> 'pending' THEN RAISE EXCEPTION 'not_pending'; END IF;

  UPDATE public.payments SET status='paid', reviewed_by=auth.uid(), reviewed_at=now() WHERE id=_p.id;

  -- Extend or create subscription
  SELECT expires_at INTO _new_expires FROM public.subscriptions
   WHERE user_id = _p.user_id AND status='active' AND expires_at > now()
   ORDER BY expires_at DESC LIMIT 1;
  IF _new_expires IS NULL THEN _new_expires := now(); END IF;
  _new_expires := _new_expires + INTERVAL '30 days';

  INSERT INTO public.subscriptions (user_id, plan_id, status, expires_at)
  VALUES (_p.user_id, _p.plan_id, 'active', _new_expires);

  RETURN jsonb_build_object('ok',true,'expires_at',_new_expires);
END $$;
