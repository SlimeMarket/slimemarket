-- 0089 — rename the payment-method enum to English
--
--   Saldo    -> Balance
--   Langsung -> Direct
--   Onchain  -> (already English, unchanged)
--
-- Same reasoning as 0086/0087 (the WL and rekber status enums): an Indonesian
-- value that leaked into a public codebase whose audience is global. The UI was
-- already correct — `orders.jsx` renders `tr('od.balance', 'Balance')` — so this
-- changes nothing a user reads; it is the enum itself that read as Indonesian.
--
-- Small blast radius: `orders.payment` is the only column, no function mentions
-- these literals (verified against the live DB), and the 3 existing rows are all
-- `Saldo`. The three steps below are the same ones 0086 needed — and step 3 is
-- the one that was nearly missed there.

begin;

-- 1) the CHECK must go before the data can be rewritten
alter table orders drop constraint if exists orders_payment_check;

-- 2) migrate existing rows
update orders set payment = 'Balance' where payment = 'Saldo';
update orders set payment = 'Direct'  where payment = 'Langsung';

-- 3) re-add the CHECK with the English vocabulary
alter table orders add constraint orders_payment_check
  check (payment = any (array['Balance', 'Direct', 'Onchain']));

-- 4) the COLUMN DEFAULT still says 'Saldo' — a row inserted without an explicit
--    payment would now violate the new CHECK and the INSERT would fail. This is
--    the step that was missed in 0086; do not repeat it.
alter table orders alter column payment set default 'Balance';

commit;
