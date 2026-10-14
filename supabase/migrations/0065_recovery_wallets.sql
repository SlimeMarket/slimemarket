-- ============================================================================
-- wallet-based account recovery (passwordless, EOA proof of identity).
--
-- WHY EOA ONLY: Circle UCW keys are MPC-split and only Circle can sign; a
-- Circle signing session itself comes from an email OTP, so a UCW holder who
-- lost their inbox cannot prove identity with the UCW wallet. An EXTERNAL EOA
-- (MetaMask/Coinbase) can sign locally with no email involved — that is the
-- recovery anchor we store here. Users link a recovery wallet while still
-- logged in; later they can sign in from it (see /api/auth/recovery/*).
--
-- Scope note: a recovery session restores DATA access (orders, store,
-- dashboard, history). UCW money actions (PIN challenge) still require the
-- normal email-OTP login, because Circle needs a fresh userToken.
-- ============================================================================

-- Linked recovery wallets (one address may belong to exactly one account)
CREATE TABLE IF NOT EXISTS public.recovery_wallets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address       TEXT NOT NULL,
  chain_id      INT  NOT NULL DEFAULT 5042002, -- Arc testnet
  label         TEXT,
  linked_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ
);

-- One EOA ⇒ one account (prevents cross-account takeover via a shared wallet)
CREATE UNIQUE INDEX IF NOT EXISTS recovery_wallets_address_uniq
  ON public.recovery_wallets (lower(address));

CREATE INDEX IF NOT EXISTS recovery_wallets_user_idx
  ON public.recovery_wallets (user_id);

-- Single-use nonces for recovery challenges (TTL enforced at read time)
CREATE TABLE IF NOT EXISTS public.auth_nonces (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nonce       TEXT NOT NULL UNIQUE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('recovery_login', 'link_wallet')),
  address     TEXT,                       -- lower(address) when bound to a wallet
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  consumed_by TEXT                        -- lower(address) that consumed it
);

CREATE INDEX IF NOT EXISTS auth_nonces_expires_idx
  ON public.auth_nonces (expires_at);

-- Service-role access only (no anon/authenticated policies: server-side flow)
ALTER TABLE public.recovery_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_nonces ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Audit: allow the recovery events through mm_audit_log's action CHECK.
-- (0021 pinned the constraint to 8 actions while lib/mm.ts already declared
-- more; recovery events would otherwise dead-letter. We only ADD here — the
-- existing allowed list is preserved.)
-- ---------------------------------------------------------------------------
ALTER TABLE public.mm_audit_log DROP CONSTRAINT IF EXISTS mm_audit_log_action_check;
ALTER TABLE public.mm_audit_log ADD CONSTRAINT mm_audit_log_action_check
  CHECK (action IN (
    'RELEASE_ORDER','REFUND_ORDER','RELEASE_ESCROW','REFUND_ESCROW',
    'TREASURY_WITHDRAW','TREASURY_AIRDROP','MM_PROMOTE','MM_DEMOTE',
    'RECOVERY_LOGIN','RECOVERY_WALLET_LINK','RECOVERY_WALLET_UNLINK'
  ));

