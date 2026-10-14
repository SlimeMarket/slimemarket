-- ============================================================================
-- SlimeMarket — 0013_mm_audit: Middleman audit log
-- Immutable append-only. Tracks every MM release/refund action with tx hash.
-- ============================================================================

create table if not exists mm_audit_log (
  id             uuid primary key default gen_random_uuid(),
  mm_user_id     uuid not null references users(id),
  mm_wallet_id   text not null,
  action         text not null check (action in ('RELEASE_ORDER','REFUND_ORDER','RELEASE_ESCROW','REFUND_ESCROW')),
  ref_id         text not null,
  tx_hash        text,
  detail         jsonb,
  created_at     timestamptz not null default now()
);

alter table mm_audit_log enable row level security;

drop policy if exists mm_audit_log_deny on mm_audit_log;
create policy mm_audit_log_deny on mm_audit_log for select using (false);
