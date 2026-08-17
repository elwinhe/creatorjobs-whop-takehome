create extension if not exists pgcrypto;

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  display_name text not null,
  role text not null check (role in ('buyer','seller','admin')),
  whop_user_id text unique,
  created_at timestamptz not null default now()
);

create table seller_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users(id),
  whop_company_id text unique,
  onboarding_status text not null default 'created' check (onboarding_status in
    ('created','link_sent','kyc_pending','verified','payout_ready','blocked')),
  has_payout_method boolean not null default false,
  last_account_link_url text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table listings (
  id uuid primary key default gen_random_uuid(),
  seller_id uuid not null references seller_profiles(id),
  title text not null,
  description text not null default '',
  price_cents integer not null check (price_cents > 0),
  currency text not null default 'usd',
  status text not null default 'active' check (status in ('draft','active','archived')),
  created_at timestamptz not null default now()
);

create table orders (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listings(id),
  buyer_id uuid not null references users(id),
  seller_id uuid not null references seller_profiles(id),
  amount_cents integer not null,
  currency text not null default 'usd',
  status text not null default 'pending_payment' check (status in
    ('pending_payment','paid','in_progress','delivered','completed','payout_pending',
     'paid_out','payout_failed','canceled','refunded')),
  whop_checkout_config_id text unique,
  whop_payment_id text unique,
  paid_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index orders_status_idx on orders (status);
create index orders_seller_status_idx on orders (seller_id, status);

create table submissions (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  seller_id uuid not null references seller_profiles(id),
  content_url text,
  note text,
  status text not null default 'submitted' check (status in ('submitted','approved','rejected')),
  created_at timestamptz not null default now()
);

create table payouts (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references orders(id),
  seller_id uuid not null references seller_profiles(id),
  amount_cents integer not null,
  currency text not null default 'usd',
  whop_transfer_id text unique,
  idempotency_key uuid not null unique default gen_random_uuid(),
  status text not null default 'pending' check (status in ('pending','processing','succeeded','failed')),
  failure_reason text,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);

create table webhook_events (
  id uuid primary key default gen_random_uuid(),
  whop_event_id text not null unique,
  event_type text not null,
  api_version_date text,
  whop_company_id text,
  payload jsonb not null,
  status text not null default 'received' check (status in
    ('received','processed','duplicate','ignored','error')),
  error text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
create index webhook_events_type_received_idx on webhook_events (event_type, received_at desc);

create table order_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id),
  from_status text not null,
  to_status text not null,
  applied boolean not null,
  actor text not null,
  webhook_event_id uuid references webhook_events(id),
  note text,
  created_at timestamptz not null default now()
);
create index order_events_order_created_idx on order_events (order_id, created_at);

create table api_request_log (
  id uuid primary key default gen_random_uuid(),
  method text not null,
  path text not null,
  status_code integer,
  whop_request_id text,
  error text,
  created_at timestamptz not null default now()
);
