-- ============================================================================
-- SlimeMarket — 0035_chat_constraints: widen chat enum checks.
-- Idempotent.
-- ============================================================================

-- Widen chat_messages.sender_role to include 'admin'
alter table chat_messages drop constraint if exists chat_messages_sender_role_check;
alter table chat_messages add constraint chat_messages_sender_role_check
  check (sender_role in ('buyer','seller','middleman','system','admin'));

-- Widen chat_threads.status to include 'resolved'
alter table chat_threads drop constraint if exists chat_threads_status_check;
alter table chat_threads add constraint chat_threads_status_check
  check (status in ('active','disrupted','closed','resolved'));
