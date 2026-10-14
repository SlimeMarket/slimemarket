-- ============================================================================
-- 0050_ucw_pin_foundation — UCW PIN integration foundation (.B1)
-- ============================================================================
-- (a) users.wallet_provisioned — true once the user completed the Circle
--     PIN-setup challenge and has a live UCW wallet row.
-- (b) orders payer tracking for EOA checkout logging (Phase D):
--     payer_address + payer_wallet_type. Existing Onchain orders are
--     platform-relayed non-custodial → backfilled as 'platform'.
-- (c) UID backfill 8 -> 4 chars: keep left(uid,4); on UNIQUE collision
--     generate a fresh random 4-char uid from the ambiguity-free alphabet
--     (md5-seeded random), retry up to 10x per user.
--
-- Fully idempotent: IF NOT EXISTS everywhere, guarded DO block (no-op once
-- every uid is <= 4 chars), backfill UPDATE guarded by WHERE ... IS NULL.
-- ============================================================================

-- (a) wallet provisioning flag
alter table users add column if not exists wallet_provisioned boolean not null default false;

-- (b) orders payer tracking
alter table orders add column if not exists payer_address text;
alter table orders add column if not exists payer_wallet_type text;

-- Re-add the check constraint only when absent (add-if-not-exists does not
-- work for constraints; use a catalog guard so the whole file stays
-- re-runnable).
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'orders_payer_wallet_type_check'
  ) then
    alter table orders add constraint orders_payer_wallet_type_check
      check (payer_wallet_type in ('ucw','eoa','platform'));
  end if;
end $$;

-- Backfill existing orders: platform-relayed non-custodial.
update orders
set payer_wallet_type = 'platform'
where payer_wallet_type is null and payment = 'Onchain';

-- (c) UID backfill: 8 chars -> 4 chars.
-- left(uid,4) first (keeps the human-recognizable prefix, matches
-- lib/uid.ts:shortenUid); on UNIQUE collision fall back to random 4-char
-- uids drawn from UID_ALPHABET (32 chars, no I/L/O/U) seeded by
-- md5(uid || salt || attempt) — deterministic per row+attempt, uniformly
-- distributed enough for a backfill. ('x'||hex)::bit(16)::int converts a
-- 4-char hex chunk to an integer (PostgreSQL has no conv()).
do $$
declare
  u record;
  new_uid text;
  attempt int;
  h text;
  alphabet text := 'ABCDEFGHJKMNPQRSTVWXYZ0123456789';
begin
  -- Snapshot users needing shortening; process in stable order.
  for u in
    select id, uid from users where length(uid) > 4 order by joined_at
  loop
    new_uid := null;
    -- Candidate 1: left(uid, 4)
    begin
      update users set uid = left(u.uid, 4) where id = u.id;
      new_uid := left(u.uid, 4);
    exception when unique_violation then
      new_uid := null;
    end;

    -- Candidates 2..11: random from alphabet (md5-seeded)
    if new_uid is null then
      for attempt in 1..10 loop
        begin
          h := md5(u.uid || ':' || attempt::text);
          new_uid :=
            substr(alphabet, (('x' || substr(h, 1, 4))::bit(16)::int % 32) + 1, 1) ||
            substr(alphabet, (('x' || substr(h, 5, 4))::bit(16)::int % 32) + 1, 1) ||
            substr(alphabet, (('x' || substr(h, 9, 4))::bit(16)::int % 32) + 1, 1) ||
            substr(alphabet, (('x' || substr(h, 13, 4))::bit(16)::int % 32) + 1, 1);
          update users set uid = new_uid where id = u.id;
          exit;
        exception when unique_violation then
          new_uid := null;
        end;
      end loop;
      if new_uid is null then
        raise exception 'uid backfill: could not find a unique 4-char uid for user %', u.id;
      end if;
    end if;
  end loop;
end $$;
