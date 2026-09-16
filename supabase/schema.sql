-- Launch Calendar schema
create table if not exists launches (
  id uuid primary key default gen_random_uuid(),
  project text not null,
  project_brief text not null,
  product_area text not null check (product_area in
    ('Platform','Customer Integrations','Data Infrastructure','Core Product','AI & Chat','Search & Views','Onboarding')),
  dri text not null,
  requesting_team text not null check (requesting_team in
    ('Legal','Sales','Marketing','Finance','Support')),
  impacted_teams text[], -- nullable, multi-select
  launch_date date not null,
  previous_launch_date date, -- single most recent prior value; full history in change_log
  status text not null default 'Backlog' check (status in
    ('Backlog','In Progress','At Risk','Off Track','Shipped','Cancelled')),
  status_summary text,
  project_stage text default 'Discovery' check (project_stage in
    ('Discovery','Design','Implementation','Launch Readiness','Post Launch Support','Completed','Cancelled')),
  scope_change text check (scope_change in ('Scope Creep','Trade Off','Descoped')),
  release_stage text check (release_stage in ('Pilot','Beta','GA')),
  release_size text check (release_size in ('Small','Medium','Large','Extra Large')),
  dependency text,
  customer_data_impact text default 'No' check (customer_data_impact in ('Yes','No')),
  jurisdiction text default 'No' check (jurisdiction in ('Yes','No')),
  collaborators text[],
  success_metrics text check (success_metrics in
    ('Regulatory & Compliance','Productivity','Growth','Activation','Retention')),
  business_priority text check (business_priority in ('Critical','High','Medium','Low')),
  change_log text default '', -- append-only, one line per change
  created_date timestamptz not null default now(),
  last_updated timestamptz not null default now(),
  last_update_by text default 'Madhuri' -- static, no auth in this POC
);

-- Unresolved/flagged queue for trap-case messages (Appendix B: A, B style inputs)
create table if not exists unresolved_messages (
  id uuid primary key default gen_random_uuid(),
  raw_message text not null,
  reason text not null, -- why the agent couldn't confidently act on it
  matched_project_id uuid references launches(id),
  created_date timestamptz not null default now(),
  resolved boolean default false
);

-- Auto-update last_updated on every row change
create or replace function set_last_updated()
returns trigger as $$
begin
  new.last_updated = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_set_last_updated on launches;
create trigger trg_set_last_updated
  before update on launches
  for each row
  execute function set_last_updated();
