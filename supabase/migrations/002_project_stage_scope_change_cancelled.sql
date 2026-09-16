-- Adds Project Stage + Scope Change fields, and extends Status with 'Cancelled'.
-- Run this against an already-provisioned database (one that ran the original
-- schema.sql before this migration existed) via the Supabase SQL editor.
-- A fresh install only needs schema.sql, which already includes these columns.

alter table launches
  add column if not exists project_stage text default 'Discovery' check (project_stage in
    ('Discovery','Design','Implementation','Launch Readiness','Post Launch Support','Completed','Cancelled'));

alter table launches
  add column if not exists scope_change text check (scope_change in ('Scope Creep','Trade Off','Descoped'));

alter table launches drop constraint if exists launches_status_check;
alter table launches add constraint launches_status_check check (status in
  ('Backlog','In Progress','At Risk','Off Track','Shipped','Cancelled'));

update launches set project_stage = 'Discovery' where project_stage is null;
