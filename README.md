# Motorbike Wash Revenue

Web app to record and report revenue of a Cleanzy wash shop (motorbike wash, add-on services, helmet services, food & drinks).

- **Frontend:** static HTML/CSS/JS, hosted on GitHub Pages
- **Backend:** Supabase (Postgres, Auth, Storage, Realtime, Edge Functions)

## Project structure

```
.github/workflows/deploy.yml   Deploys to GitHub Pages and generates assets/config.js
assets/
  config.js                    Supabase URL + anon key (local only, gitignored)
  config_example.js            Template for config.js
  css/styles.css
  js/
    supabaseClient.js          Shared Supabase client (`sb`) + live-update helper (`RealtimeSync`)
    auth.js                    Session check, page guard, sign out
    password-toggle.js         Show/hide password button
    sidebar.js                 Shared collapsible sidebar, menu and page access (NAV list)
  partials/sidebar.html
index.html                     Login page
pages/home.html           Landing page after login
supabase/
  schema/01_users.sql ... 08_reports.sql
  functions/
    create-user/               Edge Function: create a user
    manage-user/               Edge Function: manage existing users
    _shared/common.ts          Code shared by the functions
```

## 1. Set up Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and run the files in `supabase/schema/` **in order**: `01` → `08`. Each file is safe to re-run, except the seed notes inside them (do not re-run seeds after editing data in the app).
3. Create the Super Admin (one time):
   1. **Authentication → Users → Add user** (email + password).
   2. Run in SQL Editor (use that email):
      ```sql
      update auth.users
         set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
                                 || '{"role": "super_admin"}'::jsonb
       where email = 'your-superadmin@email.com';
      ```
   Do not insert the Super Admin into `public.users`.
4. **Authentication → Providers → Email**: turn **off** "Allow new users to sign up". Users are created only by Admin through the `create-user` Edge Function.
5. Deploy the Edge Functions (see section 4).

## 2. Run locally

1. Copy `assets/config_example.js` to `assets/config.js` and fill in **Project URL** and **anon key** (Supabase → Settings → API). Never use the `service_role` key in the frontend.
2. Make sure `.gitignore` contains `assets/config.js`.
3. Serve the folder with any static server and open the URL:
   ```bash
   python -m http.server 8000
   # http://localhost:8000
   ```

## 3. Deploy the website (GitHub Pages)

1. Repo → **Settings → Secrets and variables → Actions** → add:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
2. Repo → **Settings → Pages** → **Source: GitHub Actions**.
3. Push to `main`. `deploy.yml` creates `assets/config.js` from the secrets and publishes the site. The run fails with a clear message if a secret is missing.

Edge Functions are **not** deployed by this workflow; deploy them as described below.

## 4. Deploy the Edge Functions

Functions: `create-user`, `manage-user` (shared code in `supabase/functions/_shared/common.ts`).

Both functions only use `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`, which Supabase provides to every function automatically. **No secrets need to be set.** Only Super Admin and Admin can call them (checked inside the function).

### Option A: Supabase CLI (recommended)

Works with the `_shared` folder and keeps code in git.

1. Install the CLI: <https://supabase.com/docs/guides/cli> (for example `npm install -g supabase`, `brew install supabase/tap/supabase`, or Scoop on Windows).
2. From the project root:
   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>   # Project ref: Supabase → Settings → General

   supabase functions deploy create-user
   supabase functions deploy manage-user
   # or deploy everything in supabase/functions at once:
   supabase functions deploy
   ```
   If deployment asks for Docker and you do not have it, add `--use-api`.
3. Keep JWT verification on (the default). Use `--no-verify-jwt` only for functions that must be public.
4. Check: `supabase functions list`.

Re-run the same `deploy` command after every code change.

### Option B: Supabase Dashboard

Good for quick fixes. The Dashboard editor has no versioning or rollback, so keep the code in git as the source of truth.

1. Supabase → **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name the function exactly `create-user` (then repeat for `manage-user`).
3. Paste the contents of `supabase/functions/<name>/index.ts` into the editor.
4. Both functions import `../_shared/common.ts`, which is not available when deploying from the editor. Make each function self-contained: paste the contents of `common.ts` at the top of the editor, then delete the line `import { ... } from "../_shared/common.ts";` from `index.ts`. (Option A avoids this; with Option B, a change to `common.ts` must be pasted into both functions.)
5. Click **Deploy function**, then use the built-in test panel to try it.

### Adding secrets later

If you add a function that needs its own secret: CLI `supabase secrets set NAME=value`, or Dashboard **Edge Functions → Secrets**.

## Adding a page

1. Copy `pages/home.html` and change the `<title>`, `<body data-page="...">`, the heading and the page content. Keep the head snippet, the `app-shell` markup and the script order (Supabase, `config.js`, `supabaseClient.js`, `auth.js`, `sidebar.js`).
2. Add one line to `NAV` in `assets/js/sidebar.js`: `{ page, href, label, icon, perm }`. `perm` is a key from `public.permissions`, or `'admin'` for Admin / Super Admin only; leave it out for everyone signed in. The same line controls the menu link and who may open the page.
3. Run page code inside `window.addEventListener('app:ready', (e) => { ... })`. `e.detail` has `user`, `name`, `role`, `isAdmin` and `perms`.

The sidebar checks the session and permissions on every page, collapses to an icon rail (state remembered), and signs out from its footer. Page access in the browser is only a convenience; Row Level Security in the database is the real protection.

## Roles

| Role | Notes |
|---|---|
| Super Admin | Auth user with `app_metadata.role = 'super_admin'`; not stored in `public.users`; all permissions |
| Admin | All permissions; manages users and role permissions |
| Store Manager, Clerk | Only the permissions Admin grants (`manage_catalog`, `manage_price`, `enter_revenue`, `view_report`, `confirm_revenue`, `backdate_revenue`) |

## Notes

- Only the Supabase **anon** key is used in the browser. Access is enforced by Row Level Security in the database.
- Sales are written only through the `create_sale`, `confirm_sale` and `void_sale` functions. Confirmed sales can never be changed or voided.
- Deactivated users (`is_active = false`) are blocked at login (the `manage-user` function also bans their Auth account).
- A user who has change history (or related records) cannot be deleted; deactivate them instead.
