-- 0090 — dispute evidence + arbitrator brief
--
-- PROBLEM: `flagDispute` records only that a dispute happened. The reason and
-- any supporting evidence live in chat messages, so the middleman/arbitrator
-- has to reconstruct the case by scrolling a conversation before ruling. Every
-- dispute therefore costs a human reading time, and that cost does not shrink
-- as the platform grows.
--
-- This adds the two pieces the arbitrator actually needs:
--   1. a structured place for each side to state its case + attach evidence
--   2. a BRIEF that lays out the objective facts, both claims, and which
--      contract outcomes are currently AVAILABLE — so the ruling starts from a
--      summary instead of a scroll
--
-- ⚠️ NO AI, AND NO RECOMMENDED VERDICT — by explicit product decision.
--
-- Arbitration decides who keeps money. An automated judgement — whether from a
-- model or from a rule engine dressed up as one — cannot be questioned,
-- cannot be held accountable, and fails with confidence, which is the worst
-- way for it to fail: it would back the wrong party and look authoritative
-- doing it. A human rules. This brief only removes the clerical work of
-- assembling the case; it never says who should win.
--
-- `dispute_brief` therefore carries FACTS and AVAILABILITY, not advice:
--   facts        — price, collateral, delivered?, deadlines passed/remaining,
--                  on-chain state, when the dispute was raised
--   claims       — each side's statement + attached evidence
--   availability — which of release / refund / slash the contract permits
--                  GIVEN THE CURRENT STATE (a mechanical precondition check
--                  against MarketEscrow's own requires, not a judgement)
--
-- See lib/disputes/brief.ts.

begin;

alter table wl_deals
  add column if not exists dispute_reason   text,
  add column if not exists dispute_evidence jsonb not null default '[]'::jsonb,
  add column if not exists dispute_brief    jsonb,
  add column if not exists dispute_brief_at timestamptz;

-- Cap the stored evidence so a party cannot wedge the row (and the arbitrator's
-- UI) with an unbounded blob. 40 entries × ~1 KB is far more than a real case.
alter table wl_deals
  drop constraint if exists wl_deals_dispute_evidence_size_check;
alter table wl_deals
  add constraint wl_deals_dispute_evidence_size_check
  check (jsonb_typeof(dispute_evidence) = 'array' and jsonb_array_length(dispute_evidence) <= 40);

comment on column wl_deals.dispute_reason is
  'Why the flagging party raised the dispute (free text, shown in the arbitrator brief).';
comment on column wl_deals.dispute_evidence is
  'Array of { side, note, link, at }. Both parties may append while status = DISPUTED.';
comment on column wl_deals.dispute_brief is
  'Arbitrator brief: facts + claims + which outcomes the contract currently permits. Deliberately contains NO verdict and NO AI. See lib/disputes/brief.ts.';

commit;
