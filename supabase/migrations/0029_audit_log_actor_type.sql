-- ============================================================================
-- 0029_audit_log_actor_type — fix FK violation + harden audit integrity.
--
-- P0 bug: mm_user_id is `uuid NOT NULL references users(id)`, but
-- transitions.ts/auto-release.ts pass "platform"/"auto-release" (non-uuid
-- strings) for system-triggered releases/refunds. Those inserts violate the
-- FK constraint and are silently swallowed by createMmAuditLog (console.error
-- only). Every on-chain release/refund triggered by buyer-confirm,
-- buyer-cancel, seller-decline, and the 42h auto-release produces NO audit
-- row — exactly the money-moving actions that must be auditable.
--
-- Fix:
--   1) Make mm_user_id nullable (system actors have no user row).
--   2) Add actor_type NOT NULL CHECK to distinguish user vs system actors.
--   3) Add circle_tx_id column (Circle's tx UUID; on-chain tx_hash is resolved
--      async by indexer and may be null at audit-write time).
--   4) Widen action CHECK: add ALLOWANCE_DANGLING, RECONCILE_DRIFT,
--      WALLET_FREEZE, WALLET_UNFREEZE for Phase 2/5 hooks.
--   5) Create mm_audit_log_failed dead-letter table for the throw-on-failure
--      path in lib/mm.ts — guarantees no audit row is lost silently.
-- ============================================================================

-- 1) mm_user_id nullable (system actors have no user row)
alter table mm_audit_log alter column mm_user_id drop not null;

-- 2) actor_type column (NOT NULL, distinguishes user vs system)
alter table mm_audit_log add column if not exists actor_type text;
alter table mm_audit_log add constraint mm_audit_log_actor_type_check
  check (actor_type in ('user','platform','auto_release','system'));

-- Backfill existing rows: rows with a non-null mm_user_id are user actions.
update mm_audit_log set actor_type = 'user' where actor_type is null and mm_user_id is not null;
-- Rows with null mm_user_id (shouldn't exist pre-migration, but defensive).
update mm_audit_log set actor_type = 'system' where actor_type is null and mm_user_id is null;

-- Now enforce NOT NULL after backfill.
alter table mm_audit_log alter column actor_type set not null;

-- 3) circle_tx_id column (Circle's UUID, separate from on-chain tx_hash)
alter table mm_audit_log add column if not exists circle_tx_id text;

-- 4) Widen action CHECK to cover Phase 2/5 audit hooks
alter table mm_audit_log drop constraint if exists mm_audit_log_action_check;
alter table mm_audit_log add constraint mm_audit_log_action_check
  check (action in (
    'RELEASE_ORDER','REFUND_ORDER','RELEASE_ESCROW','REFUND_ESCROW',
    'TREASURY_WITHDRAW','TREASURY_AIRDROP','MM_PROMOTE','MM_DEMOTE',
    'BAN_USER','UNBAN_USER','FREEZE_PRODUCT','UNFREEZE_PRODUCT',
    'FREEZE_STORE','UNFREEZE_STORE','REVOKE_SELLER','COLLECT_FEES',
    'ALLOWANCE_DANGLING','RECONCILE_DRIFT','WALLET_FREEZE','WALLET_UNFREEZE'
  ));

-- 5) Dead-letter table for audit inserts that fail on the primary table.
--    Same shape, but no FK / no CHECK / no RLS — always writable so the audit
--    trail is never lost even if the primary table is in a bad state.
create table if not exists mm_audit_log_failed (
  id             uuid primary key default gen_random_uuid(),
  -- Mirror of mm_audit_log columns (loose types — failure payload as-is)
  mm_user_id     text,
  mm_wallet_id    text,
  actor_type     text,
  action         text,
  ref_id         text,
  tx_hash        text,
  circle_tx_id   text,
  detail         jsonb,
  -- Failure metadata
  failure_reason text not null,
  attempted_at   timestamptz not null default now()
);

alter table mm_audit_log_failed enable row level security;
drop policy if exists mm_audit_log_failed_deny on mm_audit_log_failed;
create policy mm_audit_log_failed_deny on mm_audit_log_failed for select using (false);
drop policy if exists mm_audit_log_failed_insert on mm_audit_log_failed;
create policy mm_audit_log_failed_insert on mm_audit_log_failed for insert with check (true);

grant insert, select on table mm_audit_log_failed to service_role;
grant insert, select on table mm_audit_log_failed to postgres;

-- Index for the admin audit viewer (filter by ref_id / action / actor_type / date)
create index if not exists idx_mm_audit_log_ref_id        on mm_audit_log(ref_id);
create index if not exists idx_mm_audit_log_action        on mm_audit_log(action);
create index if not exists idx_mm_audit_log_actor_type    on mm_audit_log(actor_type);
create index if not exists idx_mm_audit_log_created_at    on mm_audit_log(created_at desc);
create index if not exists idx_mm_audit_log_circle_tx_id  on mm_audit_log(circle_tx_id);

-- ============================================================================
-- on_chain_status CHECK constraint (orders + wl_deals) — was previously
-- unconstrained text, so typos weren't caught. Add the allowed set:
--   CREATED          — buyer approved, createOrderFor relayed (Phase 3)
--   release_pending  — releaseOrder relayed, awaiting OrderReleased event
--   refund_pending   — refundOrder relayed, awaiting OrderRefunded event
--   RELEASED         — terminal: OrderReleased indexed
--   REFUNDED         — terminal: OrderRefunded indexed
-- Null is allowed (legacy orders + orders with no on-chain component).
-- ============================================================================
alter table orders drop constraint if exists orders_on_chain_status_check;
alter table orders add constraint orders_on_chain_status_check
  check (on_chain_status is null or on_chain_status in (
    'CREATED','release_pending','refund_pending','RELEASED','REFUNDED'
  ));

alter table wl_deals drop constraint if exists wl_deals_on_chain_status_check;
alter table wl_deals add constraint wl_deals_on_chain_status_check
  check (on_chain_status is null or on_chain_status in (
    'CREATED','release_pending','refund_pending','RELEASED','REFUNDED'
  ));
