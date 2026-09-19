-- =========================================================================
-- 0004 -- structured "operational update" category on referrals.
--
-- The referral update box was free text only. It now pairs a predetermined
-- category (Attempted contact, Booked, Attended intake, ...) with an
-- optional short free-text detail, so referral progress can be reported on
-- consistently instead of parsed out of prose. presenting_category on both
-- referrals and cases stays a plain text column (no constraint) since the
-- app now sends one of a fixed list of categories from a dropdown, but
-- still allows a typed "Other" value.
--
-- Run this once in the Supabase SQL editor. Safe to re-run.
-- =========================================================================
alter table referrals add column if not exists update_category text;

-- update_referral() gains p_update_category so PATCH can set it alongside
-- the existing free-text last_update.
create or replace function update_referral(
  p_referral_id int, p_priority text, p_status text, p_contact_attempts int,
  p_next_action_date date, p_last_update text, p_updated_by uuid, p_update_category text default null
) returns referrals
language plpgsql as $$
declare result referrals;
begin
  update referrals set
    priority = p_priority, status = p_status, contact_attempts = p_contact_attempts,
    next_action_date = p_next_action_date, last_update = p_last_update,
    update_category = p_update_category,
    updated_by_identity_user_id = p_updated_by, updated_at = now(),
    closed_at = case when p_status like 'Closed%' then coalesce(closed_at, now()) else null end
  where id = p_referral_id
  returning * into result;
  return result;
end;
$$;
