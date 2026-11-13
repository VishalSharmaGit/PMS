# PMS v2 — Supabase + GitHub Pages (step-by-step)

You will have: **website on GitHub Pages → Supabase (database, login, real-time)**, plus one tiny Apps Script
(`bridge/Bridge.js`) that only talks to your FMS Google Sheets in the background.

## Step 1 — Database (Supabase)
1. Create a Supabase project (pick the region nearest your factory, e.g. Mumbai).
2. **SQL Editor → New query**: paste `sql/01_schema.sql` → **Run**.
   You should see "Success. No rows returned".
3. **Table Editor → each table → Insert → Import data from CSV**, in this order, using the files in `data/csv/`:
   `pms_process_master`, `pms_workers`, `pms_fms_index`, `pms_settings`, `pms_tasks`, `pms_work_log`.
   (Expected rows: 9 / 241 / 52 / 8 / 3,026 / 2,066.)
4. **SQL Editor**: paste `sql/02_accounts_and_grants.sql` → Run.
5. Create the logins (each query shows its result ONCE — click *Export → CSV* and save it somewhere safe):
   ```sql
   select * from pms_provision_staff();     -- admins + supervisors with random passwords
   select * from pms_provision_workers();   -- every active worker: Worker ID + 6-digit PIN
   ```
   Give each worker their PIN. Change admin passwords to your own any time:
   `select pms_set_password('mis@pratap.ws', 'My#NewPassword1');`
6. **Authentication → Providers → Email**: turn **off** "Allow new users to sign up" (nobody can self-register) and
   turn **off** "Confirm email". Leave session settings at default (sessions never expire).

## Step 2 — Website (GitHub Pages)
1. Supabase **Project Settings → API**: copy the **Project URL** and the **anon public** key.
2. Open `web/config.js`, paste both. (Never paste the `service_role` key here.)
3. Create a GitHub repo, upload everything inside `web/` (including `.nojekyll`).
4. Repo **Settings → Pages → Deploy from branch → main / root**. After ~1 minute your app is at
   `https://<user>.github.io/<repo>/`.
5. Supabase **Authentication → URL Configuration**: set Site URL to that address.

## Step 3 — FMS bridge (Apps Script, runs by itself)
1. script.google.com → **New project** (name it "PMS FMS Bridge"). Paste `bridge/Bridge.js`.
2. In `setupBridge()` fill your Supabase URL and **service_role** key (Project Settings → API). Keep this project private.
3. Run `setupBridge` once and approve permissions. It creates the two timers and does the first sync.
   Afterwards you can delete the key text from the code; it stays stored in Script Properties.
4. Check: Supabase `select count(*) from pms_fms_pending;` should show your pending FMS steps.
   Make sure the Google account running the bridge has access to all FMS spreadsheets.

## Step 4 — Test
- Log in as a worker (Worker ID + PIN), Start → Pause → Resume → End a task. Within ~1 minute the FMS sheet gets the finish time + worker name.
- Open the app on two devices: change a task on one, the other updates in under a second.

## Daily admin (all in SQL Editor)
| Need | Query |
|---|---|
| New worker joined | add the row to `pms_workers`, then `select * from pms_provision_workers();` |
| Forgot PIN | `select pms_reset_pin('00863');` |
| Lost phone / sign out everywhere | `select pms_sign_out_everywhere('00863');` |
| Worker left | `select pms_set_active('00863', false);` (blocked immediately) |
| Add admin / supervisor | `select pms_create_staff('a@b.com','Strong#Pass1','ADMIN','Admin');` (`'PRODUCTION_MANAGER'` for supervisors) |

## Notes
- Reports always cover the **whole history**; nothing is ever deleted. Dashboard / My Tasks open with open tasks + last 45 days
  (`RECENT_DAYS` in `config.js`) and automatically load the full history when you search an older order or pick an older date.
- FMS write-back and new FMS rows appear within about 1 and 5 minutes respectively (bridge timers).
