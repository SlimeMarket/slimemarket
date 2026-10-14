-- 0024: Seller-set warranty on products + report system

-- Add warranty column to products (seller-set, free text)
alter table products add column if not exists warranty text;

-- Reports table
create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references users(id) on delete cascade,
  target_type text not null check (target_type in ('product','store','user')),
  target_id uuid not null,
  reason text not null,
  detail text,
  status text not null default 'pending' check (status in ('pending','reviewing','resolved','dismissed')),
  resolved_by uuid references users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

-- RLS
alter table reports enable row level security;
create policy "Users can create reports" on reports for insert with check (auth.uid() = reporter_id);
create policy "Admins can read reports" on reports for select using (
  exists (select 1 from users where id = auth.uid() and role = 'Admin')
);
create policy "Admins can update reports" on reports for update using (
  exists (select 1 from users where id = auth.uid() and role = 'Admin')
);

-- Index
create index if not exists reports_status_idx on reports (status, created_at desc);
create index if not exists reports_target_idx on reports (target_type, target_id);
