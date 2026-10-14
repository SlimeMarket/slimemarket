-- ============================================================================
-- SlimeMarket — seed.sql
-- Mirror of frontend dummy data (data.jsx / data2.jsx) for end-to-end testing.
-- Run AFTER 0001_init.sql, 0002_rls.sql, 0003_functions.sql.
-- All USDC amounts stored as micro-USDC bigint (×1_000_000).
--
-- NOTE: auth_id values are FAKE uuids — replace with real Supabase Auth user ids
--       after running `supabase db reset` + creating auth users, OR keep them
--       for schema-only testing (RLS will treat them as non-authenticated).
-- ============================================================================

-- Use a fixed fake auth_id namespace so profiles can be referenced consistently.
-- In real dev, the signup flow writes the actual auth.users.id into users.auth_id.

begin;

-- ---------------------------------------------------------------------------
-- USERS  (mirrors ME + sellers + buyers from data.jsx/data2.jsx)
-- ---------------------------------------------------------------------------
insert into users (id, uid, name, handle, email, role, tx_count, avatar_gradient, referral_code, preferred_lang, contacts, joined_at) values
  ('11111111-0000-0000-0000-000000000001', 'FRST9K2X', 'frostbyte.eth', '@frostbyte', 'frostbyte@arc.id', 'Buyer', 7, 'from-arc-primary to-arc-accent', 'FROST-9K2X', 'en', '{"discord":"frostbyte#4417","telegram":"@frostbyte_arc","x":"@frostbyte_eth"}', '2026-03-01'),
  ('22222222-0000-0000-0000-000000000002', 'NBL4K5QH', 'NebulaGoods',  '@nebulagoods',  'nebula@arc.id',  'Seller', 31, 'from-cyan-500 to-blue-600', 'NEBU-4K5Q', 'en', '{}', '2026-06-09'),
  ('22222222-0000-0000-0000-000000000003', 'TUK7M2A1', 'TopUpKing',    '@topupking',    'topup@arc.id',   'Seller', 22, 'from-rose-500 to-red-600', 'TUP-7M2A', 'en', '{}', '2026-03-12'),
  ('22222222-0000-0000-0000-000000000004', 'KVT0E3B9', 'KeyVault',     '@keyvault',     'kv@arc.id',      'Seller', 18, 'from-emerald-500 to-teal-600', 'KVT-0E3B', 'en', '{}', '2026-01-02'),
  ('22222222-0000-0000-0000-000000000005', 'ALP8N1C4', 'AlphaDAO',     '@alphadao',     'alpha@arc.id',   'Seller', 9,  'from-amber-500 to-orange-600', 'ALP-8N1C', 'en', '{}', '2026-05-18'),
  ('22222222-0000-0000-0000-000000000006', 'GLD5R0E2', 'GoldFarmers',  '@goldfarmers',  'gold@arc.id',    'Seller', 41, 'from-lime-500 to-green-600', 'GLD-5R0E', 'en', '{}', '2025-11-20'),
  ('33333333-0000-0000-0000-000000000007', 'ADMIN001', 'admin',        '@slimeadmin',   'admin@arc.id',   'Admin',  0,  'from-rose-500 to-orange-600', 'ADM-IN01', 'en', '{}', '2026-01-01'),
  ('33333333-0000-0000-0000-000000000008', 'VLT3K9Z',  'vaultsmith',   '@vaultsmith',   'vault@arc.id',   'Seller', 5,  'from-indigo-500 to-violet-600', 'VLT-3K9Z', 'en', '{}', '2026-04-01'),
  ('33333333-0000-0000-0000-000000000009', 'LNR8M2A1', 'lunaris',      '@lunaris',      'lunaris@arc.id', 'Seller', 12, 'from-cyan-500 to-blue-600', 'LNR-8M2A', 'en', '{}', '2026-02-10')
on conflict (uid) do nothing;

-- ---------------------------------------------------------------------------
-- WALLETS  (fake Circle ids; balances mirror ME.usdc etc)
-- ---------------------------------------------------------------------------
insert into wallets (user_id, address, circle_wallet_id, usdc_balance) values
  -- NOTE: addresses use correct EIP-55 mixed-case checksum (viem isAddress strict).
  -- Regenerate via getAddress(lowercase) if changed; do not hand-edit case.
  ('11111111-0000-0000-0000-000000000001', '0x7a3F9C4e2b81DA56E0F1B9c7aE44D2c8B6E91f0A', 'cwallet-frostbyte',  842500000),
  ('22222222-0000-0000-0000-000000000002', '0x1a2b3C4d5e6F7A8B9c0D1e2f3A4B5c6d7e8F9A0B', 'cwallet-nebula',     1240000000),
  ('22222222-0000-0000-0000-000000000003', '0x2b3C4d5e6F7A8b9c0d1E2F3A4b5c6D7e8f9A0B1c', 'cwallet-topup',      3200000000),
  ('22222222-0000-0000-0000-000000000004', '0x3c4D5E6F7a8b9c0d1e2F3a4B5C6D7e8f9A0b1c2d', 'cwallet-keyvault',   510000000),
  ('22222222-0000-0000-0000-000000000005', '0x4D5e6f7A8b9C0D1e2F3a4B5c6d7e8f9A0b1C2D3E', 'cwallet-alphadao',   180000000),
  ('22222222-0000-0000-0000-000000000006', '0x5e6F7A8B9C0d1E2f3A4b5C6d7E8F9a0B1c2d3E4f', 'cwallet-goldfarmers',440000000),
  ('33333333-0000-0000-0000-000000000007', '0x6F7a8b9C0d1e2f3a4B5c6d7e8f9a0B1c2d3E4f5a', 'cwallet-admin',      1000000000),
  ('33333333-0000-0000-0000-000000000008', '0x7a8b9C0d1e2f3a4B5C6d7E8F9A0B1c2d3e4F5a6b', 'cwallet-vaultsmith', 75000000),
  ('33333333-0000-0000-0000-000000000009', '0x8B9c0D1E2F3A4b5c6D7E8F9A0b1c2d3e4f5A6B7c', 'cwallet-lunaris',    220000000)
on conflict (user_id) do nothing;

-- ---------------------------------------------------------------------------
-- STORES  (mirrors STORES in data2.jsx)
-- ---------------------------------------------------------------------------
insert into stores (owner_user_id, name, handle, uid, avatar_gradient, banner_gradient, message, rating, rating_count, joined_at) values
  ('22222222-0000-0000-0000-000000000002', 'NebulaGoods',  '@nebulagoods',  'NBL4K5QH', 'from-cyan-500 to-blue-600',   'from-cyan-600 via-blue-700 to-violet-800',     'Order from our store! Fast response 24/7, every product is escrow-protected.', 4.9, 128, '2026-06-09'),
  ('22222222-0000-0000-0000-000000000003', 'TopUpKing',    '@topupking',    'TUK7M2A1', 'from-rose-500 to-red-600',    'from-rose-600 via-pink-700 to-fuchsia-800',    'Fastest and cheapest game top-ups. Instant delivery, open 24 hours!',            4.8, 612, '2026-03-12'),
  ('22222222-0000-0000-0000-000000000004', 'KeyVault',     '@keyvault',     'KVT0E3B9', 'from-emerald-500 to-teal-600','from-emerald-600 via-teal-700 to-slate-900',  'Official gift cards & subscriptions, 100% valid codes. Full guarantee via Tribunal.', 5.0, 304, '2026-01-02'),
  ('22222222-0000-0000-0000-000000000005', 'AlphaDAO',     '@alphadao',     'ALP8N1C4', 'from-amber-500 to-orange-600','from-amber-600 via-orange-700 to-rose-900',   'On-chain verified WL spots & alpha access. Collateral escrow only.',             4.7, 53,  '2026-05-18'),
  ('22222222-0000-0000-0000-000000000006', 'GoldFarmers',  '@goldfarmers',  'GLD5R0E2', 'from-lime-500 to-green-600',  'from-lime-600 via-green-700 to-emerald-900',  'Cheapest in-game currency rates. Always in stock, lightning-fast delivery.',     4.6, 1520,'2025-11-20'),
  ('33333333-0000-0000-0000-000000000008', 'vaultsmith',   '@vaultsmith',   'VLT3K9Z',  'from-indigo-500 to-violet-600','from-indigo-600 via-violet-700 to-slate-900','WL spots & wallet surrender specialist. Collateral-backed.',                     4.8, 22,  '2026-04-01'),
  ('33333333-0000-0000-0000-000000000009', 'lunaris',      '@lunaris',      'LNR8M2A1', 'from-cyan-500 to-blue-600',   'from-cyan-600 via-blue-700 to-indigo-900',    'NFT alpha & WL broker. Fast settlement.',                                        4.9, 41,  '2026-02-10'),
  -- My store (Frost Digital) — owned by frostbyte (also a Seller in demo)
  ('11111111-0000-0000-0000-000000000001', 'Frost Digital','@frostdigital', 'FRST9K2X', 'from-arc-primary to-arc-accent','from-arc-primary via-arc-primarydk to-arc-surface','Trusted digital store — VCC, premium accounts & top-ups. Fast response, escrow-protected!', 4.9, 86, '2026-03-01')
on conflict (owner_user_id) do nothing;

-- Make frostbyte a Seller for the demo (so /my/store etc work in seed). Comment out for pure buyer-only.
update users set role = 'Seller' where uid = 'FRST9K2X';

-- ---------------------------------------------------------------------------
-- PRODUCTS  (mirrors PRODUCTS in data.jsx + MY_PRODUCTS in data2.jsx)
-- prices in micro-USDC (×1_000_000)
-- ---------------------------------------------------------------------------
-- helper: get store id by owner uid
do $$
declare
  v_nebula  uuid; v_topup  uuid; v_kv uuid; v_alpha uuid; v_gold uuid; v_frost uuid;
begin
  select id into v_nebula  from stores where uid='NBL4K5QH';
  select id into v_topup   from stores where uid='TUK7M2A1';
  select id into v_kv      from stores where uid='KVT0E3B9';
  select id into v_alpha   from stores where uid='ALP8N1C4';
  select id into v_gold    from stores where uid='GLD5R0E2';
  select id into v_frost   from stores where uid='FRST9K2X';

  -- p1: Genshin AR58 — manual
  insert into products (store_id, name, category, delivery, price, variants, "desc", gradient, glyph, status, stock, sold, views, hot, est)
  values (v_nebula, 'Genshin AR58 — Whale Account', 'Game Accounts', 'manual', 189000000,
          '[{"label":"Asia","price":189000000},{"label":"Europe","price":175000000},{"label":"America","price":182000000}]'::jsonb,
          'PERSONAL ACCOUNT · FULL ACCESS

• Adventure Rank 58, many 5★ characters + limited weapons
• Full email access + recovery handed over to you
• Choose your region: Asia / Europe / America
• 30-day anti-recovery guarantee via Escrow

After payment, credentials are sent encrypted in the Order Room. Confirmation required within 24 hours.',
          'from-indigo-600 via-violet-700 to-slate-900', '⛩', 'active', 3, 1243, 412, true, 15);

  -- p2: Valorant Points — instant (3 stock items for demo FIFO)
  insert into products (store_id, name, category, delivery, price, variants, "desc", gradient, glyph, status, stock_items, stock, sold, views, hot, est)
  values (v_topup, '60,000 Valorant Points', 'Currency', 'instant', 399000000,
          '[{"label":"10K VP","price":79000000},{"label":"30K VP","price":219000000},{"label":"60K VP","price":399000000}]'::jsonb,
          'OFFICIAL TOP-UP · INSTANT DELIVERY

• Valorant Points added automatically after payment
• Supports all regions (choose at checkout)
• No account login — just your Riot ID
• 1–3 minute processing, credentials auto-decrypted',
          'from-rose-600 via-pink-700 to-slate-900', '◈', 'active',
          array['Riot ID: frostbyte#ARC | VP Code: VP-7K2P-9XQ4-MA44 | Region: ID',
                'Riot ID: frostbyte#ARC | VP Code: VP-3D77-A1B2-EBD0 | Region: ID',
                'Riot ID: frostbyte#ARC | VP Code: VP-91B2-E4C9-F801 | Region: ID'],
          999, 8902, 980, true, 0);

  -- p3: Steam Gift Card — instant
  insert into products (store_id, name, category, delivery, price, variants, "desc", gradient, glyph, status, stock_items, stock, sold, views, est)
  values (v_kv, 'Steam Gift Card — Global', 'Gift Card', 'instant', 101000000,
          '[{"label":"$20","price":21000000},{"label":"$50","price":51000000},{"label":"$100","price":101000000}]'::jsonb,
          'GLOBAL GIFT CARD · INSTANT CODE

• Code sent instantly to the Order Room
• Global region, redeemable anywhere
• 100% valid code guarantee or refund via Tribunal',
          'from-slate-700 via-slate-800 to-slate-950', '▣', 'active',
          array['Redeem Code: STM-7K2P-9XQ4-MA44 | Region: Global | Claim Bot: @steamhubbot',
                'Redeem Code: STM-3D77-A1B2-EBD0 | Region: Global | Claim Bot: @steamhubbot',
                'Redeem Code: STM-5A0E-3B22-C9F8 | Region: Global | Claim Bot: @steamhubbot'],
          120, 4410, 256, 0);

  -- p5: CS2 Prime — manual
  insert into products (store_id, name, category, delivery, price, variants, "desc", gradient, glyph, status, stock, sold, views, hot, est)
  values (v_nebula, 'CS2 Prime + 3000 Hours', 'Game Accounts', 'manual', 320000000,
          '[{"label":"Faceit Lvl 7","price":145000000},{"label":"Faceit Lvl 10","price":320000000}]'::jsonb,
          'CS2 PRIME + 3000 HOURS

• Faceit ready, no VAC, no cooldown
• Full email access handed over
• 14-day guarantee via Escrow',
          'from-yellow-600 via-amber-700 to-slate-900', '✦', 'active', 8, 1243, 188, false, 20);

  -- p6: OSRS Gold — instant
  insert into products (store_id, name, category, delivery, price, variants, "desc", gradient, glyph, status, stock, sold, views, hot, est)
  values (v_gold, '500M Old School RS Gold', 'Currency', 'instant', 160000000,
          '[{"label":"100M","price":18000000},{"label":"500M","price":84000000},{"label":"1B","price":160000000}]'::jsonb,
          'OSRS GOLD · LOW RATES

• In stock, fast in-game delivery
• Cheapest rates, buy more to save more
• Safe, anti-ban trade method',
          'from-lime-700 via-green-800 to-slate-950', '◉', 'active', 999, 15203, 1502, false, 0);

  -- p7: PS Plus — instant
  insert into products (store_id, name, category, delivery, price, variants, "desc", gradient, glyph, status, stock, sold, views, hot, est)
  values (v_kv, 'PlayStation Plus — 12 Months', 'Gift Card', 'instant', 119000000,
          '[{"label":"Essential","price":59000000},{"label":"Extra","price":99000000},{"label":"Deluxe","price":119000000}]'::jsonb,
          'PS PLUS 12 MONTHS

• Instant activation to your account
• Choose a tier: Essential / Extra / Deluxe
• Full activation guarantee',
          'from-blue-700 via-indigo-800 to-slate-950', '⬢', 'active', 64, 4410, 320, false, 0);

  -- MY_PRODUCTS (owned by Frost Digital / frostbyte)
  -- mp1: VCC Wise Australia — instant, 100 stock
  insert into products (store_id, name, category, delivery, price, "desc", gradient, glyph, status, stock_items, stock, sold, views)
  values (v_frost, 'VCC Wise Australia', 'Digital Products', 'instant', 10000000,
          'VCC Wise Australia — virtual credit card for international payment verification. Single-use valid card.',
          'from-emerald-600 via-teal-700 to-slate-900', '💳', 'active',
          (select array_agg('WISE-AU-' || lpad(g::text,4,'0') || '-' || upper(substr(md5(g::text),1,4))) from generate_series(1,20) g),
          100, 42, 980);

  insert into products (store_id, name, category, delivery, price, "desc", gradient, glyph, status, stock, sold, views)
  values (v_frost, 'ChatGPT Plus 1 Month', 'Digital Products', 'manual', 12000000,
          'ChatGPT Plus 1 month — AI upgrade for work, study & productivity. Priority access.',
          'from-cyan-600 via-blue-700 to-indigo-900', '◈', 'active', 8, 153, 2110);

  insert into products (store_id, name, category, delivery, price, "desc", gradient, glyph, status, stock_items, stock, sold, views)
  values (v_frost, 'Netflix Premium 4K (sharing)', 'Digital Products', 'instant', 4000000,
          'Netflix Premium 4K sharing — shared account, 1-month guarantee, ready to use.',
          'from-rose-600 via-red-700 to-slate-900', '▣', 'active',
          (select array_agg('NFLX-' || lpad(g::text,4,'0') || '-' || upper(substr(md5(g::text),1,4))) from generate_series(1,15) g),
          25, 320, 4400);

  -- mp4 soldout (empty stock items)
  insert into products (store_id, name, category, delivery, price, "desc", gradient, glyph, status, stock_items, stock, sold, views)
  values (v_frost, 'Spotify Premium 3 Months', 'Digital Products', 'instant', 6000000,
          'Spotify Premium 3 months — instant activation, full guarantee.',
          'from-lime-600 via-green-700 to-emerald-900', '◉', 'soldout', '{}'::text[], 0, 211, 3010);

  insert into products (store_id, name, category, delivery, price, "desc", gradient, glyph, status, stock, sold, views)
  values (v_frost, 'Canva Pro 1 Year', 'Services', 'manual', 9000000,
          'Canva Pro 1 year — invite to your account, full activation guarantee.',
          'from-fuchsia-600 via-purple-700 to-slate-900', '✦', 'inactive', 0, 64, 880);
end $$;

-- ---------------------------------------------------------------------------
-- WL LISTINGS  (mirrors WL_LISTINGS in data2.jsx)
-- ---------------------------------------------------------------------------
insert into wl_listings (seller_id, project, wl_type, type, unit_price, mint_price, qty, project_link, offer, collateral, "desc", gradient, glyph)
values
  ('22222222-0000-0000-0000-000000000005', 'Azuki — Elementals',    'GTD Allowlist', 'wallet_surrender', 540000000, 0,         3,  'https://azuki.com',          true,  true,  'Verified GTD spot. Full wallet + seed handover via escrow. Seller collateral held until confirmation.', 'from-orange-600 via-amber-700 to-slate-900', '⬡'),
  ('22222222-0000-0000-0000-000000000005', 'Monad Testnet OG',      'OG Role',       'discord_surrender',280000000, 0,         5,  'https://monad.xyz',          true,  false, 'OG-role Discord account handed over to the buyer. No collateral (Discord Surrender).',                              'from-purple-700 via-violet-800 to-slate-950','✶'),
  ('33333333-0000-0000-0000-000000000008', 'LayerZero Genesis',     'Mint Pass',     'mint',             120000000, 90000000,  8,  'https://layerzero.network',  true,  true,  'Seller mints directly to your wallet. Seller collateral = mint price held until the NFT is received.',              'from-cyan-600 via-blue-700 to-indigo-900',   '⬢'),
  ('33333333-0000-0000-0000-000000000009', 'Pudgy Rounds',          'FCFS',          'wallet_submit',     35000000, 0,         20, 'https://pudgypenguins.com',  false, false, 'Your address is submitted to the project allowlist. No collateral (Wallet Submit).',                               'from-sky-600 via-cyan-700 to-slate-900',     '◉')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- NOTIFICATIONS  (mirrors NOTIFS in auth.jsx)
-- ---------------------------------------------------------------------------
insert into notifications (user_id, icon, tone, title, text, "read", link) values
  ('11111111-0000-0000-0000-000000000001', 'package-check', 'cyan',    'Order shipped',      'SLM-69E11226 · credentials sent by the seller', false, 'orders'),
  ('11111111-0000-0000-0000-000000000001', 'gavel',         'rose',    'Dispute updated',    'SLM-69A33B18 · Tribunal is reviewing',          false, 'orders'),
  ('11111111-0000-0000-0000-000000000001', 'wallet',        'emerald', 'Top-up successful',  '+500.00 USDC via Circle on-ramp',               true,  'saldo'),
  ('11111111-0000-0000-0000-000000000001', 'gift',          'violet',  'New referral',       'kanezaka joined via your invite',               true,  'referral')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- REFERRAL  (mirrors REFERRAL in data2.jsx)
-- Leaderboard model: no per-signup / per-transaction payout. Rewards are zeroed;
-- ranking-based prizes only (no free money promised by the platform).
-- ---------------------------------------------------------------------------
insert into referrals (user_id, code, link, invited, earned, pending, tiers) values
  ('11111111-0000-0000-0000-000000000001', 'FROST-9K2X', 'https://slimemarket.xyz/r/FROST-9K2X', 12, 0, 0,
   '[{"label":"Monthly leaderboard","value":"Top inviters win USDC"}]'::jsonb)
on conflict (user_id) do nothing;

insert into referral_events (referrer_id, referee_uid, reward, status) values
  ('11111111-0000-0000-0000-000000000001', 'shadowmint',  0, 'done'),
  ('11111111-0000-0000-0000-000000000001', 'kanezaka',    0, 'done'),
  ('11111111-0000-0000-0000-000000000001', 'voidrunner',  0, 'pending')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- BANK ACCOUNTS  (empty per data2.jsx SALDO.banks = [])
-- (intentionally no rows — frontend starts with "No bank accounts yet")

-- ---------------------------------------------------------------------------
-- WALLET TXS  (mirrors FIAT_TX in data2.jsx)
-- Note: wallet_id is the wallets.id (FK), NOT the user id. Resolve via the
-- frostbyte user's wallet to avoid the FK violation.
-- ---------------------------------------------------------------------------
insert into wallet_txs (wallet_id, type, label, sub, amount, status, method, metadata)
select w.id, t.type, t.label, t.sub, t.amount, t.status, t.method, t.metadata
  from wallets w
  join (
    values
      ('11111111-0000-0000-0000-000000000001'::uuid, 'in',  'Top-up via QRIS',             'Fiat IDR → USDC · successful',   30710000,  'done',     'qris'::text, '{}'::jsonb),
      ('11111111-0000-0000-0000-000000000001'::uuid, 'out', 'Order Payment SLM-69EAFB64',  '60,000 Valorant Points',         399950000, 'done',     'onchain',    '{}'::jsonb),
      ('11111111-0000-0000-0000-000000000001'::uuid, 'in',  'Top-up via Circle On-Ramp',   'Visa •••• 4417 → USDC',          500000000, 'done',     'card',       '{}'::jsonb),
      ('11111111-0000-0000-0000-000000000001'::uuid, 'out', 'Escrow Lock SLM-69E11226',    'Genshin AR58 — Asia',            190370000, 'escrowed', 'onchain',    '{}'::jsonb)
  ) as t(user_id, type, label, sub, amount, status, method, metadata)
    on t.user_id = w.user_id
on conflict do nothing;

commit;
