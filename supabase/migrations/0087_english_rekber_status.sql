-- 0087 — rename rekber status values to English
--
--   MENUNGGU   -> WAITING
--   DISETUJUI  -> APPROVED
--   DIKIRIM    -> SENT
--   SELESAI    -> COMPLETED
--   DIBATALKAN -> CANCELLED
--
-- Same reasoning as 0086 (the escrow/WL statuses), applied to the second escrow
-- flow. Kept as its own migration rather than folded into 0086 because 0086 was
-- already applied; a fresh install runs both and lands in the same place.
--
-- SAFE: `rekber_tx` holds 0 rows and no function references these literals
-- (verified against the live DB before writing this), so this is a pure
-- constraint + default swap.

begin;

-- 1) drop the CHECK before touching anything
alter table rekber_tx drop constraint if exists rekber_tx_status_check;

-- 2) migrate rows (no-ops today, but correct if this is ever replayed on data)
update rekber_tx set status = 'WAITING'   where status = 'MENUNGGU';
update rekber_tx set status = 'APPROVED'  where status = 'DISETUJUI';
update rekber_tx set status = 'SENT'      where status = 'DIKIRIM';
update rekber_tx set status = 'COMPLETED' where status = 'SELESAI';
update rekber_tx set status = 'CANCELLED' where status = 'DIBATALKAN';

-- 3) re-add the CHECK with the English vocabulary
alter table rekber_tx add constraint rekber_tx_status_check
  check (status = any (array['WAITING', 'APPROVED', 'SENT', 'COMPLETED', 'CANCELLED']));

-- 4) the column default must move too, or a row inserted without an explicit
--    status would violate the new CHECK (this is exactly what 0086 first missed)
alter table rekber_tx alter column status set default 'WAITING';

commit;
