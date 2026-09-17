# Stellenbosch RC Practicum Hub v4.2 — Erin live-pilot integration

A multi-user practicum-management and learning application for the Stellenbosch Subdistrict Registered Counsellor placement programme.

## What changed in v4 / v4.1

### Verified institution-specific requirement profiles
The old single `720 hours` progress bar has been replaced with formal requirement profiles.

**SACAP 2026:** 202 counselling; 86 preparation/documentation; 180 psycho-education/community/public-health/advocacy; 72 training/supervision; 36 ethical/professional conduct; 72 psychological assessment; 72 other professional activities = 720.

**Cornerstone 2026:** 120 individual counselling; 100 group counselling; 100 professional skills development; 140 administration; 24 supervision; 20 presentations; 60 psychometrics; 130 community; 26 other professional activities = 720. Professional and personal journals are tracked as deliverables because the supplied logbook shows no hour target for them.

See `docs/requirement-sources.md` for source and interpretation notes.

### Pace-to-target engine
For each hour-bearing requirement the Hub now calculates:
- completed and remaining hours;
- percentage complete;
- remaining placement weeks;
- weekly hours needed to finish;
- recent/lifetime pace and projected completion;
- On track / Watch / Target at risk status.

For the relevant clinical counselling requirement it also calculates:
- equivalent attended counselling sessions required per week;
- booking target adjusted for the intern's actual attendance rate;
- expected weekly sessions from the active caseload and planned case frequency;
- whether additional clinical allocation / throughput may be needed.

### No double-counting of individual counselling
Attended individual case sessions record their duration. That duration automatically contributes to the institution's individual/combined counselling requirement. Interns do not manually log those same hours again.

SACAP's combined counselling category can additionally receive manually logged group/family counselling hours. Cornerstone group counselling is logged against its separate 100-hour requirement.

### Practicum Assistant
A contextual `Help / I'm stuck` layer is now built into the Hub. It provides:
- risk/escalation routing;
- RC scope prompts;
- session-planning / clinical-thinking prompts;
- documentation coaching;
- live placement-hour guidance;
- handbook retrieval;
- one-click conversion of uncertainty into a supervision item.

This version is deliberately **grounded assistance**, not an unrestricted generative clinical chatbot. It does not diagnose and does not replace supervision. A generative AI model can be added later if governance, privacy and cost are agreed.

## Existing core features
- One site with Programme Lead, Supervisor, Intern and Management roles.
- Server-side permission checks.
- Netlify Identity authentication model.
- Netlify Database (Postgres) with migrations.
- De-identified case workflow.
- Supervision queue and supervisor feedback.
- Competency evidence, self-rating and supervisor rating.
- Monthly booked/attended, male/female, first/follow-up statistics.
- Programme evidence dashboard.
- Original searchable 27-section handbook.
- Emergency quick reference from every role.
- Mobile-responsive UI.

## Data-governance boundary
The Hub is designed for de-identified programme-management data. Do not enter patient names, ID numbers, telephone numbers, addresses or narrative clinical records unless WCDHW separately approves an architecture for identifiable clinical information.

## Deploying to the existing Netlify project
Project: `bpsychpracticumhandbook`

1. Deploy this repository/folder to the existing project.
2. Enable Netlify Identity and set registration to invite-only.
3. `PROGRAMME_LEAD_EMAILS` is used to recognise programme-lead accounts.
4. Netlify Database provisions automatically through `@netlify/database` and applies the migrations.
5. Create each intern profile in the Hub, then invite the same email via Netlify Identity.

## Preview without authentication
- `?preview=programme_lead`
- `?preview=intern`
- `?preview=management`

Optional view examples:
- `?preview=intern&view=progress`
- `?preview=intern&view=assistant`

Preview data is synthetic.

## Erin pilot data

The preview build now includes the first real pilot: Erin George's SACAP 2026 logbook, imported in a privacy-preserving summary form. Open `?preview=programme_lead` or `?preview=intern&view=progress` to see her actual requirement profile and recent counselling pace.

The pilot deliberately distinguishes the SACAP workbook's displayed 502.5 hours from 470.5 hours supported by student-signed rows because some template rows contain pre-filled durations without a student signature. See `pilot/ERIN_PILOT.md` for the category breakdown and data-quality flags.


## v4.2 live-pilot additions (16 September 2026)
- Erin placement end date: **12 November 2026**.
- Real weekly rhythm: Monday supervision + Stellenbosch Hospital; Tuesday Don & Pat/Jamestown + psychoeducation; alternating Wednesday Stellenbosch Hospital/Night Shelter; Thursday Idas Valley + SACAP supervision at 12:00; Friday SACAP campus.
- Planned October community pipeline is visible but does **not** count as completed hours until logged.
- Built-in **Pilot feedback** screen for Erin; feedback can be reviewed during supervision and used to iterate the Hub.
- Intern home screen has been rebalanced so the **handbook + help + supervision + weekly practicum flow** remain central, with tracking integrated rather than dominating the experience.
