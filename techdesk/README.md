# TechDesk: multi-organisation IT helpdesk (SaaS) by Orbitra Technologies

Any organisation can subscribe. Its admin registers with a work email, invites employees by work email, and the ICT team
(technicians and admins) views and works the tickets. Data of each organisation is isolated. Node.js + Express + TypeScript
API, PostgreSQL, React + Vite web app. One server serves both the API and the built web app.

## What is included
- **Organisations and people:** self-registration with work email (gmail/yahoo etc. refused), 14-day free trial, invitations by email restricted to the
  organisation's email domain, accept-invite, forgot/reset password, roles admin / technician / requester. Org admins change roles, disable users, email a reset link
  or set a temporary password (the person must choose their own at next sign-in). The platform admin (you) does the same for each organisation's admins.
- **Stay signed in:** a long-lived session (httpOnly cookie, 180 days sliding) renews a 15-minute access token automatically. Users sign in once and stay signed in until
  they tap Sign out, change/reset their password, or are disabled.
- **Tickets:** title, description, category, priority, **department and room/desk**, optional affected equipment, and **photos taken or chosen on the phone** (large photos are shrunk
  before upload), filter, assign, status, priority, public replies, internal notes (hidden from requesters), attachments with thumbnails, audit log.
- **Ticket tracking:** a stage tracker (Submitted, Assigned, In progress, Resolved, Closed) and a time-stamped progress history that the requester can see.
- **Deadlines:** SLA targets per priority (editable by the admin in Analytics). The system records tickets with **no action by the response deadline** and tickets **unresolved at the resolution
  deadline**, credited to whoever was assigned at that moment (reassigning does not hide it), and emails the assignee or the ICT team.
- **Analytics for org admins (7 days, 30 days, 90 days, 12 months):** tickets raised vs resolved chart, average first-response and resolution time, % answered and resolved in time, breakdowns by
  department/location, category, priority and status, equipment with most tickets, per-staff table with missed deadlines, overdue list, plain-language observations, CSV download.
- **Email notifications:** new ticket, assignment, status change, replies both ways, missed deadlines, invitations, password reset.
- **Assets, knowledge base, subscriptions and M-Pesa billing, platform console** (as before).
- **Phone friendly and installable:** responsive layout (ticket lists become cards on phones), Install button, installable web app (PWA). It installs from the browser to the home screen; there is no APK or app-store app.

## Not built yet (do not describe as available)
Native Android/iOS store apps, SSO and MFA, business-hours SLA calendars, ticket merge/approvals/service catalogue, asset maintenance history and QR codes, email verification of the registering
admin, invoices/receipts PDF, automatic recurring M-Pesa charges, virus scanning of uploads, scheduled weekly email digests, push notifications.

## Requirements
Node.js 20+, npm, a PostgreSQL database (free option: https://neon.tech), an SMTP account for email, a Safaricom Daraja app for M-Pesa.

## Run on your computer
1. Create a PostgreSQL database and copy its connection string (Neon: keep `?sslmode=require`).
2. API, from the `techdesk` folder:
   ```
   cd server
   npm install
   cp .env.example .env        # Windows: copy .env.example .env
   ```
   Fill `DATABASE_URL` and `JWT_SECRET` (generate: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`).
   For local testing set `ALLOW_FREE_EMAIL=true` if you register with a Gmail address. Then `npm run dev`. Tables are created automatically.
3. Web app, new terminal, from the `techdesk` folder: `cd web && npm install && npm run dev`, open http://localhost:5173.
4. Create your own platform-admin login (Orbitra staff who see all customers): `cd server && npm run platform-admin -- you@yourdomain.co.ke 'a-long-password'`.
   Sign in with it and open the **Platform** tab.

## Email (SMTP)
Set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` and `APP_URL` in `server/.env` (any SMTP provider works). Without `SMTP_HOST`
nothing is emailed (messages are only logged), so invitations and reset links will not arrive. Use a sending domain you control and set up its SPF/DKIM records so mail is not marked as spam.

## M-Pesa (Daraja)
1. Create an app at https://developer.safaricom.co.ke, get the consumer key/secret, shortcode and Lipa Na M-Pesa passkey. Start with `MPESA_ENV=sandbox`.
2. Put them in `server/.env`, plus `MPESA_CALLBACK_SECRET` (any long random string) and `APP_URL` = your public **https** address (Safaricom must reach `APP_URL/api/mpesa/callback/<secret>`; localhost will not work, use your Render URL).
3. Go live later with `MPESA_ENV=production` and your production credentials after Safaricom approval.

## Plans and prices
Seeded in the database: Starter (3 ICT agents), Business (10), Enterprise (30). **The KSh prices are placeholders, not market-validated.**
Change them any time, no code needed: `PATCH /api/platform/plans/<code>` with `{"price_month": 5000}` as platform admin (or edit the `plans` table).
Employees (requesters) are never charged per ticket or per person.

## Run the tests (no database setup needed)
`cd server && npm install && npm test`. This starts a temporary PostgreSQL by itself (it cannot run as Linux root).

## Deploy on Render (single web service)
1. Push the folder to GitHub (`.env` is git-ignored).
2. Render > New > Web Service. Build command: `cd web && npm install && npm run build && cd ../server && npm install && npm run build`. Start command: `cd server && npm start`.
3. Environment variables: everything in `server/.env.example`, plus `NODE_VERSION=20`. Set `APP_URL` to the Render URL.
4. Attachments need a persistent disk (paid instance); set `UPLOAD_DIR` to its mount path. On the free tier uploaded files are lost on redeploy.
5. Run `npm run platform-admin -- ...` once from the Render shell to create your admin login.
6. Run a single instance: the SLA sweep runs inside the server process.

## API summary (under /api, JSON, header `Authorization: Bearer <token>`)
| Method and path | Who | Purpose |
|---|---|---|
| GET /plans | public | Plans and prices |
| POST /auth/register, /login, /forgot, /reset, /accept-invite | public | Account flows |
| POST /mpesa/callback/:secret | Safaricom | Payment result (secret in URL) |
| GET /me | any | Current user + subscription state |
| GET /users; PATCH /users/:id | staff; admin | List; enable/disable/role |
| POST, GET /invites; DELETE /invites/:id | admin | Invite by work email |
| GET, POST /tickets; GET, PATCH /tickets/:id | any (requesters own only); PATCH staff | Tickets |
| POST /tickets/:id/messages, /attachments; GET /attachments/:id | with ticket access | Replies, notes, files |
| GET /dashboard | staff | Counts |
| GET /sla; PUT /sla | staff; admin | SLA targets |
| GET, POST /assets; PATCH /assets/:id | any (requesters: theirs); staff | Asset register |
| GET, POST /kb; PATCH /kb/:id | any (published only); staff | Knowledge base |
| GET /billing; POST /billing/checkout; GET /billing/payments/:id | admin | Subscription and M-Pesa |
| GET /platform/orgs; POST /platform/orgs/:id/payments; PATCH /platform/plans/:code | platform admin | Operate the SaaS |
| POST /auth/refresh, /auth/logout | session cookie | Stay signed in; sign out |
| POST /auth/change-password | any | Change own password |
| POST /users/:id/password, /users/:id/reset-link | admin | Temporary password or reset link for a colleague |
| GET /analytics?days=7/30/90/365; GET /analytics/export.csv | admin | Analytics and CSV download |
| GET /platform/orgs/:id/admins; POST /platform/users/:id/password, /reset-link | platform admin | Manage organisation admins' passwords |
| GET /audit | admin | Last 100 audit events |
Errors: `{ "error": "message", "details": [...] }` with 400, 401, 402 (plan limit or expired subscription), 403, 404, 409, 500, 502.

## Verification status
**Verified (automated, real PostgreSQL 18, 24 tests passing):** everything in the previous version plus: stay-signed-in sessions (refresh, logout, revocation on password change),
change-own-password, admin and platform-admin password management (temporary password forces a change and blocks the API until done, reset links, cross-organisation protection),
role assignment, ticket location, stage history visible to requesters (internal breach events hidden), no-response and unresolved-deadline detection credited to the right staff even after reassignment,
analytics figures and chart data, CSV export with spreadsheet-formula protection, admin-only access. TypeScript builds pass for server and web; the zip was installed, built and tested from a clean folder.

**Untested, check these yourself:**
1. *Click through every screen on a real phone* (Android Chrome and iPhone Safari): ticket form with camera photos, list cards, stage tracker, analytics charts, users, billing.
2. *Install:* Android "Install app", iPhone Share > Add to Home Screen; confirm the icon and that you stay signed in after closing and reopening. Needs the deployed https address (not localhost over http on a phone).
3. *Photo upload from a phone camera:* iPhone HEIC photos are usually converted by the browser; if one is rejected, the ticket is still created and the message tells the user.
4. *Stay signed in over https:* the session cookie is marked Secure automatically on https; verify on Render that closing the browser and returning does not ask for a login.
5. Real email delivery, M-Pesa sandbox, Render/Neon deployment (see earlier sections).

**Known limits:** logo icons are cropped from your brand board (low resolution; replace the files in `web/public` with proper exports); analytics dates use Nairobi time; the stay-signed-in cookie is not rotated on each use
(it is revoked on logout/password change/disable); a stolen phone stays signed in until the user or an admin changes the password; login attempts are limited per IP (30 per 15 minutes), so a large office behind one
address could hit it during a mass sign-in; earlier limits (unverified registering admin, unsigned M-Pesa callbacks, upload type by declared type, priority change does not recompute deadlines) still apply.
