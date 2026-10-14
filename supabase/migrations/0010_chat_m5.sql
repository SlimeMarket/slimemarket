-- ============================================================================
-- SlimeMarket — 0010_chat_m5: chat schema additions for M5 forum+DMs.
-- Idempotent.
-- ============================================================================

-- chat_threads: last_text / last_time for inbox preview, channel for forum routing
alter table chat_threads
  add column if not exists last_text text,
  add column if not exists last_time timestamptz,
  add column if not exists channel  text;

-- Allow 'forum' type (previously only 'normal' and 'escrow')
alter table chat_threads drop constraint if exists chat_threads_type_check;
alter table chat_threads add constraint chat_threads_type_check
  check (type in ('normal','escrow','forum'));

-- Indexes
create index if not exists chat_threads_participant_gin_idx
  on chat_threads using gin (participant_ids);
create index if not exists chat_threads_channel_idx
  on chat_threads(channel) where channel is not null;

-- chat_messages: add sender_id → users FK for the Supabase join
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where contype = 'f'
       and conrelid = 'chat_messages'::regclass
       and conname = 'chat_messages_sender_id_fkey'
  ) then
    alter table chat_messages
      add constraint chat_messages_sender_id_fkey
      foreign key (sender_id) references users(id) on delete set null;
  end if;
end$$;
