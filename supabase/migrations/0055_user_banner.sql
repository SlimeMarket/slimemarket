-- Add banner_gradient to users for profile customization
alter table users add column if not exists banner_gradient text;

-- Add index for performance
create index if not exists users_banner_idx on users(banner_gradient) where banner_gradient is not null;
