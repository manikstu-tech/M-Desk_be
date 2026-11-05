# fe page → be read API map

Every fe page that used to read the database directly now has a GET endpoint here.
All endpoints need the `mdesk_session` cookie and apply the same access rule the page did.
Responses use the usual `{ "data": ... }` / `{ "error": ... }` shape.

When fe calls these, pass the page's search params straight through as the query string.

## App shell

| fe page / layout | API |
|---|---|
| `(shell)/layout.tsx` (top bar, sidebar) | `GET /api/shell` |
| `login`, session checks | `GET /api/auth/session` (existing) |

## HR & Administration

| fe page | API |
|---|---|
| `hr-administration` (dashboard) | `GET /api/hr/dashboard?departmentId&location&managerId&month&week` |
| `hr-administration/analytics/*` | `GET /api/hr/analytics` (tab figures stay in `lib/hr-analytics-sample.ts`) |
| `hr-administration/employees` | `GET /api/hr/employees?q&type&stage&departmentId&location&view&page&size` |
| `hr-administration/employees/[id]` | `GET /api/hr/employees/:id` |
| `employees/[id]/kras/assign`, `kras/review`, `kras/yearly` | `GET /api/hr/employees/:id/summary` |
| `employees/[id]/promote` | `GET /api/hr/employees/:id/summary?lookups=1` |
| `employees/new` | `GET /api/hr/employees/new` |
| `employees/new/[id]` (wizard) | `GET /api/hr/employees/:id/wizard` |
| `hr-administration/onboarding` | `GET /api/hr/onboarding` |
| `hr-administration/letters` | `GET /api/hr/letters?status&type&q&category&verification&empType` |
| `hr-administration/attendance-leave` | `GET /api/hr/attendance-leave?month=YYYY-MM` |
| `hr-administration/holidays` | `GET /api/hr/holidays?month=YYYY-MM` |
| `hr-administration/policies` | `GET /api/hr/company-policies` |
| `hr-administration/reports` | `GET /api/hr/reports?report&from&to&employmentType&departmentId` |
| `hr-administration/settings` | `GET /api/hr/settings?page` |
| `my-hr` | `GET /api/hr/me` |
| `hr-administration` layout, `training`, `kras-performance/*`, `policies-compliance/*` | no data; access only (`/api/hr/analytics` or `/api/auth/session`) |

## Technology & MIS and IT portal

| fe page | API |
|---|---|
| `technology-mis` layout, overview, `workflows` | `GET /api/tech/access` |
| `technology-mis/boards` | `GET /api/tech/items?status=open&...` (existing) |
| `technology-mis/changes` | `GET /api/tech/changes` |
| `technology-mis/command-centre`, `reports` | `GET /api/tech/command-centre` |
| `technology-mis/documents` | `GET /api/tech/documents?q&category&scope` |
| `technology-mis/mis` | `GET /api/tech/mis` |
| `technology-mis/queue` | `GET /api/tech/queue` |
| `technology-mis/security` | `GET /api/tech/security` |
| `technology-mis/settings` | `GET /api/tech/settings` |
| `technology-mis/assets` | `GET /api/tech/assets` (existing) + `GET /api/tech/people` |
| `technology-mis/licences` | `GET /api/tech/licences` (existing) + `GET /api/tech/people` |
| `technology-mis/items/[key]` | `GET /api/tech/items/:key/detail` |
| `it` | `GET /api/it` |
| `it/[key]` | `GET /api/it/:key` (internal comments removed server side) |

## Core

| fe page | API |
|---|---|
| `dashboard` | `GET /api/dashboard` |
| `my` (My Desk) | `GET /api/my` |
| `documents` | `GET /api/documents?q&status&departmentId` |
| `documents/[id]` | `GET /api/documents/:id/detail` |
| `exceptions` | `GET /api/exceptions` |
| `audit` | `GET /api/audit` (Super Admin) |
| `reports` (Command Centre) | `GET /api/command-centre?dept&period` (KPI sections the viewer may not see come back `null`) |
| `users` | `GET /api/users` |
| `policies/[id]` | `GET /api/policies/:id` |
| `notifications` | `GET /api/notifications` (existing) |
| `workflows` | `GET /api/workflows/desk` |
| `departments/finance-accounts/*` | `GET /api/finance/page?project&period` |

## Changes from what the pages did

These endpoints return less than the old page queries in a few places, because a page
kept data on the server while an API sends it to the browser:

- Employee list, onboarding, attendance: only list fields, never Aadhaar / PAN / bank / pay.
- Employee detail: identity and account numbers masked unless the viewer holds HR APPROVE.
- Document detail, audit: people come back as `{ id, name, email }`, not full user rows.
- Users: password and auth fields never selected.
- IT portal item: internal comments filtered out on the server.
- Command Centre: aggregates only, and only for KPIs the viewer's tier may see.
