
DROP POLICY IF EXISTS "Authenticated can read profiles" ON public.profiles;

CREATE POLICY "Coords/admins read all profiles, staff read own"
ON public.profiles
FOR SELECT
TO authenticated
USING (
  auth.uid() = id
  OR public.current_user_is_coordinator_or_admin()
);
