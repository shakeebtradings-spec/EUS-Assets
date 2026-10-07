# EUS Assets – store & asset management

Free, live, multi-store asset check-in/check-out for 5,000+ assets. Runs in any browser
(phone, tablet, desktop) and installs as an app (PWA). **No build step, no paid services.**

- **Live data**: every change appears on every device instantly (Supabase Realtime).
- **Username + password** accounts, no email, no confirmation. First account created = admin.
- **Back-camera barcode scanner** (QR, Code 128/39, EAN/UPC, etc.) + manual / USB-scanner entry.
- **Multiple stores**, per-store views, check-in returns an item to the selected store.
- **Audit trail**: who took/returned what, where, and when. **User directory** with items held.
- Admin: add/edit assets, print barcode labels, CSV import/export (thousands of rows), manage stores & users.

## Setup (~10 minutes, all free)

1. Create a free project at <https://supabase.com>.
2. **SQL Editor** → paste and run `supabase/schema.sql`.
3. Email confirmation is already bypassed by a database trigger in the schema. (Optionally also turn off **Authentication → Providers → Email → Confirm email**.)
4. **Project Settings → API**: copy the Project URL and `anon` key into `web/config.js`.
5. Host the `web/` folder (any static host over HTTPS – required for camera access):
   - GitHub Pages: repo **Settings → Pages → Source: GitHub Actions**, merge to `main` (workflow included), or
   - Netlify / Cloudflare Pages: publish directory `web`.
6. Open the site, **Create account** – the first account becomes admin. Add stores under *Admin*, then import assets via CSV (`tag,name,category,store`).

## How it works
Usernames are mapped to a placeholder address (`user@eus-assets.app`) so Supabase Auth can be used without any real email.
All permissions are enforced in the database (row-level security): staff can scan and read; only admins edit assets/stores/users.
Check-in/out goes through one atomic `scan_asset()` function so two people can never take the same item.

Limits to know: Supabase free tier pauses a project after 7 days of *no* activity and has 500 MB storage – ample for 5,000+ assets and years of scans.
Passwords cannot be reset by email; an admin can disable an account, and you can reset passwords in the Supabase dashboard (Authentication → Users).

---

# EUS Workstations – live workstation board (`web/workstations/`)

Live dashboard for the 4 workstations: who is on each one, their **case number** (required) and **description** (optional),
plus **date/time reservations**. Same accounts, Supabase project and hosting as EUS Assets; open it at `<site>/workstations/`.

- **Live board**: one card per workstation (Available / In use / Reserved / KVM in use), elapsed time, next bookings. Updates instantly on every device; works on phone, tablet, desktop and TV.
- **KVM rule**: workstations **2 and 3 share one KVM switch (3× HDMI)**, so only one of them can be in use or reserved at any time – the other shows "KVM in use". WS 1 and 4 are independent. (Change this under *Admin → Workstations → KVM group*.)
- **Reserve**: pick workstation, date, from/until (or tap a row on the day timeline). Overlaps – including through the shared KVM – are rejected by the database.
- **Roles** (set by an admin): *No access* (new sign-ups start here) · *Viewer* (watch) · *User* (start work, reserve, edit/cancel own) · *Admin* (everything: roles, rename/disable workstations, release or cancel anyone's). The EUS Assets admin is always a workstation admin.
- **Wall display**: `?tv` (or the *Display mode* button) gives a big-text, fullscreen, screen-awake board. Admins can optionally allow a read-only **no-login** display (*Admin → Wall display*).
- **History** with search and CSV export (admin).

Setup: run `supabase/workstations.sql` in the SQL Editor (after `schema.sql`). No other config – it reuses `web/config.js`.
