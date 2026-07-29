-- Explicit deny-all RLS policies for app_sessions.
-- This table is accessed exclusively via service_role by the Node.js backend;
-- no anon or authenticated Supabase Auth user should ever reach it directly.

create policy "deny_select_app_sessions"
  on app_sessions for select
  using (false);

create policy "deny_insert_app_sessions"
  on app_sessions for insert
  with check (false);

create policy "deny_update_app_sessions"
  on app_sessions for update
  using (false);

create policy "deny_delete_app_sessions"
  on app_sessions for delete
  using (false);
