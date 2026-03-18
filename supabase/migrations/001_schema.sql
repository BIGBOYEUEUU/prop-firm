-- ═══════════════════════════════════════════════════════════════
-- TRD-WISE Database Schema
-- Run this in Supabase SQL Editor or via migrate.js
-- ═══════════════════════════════════════════════════════════════

-- Enable UUID generation
create extension if not exists "uuid-ossp";

-- ─── USERS ──────────────────────────────────────────────────────
create table if not exists users (
  id              uuid primary key default uuid_generate_v4(),
  email           text unique not null,
  full_name       text,
  phone           text,                        -- Kenya format +2547XXXXXXXX
  role            text not null default 'trader'
                  check (role in ('trader','support_admin','risk_admin',
                                  'education_admin','payments_admin',
                                  'university_admin','super_admin')),
  university_email      text,
  university_verified   boolean default false,
  university_domain     text,
  kyc_status      text default 'pending'
                  check (kyc_status in ('pending','submitted','verified','rejected')),
  is_active       boolean default true,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ─── TIER CONFIGURATION (admin-controlled) ──────────────────────
create table if not exists tier_config (
  id                    serial primary key,
  tier_key              text unique not null,   -- 'seed','sprint','ascend','apex'
  tier_name             text not null,
  fee_kes               numeric(12,2) not null,
  account_size_usd      numeric(12,2) not null,
  phase1_profit_target  numeric(5,2) not null default 10.00,  -- percent
  phase2_profit_target  numeric(5,2) not null default 5.00,
  max_daily_dd          numeric(5,2) not null default 5.00,
  max_overall_dd        numeric(5,2) not null default 10.00,
  min_trading_days      int not null default 5,
  max_calendar_days     int,                    -- null = no limit
  drawdown_model        text default 'static'
                        check (drawdown_model in ('static','trailing','hybrid')),
  daily_dd_mode         text default 'A'
                        check (daily_dd_mode in ('A','B','C')),
  daily_reset_time      time default '00:00:00',
  daily_reset_timezone  text default 'Africa/Nairobi',
  education_level       text default 'basic'
                        check (education_level in ('basic','full','full_seminars','vip')),
  support_level         text default 'standard'
                        check (support_level in ('standard','priority','dedicated')),
  is_active             boolean default true,
  display_order         int default 0,
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);

-- Seed default tiers
insert into tier_config
  (tier_key, tier_name, fee_kes, account_size_usd, display_order)
values
  ('seed',   'Seed',   500,    5000,  1),
  ('sprint', 'Sprint', 1500,   15000, 2),
  ('ascend', 'Ascend', 4500,   50000, 3),
  ('apex',   'Apex',   130000, 100000,4)
on conflict (tier_key) do nothing;

-- ─── EVALUATIONS ────────────────────────────────────────────────
create table if not exists evaluations (
  id                uuid primary key default uuid_generate_v4(),
  user_id           uuid not null references users(id) on delete cascade,
  tier_key          text not null references tier_config(tier_key),
  phase             int not null default 1 check (phase in (1,2,3)),  -- 3 = funded
  status            text not null default 'pending_payment'
                    check (status in ('pending_payment','active','passed',
                                      'breached','expired','funded')),

  -- Balances (USD)
  initial_balance   numeric(14,2) not null,
  current_balance   numeric(14,2) not null,
  peak_equity       numeric(14,2) not null,       -- for trailing DD
  start_of_day_bal  numeric(14,2),                -- for Mode A daily DD

  -- Rule snapshot at time of purchase (immutable after activation)
  phase1_profit_target  numeric(5,2) not null,
  phase2_profit_target  numeric(5,2) not null,
  max_daily_dd          numeric(5,2) not null,
  max_overall_dd        numeric(5,2) not null,
  min_trading_days      int not null,
  max_calendar_days     int,
  drawdown_model        text not null,
  daily_dd_mode         text not null,

  -- Progress
  trading_days_count    int default 0,
  current_daily_dd      numeric(5,2) default 0,
  current_overall_dd    numeric(5,2) default 0,
  current_profit_pct    numeric(7,2) default 0,

  -- Breach detail
  breach_rule       text,
  breach_value      numeric(12,4),
  breach_at         timestamptz,

  -- Dates
  activated_at      timestamptz,
  passed_at         timestamptz,
  expires_at        timestamptz,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- ─── TRADES ─────────────────────────────────────────────────────
create table if not exists trades (
  id              uuid primary key default uuid_generate_v4(),
  evaluation_id   uuid not null references evaluations(id) on delete cascade,
  user_id         uuid not null references users(id),

  -- MT5 / external fields
  mt5_ticket      bigint,
  instrument      text not null,
  direction       text not null check (direction in ('BUY','SELL')),
  lot_size        numeric(10,4) not null,
  entry_price     numeric(16,5) not null,
  exit_price      numeric(16,5),
  stop_loss       numeric(16,5),
  take_profit     numeric(16,5),

  -- P&L (USD)
  pnl             numeric(14,2),
  commission      numeric(10,4) default 0,
  swap            numeric(10,4) default 0,

  -- Status
  status          text not null default 'open'
                  check (status in ('open','closed','cancelled')),
  opened_at       timestamptz not null,
  closed_at       timestamptz,
  trading_day     date,                 -- computed: date in EAT timezone

  -- Tagging
  strategy_tag    text,
  notes           text,

  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ─── RULE EVENT LOG ─────────────────────────────────────────────
create table if not exists rule_events (
  id              uuid primary key default uuid_generate_v4(),
  evaluation_id   uuid not null references evaluations(id) on delete cascade,
  event_type      text not null check (event_type in ('info','warning','breach','reset','pass')),
  rule_name       text,
  message         text not null,
  value_at_event  numeric(12,4),
  threshold       numeric(12,4),
  created_at      timestamptz default now()
);

-- ─── PAYMENTS / TRANSACTIONS ────────────────────────────────────
create table if not exists transactions (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references users(id),
  evaluation_id   uuid references evaluations(id),
  type            text not null check (type in ('evaluation_fee','refund','payout')),
  amount_kes      numeric(14,2) not null,
  amount_usd      numeric(14,2),
  kes_usd_rate    numeric(10,4),

  -- M-PESA fields
  mpesa_phone         text,
  mpesa_checkout_id   text unique,
  mpesa_receipt       text unique,
  mpesa_result_code   int,
  mpesa_result_desc   text,

  status          text not null default 'pending'
                  check (status in ('pending','confirmed','failed','refunded')),
  confirmed_at    timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

-- ─── EDUCATION ──────────────────────────────────────────────────
create table if not exists seminars (
  id              uuid primary key default uuid_generate_v4(),
  title           text not null,
  description     text,
  agenda          text,
  scheduled_at    timestamptz not null,
  duration_mins   int default 60,
  level           text default 'beginner' check (level in ('beginner','intermediate','advanced')),
  stream_url      text,
  replay_url      text,
  is_published    boolean default false,
  created_at      timestamptz default now()
);

create table if not exists seminar_registrations (
  id              uuid primary key default uuid_generate_v4(),
  seminar_id      uuid not null references seminars(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  attended        boolean default false,
  created_at      timestamptz default now(),
  unique(seminar_id, user_id)
);

create table if not exists courses (
  id              uuid primary key default uuid_generate_v4(),
  title           text not null,
  description     text,
  category        text not null,
  level           text default 'beginner',
  duration_mins   int,
  is_published    boolean default false,
  display_order   int default 0,
  created_at      timestamptz default now()
);

create table if not exists course_progress (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references users(id),
  course_id       uuid not null references courses(id),
  completed       boolean default false,
  completed_at    timestamptz,
  created_at      timestamptz default now(),
  unique(user_id, course_id)
);

create table if not exists certificates (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references users(id),
  type            text not null check (type in ('seminar','course','phase','risk_mastery')),
  title           text not null,
  reference_id    uuid,                  -- seminar_id, course_id, or evaluation_id
  verification_code text unique default upper(substring(md5(random()::text),1,12)),
  issued_at       timestamptz default now()
);

-- ─── UNIVERSITY ARENA ───────────────────────────────────────────
create table if not exists university_domains (
  id              serial primary key,
  domain          text unique not null,  -- e.g. uonbi.ac.ke
  institution     text not null,
  is_active       boolean default true,
  added_at        timestamptz default now()
);

-- Seed common Kenyan university domains
insert into university_domains (domain, institution) values
  ('uonbi.ac.ke',     'University of Nairobi'),
  ('ku.ac.ke',        'Kenyatta University'),
  ('strathmore.edu',  'Strathmore University'),
  ('daystar.ac.ke',   'Daystar University'),
  ('usiu.ac.ke',      'USIU Africa'),
  ('kcau.ac.ke',      'KCA University'),
  ('mku.ac.ke',       'Mount Kenya University')
on conflict (domain) do nothing;

create table if not exists arena_competitions (
  id              uuid primary key default uuid_generate_v4(),
  month           text not null unique,   -- e.g. '2025-03'
  title           text,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  status          text default 'upcoming' check (status in ('upcoming','active','completed')),
  winner_user_id  uuid references users(id),
  prize_issued    boolean default false,
  created_at      timestamptz default now()
);

create table if not exists arena_entries (
  id              uuid primary key default uuid_generate_v4(),
  competition_id  uuid not null references arena_competitions(id),
  user_id         uuid not null references users(id),
  evaluation_id   uuid references evaluations(id),  -- their competition eval
  score           numeric(8,4) default 0,
  rank            int,
  profit_pct      numeric(8,4) default 0,
  created_at      timestamptz default now(),
  unique(competition_id, user_id)
);

-- ─── SUPPORT TICKETS ────────────────────────────────────────────
create table if not exists support_tickets (
  id              uuid primary key default uuid_generate_v4(),
  user_id         uuid not null references users(id),
  ticket_number   serial unique,
  category        text not null,
  subject         text not null,
  description     text not null,
  status          text default 'open' check (status in ('open','in_progress','resolved','closed')),
  assigned_to     uuid references users(id),
  resolved_at     timestamptz,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create table if not exists ticket_messages (
  id              uuid primary key default uuid_generate_v4(),
  ticket_id       uuid not null references support_tickets(id) on delete cascade,
  sender_id       uuid not null references users(id),
  message         text not null,
  is_internal     boolean default false,
  created_at      timestamptz default now()
);

-- ─── AUDIT LOG ──────────────────────────────────────────────────
create table if not exists audit_log (
  id              uuid primary key default uuid_generate_v4(),
  actor_id        uuid references users(id),
  actor_email     text,
  action          text not null,
  table_name      text,
  record_id       text,
  before_value    jsonb,
  after_value     jsonb,
  ip_address      text,
  created_at      timestamptz default now()
);

-- ─── INDEXES ────────────────────────────────────────────────────
create index if not exists idx_evaluations_user     on evaluations(user_id);
create index if not exists idx_evaluations_status   on evaluations(status);
create index if not exists idx_trades_evaluation    on trades(evaluation_id);
create index if not exists idx_trades_status        on trades(status);
create index if not exists idx_trades_trading_day   on trades(trading_day);
create index if not exists idx_transactions_user    on transactions(user_id);
create index if not exists idx_rule_events_eval     on rule_events(evaluation_id);
create index if not exists idx_audit_actor          on audit_log(actor_id);

-- ─── ROW LEVEL SECURITY (Supabase) ──────────────────────────────
alter table users                 enable row level security;
alter table evaluations           enable row level security;
alter table trades                enable row level security;
alter table transactions          enable row level security;
alter table rule_events           enable row level security;
alter table support_tickets       enable row level security;
alter table certificates          enable row level security;
alter table course_progress       enable row level security;
alter table seminar_registrations enable row level security;
alter table arena_entries         enable row level security;

-- Users can only see their own data; service role bypasses RLS
create policy "users_own_data" on users
  for all using (auth.uid()::text = id::text);

create policy "evals_own_data" on evaluations
  for all using (auth.uid()::text = user_id::text);

create policy "trades_own_data" on trades
  for all using (auth.uid()::text = user_id::text);

create policy "transactions_own_data" on transactions
  for all using (auth.uid()::text = user_id::text);

-- Public read for tiers, seminars, courses, university domains
create policy "tier_public_read" on tier_config for select using (true);
create policy "seminars_public_read" on seminars for select using (is_published = true);
create policy "courses_public_read" on courses for select using (is_published = true);
create policy "domains_public_read" on university_domains for select using (is_active = true);

-- ─── Additional columns needed by routes ────────────────────────
alter table users add column if not exists password_hash text;
alter table evaluations add column if not exists mt5_login bigint;
