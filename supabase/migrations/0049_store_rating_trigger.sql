-- ============================================================================
-- 0049_store_rating_trigger — keep stores.rating/rating_count in sync (C1)
-- ============================================================================
-- Problem: review inserts (lib/order/transitions.ts:reviewOrder) never update
-- stores.rating / stores.rating_count — no trigger existed anywhere, so store
-- pages showed "0 (0 ratings)" despite real reviews in the reviews table.
--
-- Fix: AFTER INSERT trigger on reviews recomputes the store's aggregate
-- (count + avg). Plus a one-time backfill of stores from existing reviews so
-- historical reviews count immediately.
--
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.maintain_store_rating()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE stores s
     SET rating_count = agg.cnt,
         rating       = agg.avg_rating
    FROM (
      SELECT store_id,
             count(*)::int          AS cnt,
             coalesce(avg(rating), 0)::numeric AS avg_rating
        FROM reviews
       WHERE store_id = NEW.store_id
       GROUP BY store_id
    ) agg
   WHERE s.id = NEW.store_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reviews_rating ON reviews;
CREATE TRIGGER reviews_rating
  AFTER INSERT ON reviews
  FOR EACH ROW
  EXECUTE FUNCTION public.maintain_store_rating();

-- One-time backfill: existing reviews that were inserted before this trigger.
UPDATE stores s
   SET rating_count = agg.cnt,
       rating       = agg.avg_rating
  FROM (
    SELECT store_id,
           count(*)::int                    AS cnt,
           coalesce(avg(rating), 0)::numeric AS avg_rating
      FROM reviews
     GROUP BY store_id
  ) agg
 WHERE s.id = agg.store_id;
