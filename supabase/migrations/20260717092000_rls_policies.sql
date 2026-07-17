-- RLS policies for Quadrafy

create or replace function public.is_current_user(target_id text)
returns boolean
language sql
stable
as $$
  select (select auth.uid())::text = target_id;
$$;

create or replace function public.is_club_owner(target_club_id text)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.clubs c
    where c.id = target_club_id
      and c.owner_id = (select auth.uid())::text
  );
$$;

create or replace function public.is_match_owner(target_booking_id text)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.bookings b
    where b.id = target_booking_id
      and (b.player_id = (select auth.uid())::text or public.is_club_owner(b.club_id))
  );
$$;

drop policy if exists app_users_select_own on public.app_users;
create policy app_users_select_own
on public.app_users
for select
to authenticated
using (public.is_current_user(id));

drop policy if exists app_users_insert_own on public.app_users;
create policy app_users_insert_own
on public.app_users
for insert
to authenticated
with check (public.is_current_user(id));

drop policy if exists app_users_update_own on public.app_users;
create policy app_users_update_own
on public.app_users
for update
to authenticated
using (public.is_current_user(id))
with check (public.is_current_user(id));

drop policy if exists app_users_delete_own on public.app_users;
create policy app_users_delete_own
on public.app_users
for delete
to authenticated
using (public.is_current_user(id));

drop policy if exists clubs_select_owner on public.clubs;
create policy clubs_select_owner
on public.clubs
for select
to authenticated
using (public.is_club_owner(id));

drop policy if exists clubs_insert_owner on public.clubs;
create policy clubs_insert_owner
on public.clubs
for insert
to authenticated
with check ((select auth.uid())::text = owner_id);

drop policy if exists clubs_update_owner on public.clubs;
create policy clubs_update_owner
on public.clubs
for update
to authenticated
using (public.is_club_owner(id))
with check (public.is_club_owner(id));

drop policy if exists clubs_delete_owner on public.clubs;
create policy clubs_delete_owner
on public.clubs
for delete
to authenticated
using (public.is_club_owner(id));

drop policy if exists courts_select_owner on public.courts;
create policy courts_select_owner
on public.courts
for select
to authenticated
using (public.is_club_owner(club_id));

drop policy if exists courts_insert_owner on public.courts;
create policy courts_insert_owner
on public.courts
for insert
to authenticated
with check (public.is_club_owner(club_id));

drop policy if exists courts_update_owner on public.courts;
create policy courts_update_owner
on public.courts
for update
to authenticated
using (public.is_club_owner(club_id))
with check (public.is_club_owner(club_id));

drop policy if exists courts_delete_owner on public.courts;
create policy courts_delete_owner
on public.courts
for delete
to authenticated
using (public.is_club_owner(club_id));

drop policy if exists bookings_select_related on public.bookings;
create policy bookings_select_related
on public.bookings
for select
to authenticated
using (player_id = (select auth.uid())::text or public.is_club_owner(club_id));

drop policy if exists bookings_insert_owner on public.bookings;
create policy bookings_insert_owner
on public.bookings
for insert
to authenticated
with check (player_id = (select auth.uid())::text or public.is_club_owner(club_id));

drop policy if exists bookings_update_related on public.bookings;
create policy bookings_update_related
on public.bookings
for update
to authenticated
using (player_id = (select auth.uid())::text or public.is_club_owner(club_id))
with check (player_id = (select auth.uid())::text or public.is_club_owner(club_id));

drop policy if exists bookings_delete_related on public.bookings;
create policy bookings_delete_related
on public.bookings
for delete
to authenticated
using (player_id = (select auth.uid())::text or public.is_club_owner(club_id));

drop policy if exists booking_participants_select_related on public.booking_participants;
create policy booking_participants_select_related
on public.booking_participants
for select
to authenticated
using (player_id = (select auth.uid())::text or public.is_match_owner(booking_id));

drop policy if exists booking_participants_insert_related on public.booking_participants;
create policy booking_participants_insert_related
on public.booking_participants
for insert
to authenticated
with check (player_id = (select auth.uid())::text or public.is_match_owner(booking_id));

drop policy if exists booking_participants_update_related on public.booking_participants;
create policy booking_participants_update_related
on public.booking_participants
for update
to authenticated
using (player_id = (select auth.uid())::text or public.is_match_owner(booking_id))
with check (player_id = (select auth.uid())::text or public.is_match_owner(booking_id));

drop policy if exists booking_participants_delete_related on public.booking_participants;
create policy booking_participants_delete_related
on public.booking_participants
for delete
to authenticated
using (player_id = (select auth.uid())::text or public.is_match_owner(booking_id));

drop policy if exists recurring_bookings_select_owner on public.recurring_bookings;
create policy recurring_bookings_select_owner
on public.recurring_bookings
for select
to authenticated
using (public.is_club_owner(club_id));

drop policy if exists recurring_bookings_insert_owner on public.recurring_bookings;
create policy recurring_bookings_insert_owner
on public.recurring_bookings
for insert
to authenticated
with check (public.is_club_owner(club_id));

drop policy if exists recurring_bookings_update_owner on public.recurring_bookings;
create policy recurring_bookings_update_owner
on public.recurring_bookings
for update
to authenticated
using (public.is_club_owner(club_id))
with check (public.is_club_owner(club_id));

drop policy if exists recurring_bookings_delete_owner on public.recurring_bookings;
create policy recurring_bookings_delete_owner
on public.recurring_bookings
for delete
to authenticated
using (public.is_club_owner(club_id));

drop policy if exists match_messages_select_related on public.match_messages;
create policy match_messages_select_related
on public.match_messages
for select
to authenticated
using ((select auth.uid())::text = player_id or public.is_match_owner(match_id));

drop policy if exists match_messages_insert_related on public.match_messages;
create policy match_messages_insert_related
on public.match_messages
for insert
to authenticated
with check (player_id = (select auth.uid())::text and public.is_match_owner(match_id));

drop policy if exists match_messages_update_related on public.match_messages;
create policy match_messages_update_related
on public.match_messages
for update
to authenticated
using (player_id = (select auth.uid())::text or public.is_match_owner(match_id))
with check (player_id = (select auth.uid())::text or public.is_match_owner(match_id));

drop policy if exists match_messages_delete_related on public.match_messages;
create policy match_messages_delete_related
on public.match_messages
for delete
to authenticated
using (player_id = (select auth.uid())::text or public.is_match_owner(match_id));

drop policy if exists level_tests_select_owner on public.level_tests;
create policy level_tests_select_owner
on public.level_tests
for select
to authenticated
using (public.is_current_user(player_id));

drop policy if exists level_tests_insert_owner on public.level_tests;
create policy level_tests_insert_owner
on public.level_tests
for insert
to authenticated
with check (public.is_current_user(player_id));

drop policy if exists level_tests_update_owner on public.level_tests;
create policy level_tests_update_owner
on public.level_tests
for update
to authenticated
using (public.is_current_user(player_id))
with check (public.is_current_user(player_id));

drop policy if exists level_tests_delete_owner on public.level_tests;
create policy level_tests_delete_owner
on public.level_tests
for delete
to authenticated
using (public.is_current_user(player_id));

drop policy if exists level_history_select_owner on public.level_history;
create policy level_history_select_owner
on public.level_history
for select
to authenticated
using (public.is_current_user(player_id));

drop policy if exists level_history_insert_owner on public.level_history;
create policy level_history_insert_owner
on public.level_history
for insert
to authenticated
with check (public.is_current_user(player_id));

drop policy if exists level_history_update_owner on public.level_history;
create policy level_history_update_owner
on public.level_history
for update
to authenticated
using (public.is_current_user(player_id))
with check (public.is_current_user(player_id));

drop policy if exists level_history_delete_owner on public.level_history;
create policy level_history_delete_owner
on public.level_history
for delete
to authenticated
using (public.is_current_user(player_id));

drop policy if exists match_results_select_related on public.match_results;
create policy match_results_select_related
on public.match_results
for select
to authenticated
using (public.is_match_owner(booking_id));

drop policy if exists match_results_insert_related on public.match_results;
create policy match_results_insert_related
on public.match_results
for insert
to authenticated
with check (public.is_match_owner(booking_id));

drop policy if exists match_results_update_related on public.match_results;
create policy match_results_update_related
on public.match_results
for update
to authenticated
using (public.is_match_owner(booking_id))
with check (public.is_match_owner(booking_id));

drop policy if exists match_results_delete_related on public.match_results;
create policy match_results_delete_related
on public.match_results
for delete
to authenticated
using (public.is_match_owner(booking_id));

drop policy if exists audit_logs_select_owner on public.audit_logs;
create policy audit_logs_select_owner
on public.audit_logs
for select
to authenticated
using (actor_id = (select auth.uid())::text);

drop policy if exists audit_logs_insert_service on public.audit_logs;
create policy audit_logs_insert_service
on public.audit_logs
for insert
to authenticated
with check (actor_id = (select auth.uid())::text or actor_id is null);

drop policy if exists audit_logs_update_owner on public.audit_logs;
create policy audit_logs_update_owner
on public.audit_logs
for update
to authenticated
using (actor_id = (select auth.uid())::text)
with check (actor_id = (select auth.uid())::text);

drop policy if exists audit_logs_delete_owner on public.audit_logs;
create policy audit_logs_delete_owner
on public.audit_logs
for delete
to authenticated
using (actor_id = (select auth.uid())::text);
