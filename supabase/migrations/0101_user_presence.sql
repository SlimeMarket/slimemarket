-- 0101: presence tracking for store pages.
--
-- `stores.online` never existed and `lib/catalog/mappers.ts` hardcoded
-- `online: true` "for demo", so every store showed a green dot whether the
-- seller had been gone for a week or was mid-sentence. This adds the only
-- durable fact we can actually observe: when the seller's session last talked
-- to us. "Online" is then a derived read (last_seen_at within a short window),
-- which keeps the write path to one UPDATE per heartbeat instead of a
-- presence table that has to be reaped.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

COMMENT ON COLUMN public.users.last_seen_at IS
  'Last authenticated presence heartbeat (POST /api/presence). "Online" is derived: now() - last_seen_at < 120s.';

-- Sorted lookups (admin lists, "who is online") scan newest-first.
CREATE INDEX IF NOT EXISTS users_last_seen_at_idx
  ON public.users (last_seen_at DESC);

-- Backfill so the column is not all-NULL on day one: use the newest thing we
-- can prove the user did. `updated_at` moves on profile edits, which is a much
-- better guess than `now()` (that would mark the entire user base as online).
UPDATE public.users
   SET last_seen_at = updated_at
 WHERE last_seen_at IS NULL
   AND updated_at IS NOT NULL;
