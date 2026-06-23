
REVOKE ALL ON FUNCTION public.has_role(UUID, public.app_role) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.consume_search(INT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.approve_payment(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_role(UUID, public.app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.consume_search(INT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_payment(UUID) TO authenticated;
