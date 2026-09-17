# Practicum Hub v4 — critique, fixes and second review

## First critique: five practical weaknesses found

1. **A single 720-hour bar was structurally wrong.**
   - SACAP and Cornerstone allocate the 720 hours differently.
   - **Fixed:** verified institution-specific profiles now load automatically.

2. **Counselling could easily be double-counted.**
   - Asking interns to record a session and then separately log the same counselling hour would corrupt the totals.
   - **Fixed:** attended individual sessions contribute from their recorded duration. Manual logging is reserved for activities not already captured as individual case sessions.

3. **“How many hours are left?” did not answer the operational question.**
   - The supervisor needs to know the pace required and whether the current allocation can produce it.
   - **Fixed:** remaining hours, hours/week, equivalent attended sessions/week, attendance-adjusted booking target and projected completion are calculated continuously.

4. **Caseload size alone is not meaningful.**
   - Five weekly cases generate a different workload from five monthly cases.
   - **Fixed:** each active case has a planned weekly / fortnightly / monthly frequency, which feeds the caseload adequacy estimate.

5. **Help was too passive if it only lived in the handbook.**
   - Interns need support at the point where they are stuck.
   - **Fixed:** the Practicum Assistant provides handbook-grounded help, risk/scope routing, live hour guidance and one-click supervision preparation.

## Additional fix from the review

Existing interns already have months of completed work. Re-entering historical activity would be unrealistic and would distort monthly reports.

**Fixed:** supervisors can set a one-time **opening balance** per formal requirement from the intern's existing university logbook. New activity is then added prospectively.

## Second critique: what is now strong

- The system represents SACAP and Cornerstone as genuinely different programmes.
- Clinical pace is linked to real attendance and session duration rather than a guessed number of patients.
- The supervisor can identify likely shortfalls before the placement end date.
- Monthly reporting is generated from operational data rather than repeated manual counting.
- Current interns can be onboarded without reconstructing their entire placement history.
- Help, handbook use and supervision are linked instead of being separate workflows.

## Second critique: remaining maturity gaps

1. **Institution responsibility split needs formal confirmation.**
   The hour targets are verified from the supplied sources. Some `site/shared/campus` responsibility labels are operational classifications because the source material does not explicitly assign responsibility for every category.

2. **Group counselling is currently logged as activity hours.**
   A future group module could additionally record group sessions, participant counts, programme name and repeat attendance without using patient-identifying data.

3. **The Practicum Assistant is grounded, not generative AI.**
   This is deliberate for the pilot. A true LLM layer would need an approved model/provider, privacy rules, prompt boundaries and cost/governance decisions.

4. **Intern invitation is still a two-step onboarding process.**
   The placement profile is created in the Hub and the same email is then invited through Netlify Identity. A later administrative function can combine those steps.

5. **Automated reminders are not yet enabled.**
   The data model can support alerts for report deadlines, hour shortfalls, overdue referral stages and supervision preparation, but notifications should be added once the core workflow is in real use.

## Recommended pilot sequence

1. Deploy v4 to the existing Netlify project.
2. Enable invite-only Identity.
3. Add one SACAP intern and one Cornerstone intern as a controlled pilot.
4. Enter opening balances from their existing logbooks.
5. Use live case/activity logging for 2–4 weeks.
6. Compare Hub totals against the institutional logbooks before scaling to the full cohort.
