-- Expand the Activity Log from the original counselling-only choices to the
-- practicum activities interns actually need to evidence.

alter table hours drop constraint if exists hours_service_type_check;

-- Preserve older rows while using the clearer name for future reporting.
update hours
set service_type = 'Other professional activity'
where service_type = 'Other activity';

alter table hours add constraint hours_service_type_check
  check (service_type is null or service_type in (
    'Individual counselling',
    'Group counselling',
    'Family counselling',
    'Community talk / psychoeducation',
    'Public health / advocacy',
    'Preparation / documentation',
    'Training',
    'Supervision',
    'Psychological assessment',
    'Ethical / professional activity',
    'Other professional activity'
  ));
