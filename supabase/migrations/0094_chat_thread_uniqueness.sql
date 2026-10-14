-- ============================================================================
-- SlimeMarket — 0094: one chat thread per (type, order_id).
--
-- WHY
-- ---
-- The get-or-create in /api/orders/[id]/chat and /api/wl/deals/[id]/chat had no
-- uniqueness guarantee. Two concurrent first-opens (buyer and seller tapping the
-- same order at the same moment) each saw "no thread", each inserted one, and the
-- follow-up `.maybeSingle()` then errored with PGRST116 ("multiple rows
-- returned"). The handler read that error as "no data" — so it treated the lookup
-- as not-found, inserted a THIRD thread, and served messages from that empty one.
-- Net effect: the chat room looks empty and the conversation is split across rows
-- nobody reads.
--
-- lib/order/disputes.ts#ensureDisputeThread has the same shape.
--
-- FIX
-- ---
--   1. Collapse existing duplicates: keep the OLDEST thread per (type, order_id)
--      and re-point the duplicates' messages onto it BEFORE deleting them, so no
--      message is lost (chat_messages.thread_id is ON DELETE CASCADE).
--   2. Enforce the invariant with a partial unique index. order_id is NULL for
--      forum/DM threads, so those are excluded and unaffected.
--
-- The handlers are made race-safe in the same commit: they tolerate pre-existing
-- duplicates and treat a 23505 unique_violation as "another request won the race"
-- and re-select instead of inserting again.
--
-- Idempotent: safe to run twice.
-- ============================================================================

-- 1. Re-point messages from duplicate threads onto the canonical (oldest) thread.
with ranked as (
  select id,
         first_value(id) over (
           partition by type, order_id order by created_at, id
         ) as keep_id,
         row_number() over (
           partition by type, order_id order by created_at, id
         ) as rn
    from chat_threads
   where order_id is not null
)
update chat_messages m
   set thread_id = r.keep_id
  from ranked r
 where m.thread_id = r.id
   and r.rn > 1;

-- 2. Delete the now-empty duplicates.
with ranked as (
  select id,
         row_number() over (
           partition by type, order_id order by created_at, id
         ) as rn
    from chat_threads
   where order_id is not null
)
delete from chat_threads t
 using ranked r
 where t.id = r.id
   and r.rn > 1;

-- 3. Enforce it from here on.
create unique index if not exists chat_threads_type_order_uniq
  on chat_threads (type, order_id)
  where order_id is not null;
