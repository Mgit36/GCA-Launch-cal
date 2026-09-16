-- Adds Business Priority, and removes 'Not Applicable' as a value for Customer Data
-- Impact / Jurisdiction (now Yes/No only). Run this against an already-provisioned
-- database (one that ran schema.sql before this migration existed) via the Supabase
-- SQL editor. A fresh install only needs schema.sql, which already reflects this.

alter table launches
  add column if not exists business_priority text check (business_priority in
    ('Critical','High','Medium','Low'));

-- Existing 'Not Applicable' rows become 'No' - the closest equivalent now that the
-- value no longer exists, and matches the new create-flow default (see route.ts).
update launches set customer_data_impact = 'No' where customer_data_impact = 'Not Applicable';
update launches set jurisdiction = 'No' where jurisdiction = 'Not Applicable';

alter table launches alter column customer_data_impact set default 'No';
alter table launches alter column jurisdiction set default 'No';

alter table launches drop constraint if exists launches_customer_data_impact_check;
alter table launches add constraint launches_customer_data_impact_check
  check (customer_data_impact in ('Yes','No'));

alter table launches drop constraint if exists launches_jurisdiction_check;
alter table launches add constraint launches_jurisdiction_check
  check (jurisdiction in ('Yes','No'));
