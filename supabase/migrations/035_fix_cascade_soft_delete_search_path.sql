-- Fix security warning: cascade_soft_delete has SECURITY DEFINER but no explicit search_path.
-- Pin to 'public' since all table references in the function body are unqualified.
ALTER FUNCTION public.cascade_soft_delete() SET search_path = 'public';
