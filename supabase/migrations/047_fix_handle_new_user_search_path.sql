-- Fix security advisory: handle_new_user is SECURITY DEFINER
-- but has no pinned search_path. Without it, a malicious role
-- could shadow public.profiles via schema manipulation.
ALTER FUNCTION public.handle_new_user() SET search_path = 'public';
