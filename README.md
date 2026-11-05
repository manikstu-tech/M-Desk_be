# M-DESK Auth Backend

This backend exposes only the V1 login, session, password setup, user invitation, and invitation email flows. The Prisma schema retains the V2 data models and adds the V1 password setup fields and token table, so auth setup does not discard the newer module tables.

## Requirements

- Node.js 20.9 or newer and npm
- PostgreSQL 16, or Docker with Compose
- A Supabase project and SMTP account to send invitation emails

## Local setup

1. Install dependencies with npm ci.
2. Copy .env.example to .env, then configure the database, Supabase keys, and SMTP settings.
3. Start a local database with Docker Compose: docker compose up -d db.
4. Create the schema and local admin: npm run db:setup.
5. Start the auth API: npm run dev.

The API listens on http://localhost:4000. The development seed creates admin@manikstu.local with temporary password ChangeMe!123 and requires a password change. Seeding resets this development account, so use it only with a local development database.

## Auth and mailing endpoints

- POST /api/auth/login — verifies local bcrypt credentials or Supabase Auth and sets a revocable session cookie.
- POST /api/auth/logout — revokes the current session.
- GET /api/auth/session — returns the current signed-in user.
- POST /api/auth/change-password — changes a password or completes an invitation password setup.
- POST /api/users — creates a user and emails a one-time Supabase setup link. Super Admin only.
- POST /api/users/invitation — resends a setup link. Super Admin only.
- PATCH /api/users — enables or disables a user; disabling revokes their sessions.
- GET /api/health — API liveness.
- GET /api/health/ready — database readiness.

Invitation emails use SMTP settings in .env. Supabase Auth creates the single-use link; SMTP delivers it. Set APP_BASE_URL to the frontend origin so links return to its password setup page. Keep Supabase secret and SMTP credentials server-side.

The API enables credentialed browser requests only from FRONTEND_ORIGINS. The unchanged frontend uses same-origin /api URLs, so use a reverse proxy to route those paths to port 4000 if you want to keep the frontend source untouched.

Uploaded secrets and local environment values belong in .env, which is gitignored.

