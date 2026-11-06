// Technology & MIS design copy (Manikstu_Technology_MIS_All_Sections): the Overview table, the
// "Major data in this section" table on every page, and sample figures for the few panels that have
// no live source yet (monitoring, backups, field sync). Every sample panel is labelled on the page.

export type MajorRow = { data: string; holds: string; from: string; who: string };

export const OVERVIEW_SECTIONS: { page: string; purpose: string; holds: string; users: string }[] = [
  { page: "Command Centre", purpose: "See at once what is broken and what needs action", holds: "Health figures, system checks, backups, renewals, data quality score", users: "Technology, Management" },
  { page: "My Queue", purpose: "Everything waiting for one person in one list", holds: "Tickets assigned, approvals waiting, tasks, watched items", users: "Everyone in the section" },
  { page: "Service Desk", purpose: "Requests and faults from the office and the sheds", holds: "Tickets, kinds of request, time limits, links to shed and device", users: "Everyone can raise, Technology works" },
  { page: "Boards", purpose: "Track technology work as cards on a board", holds: "Work items, projects, owners, due dates, status", users: "Technology, Management" },
  { page: "Backlog", purpose: "Rank what to build or fix next", holds: "Requests, who asked, value, effort, release plan", users: "Technology, Management" },
  { page: "Changes", purpose: "Plan and approve anything that alters live systems", holds: "Change requests, risk, approvals, rollback plans, release dates", users: "Technology, Management" },
  { page: "MIS & Data", purpose: "Know what data exists and whether it can be trusted", holds: "Datasets, record counts, owners, freshness, quality checks, meanings", users: "MIS, Management" },
  { page: "Security", purpose: "Who can do what, and proof it is still right", holds: "People by role, access requests, sign-ins, leaver checklist, audit log", users: "Technology, Admin, Management" },
  { page: "Assets", purpose: "Know every device and who has it", holds: "Phones, tablets, laptops, cameras, routers, assignments, warranty", users: "Technology, Operations" },
  { page: "Licences", purpose: "Never miss a renewal or pay for unused seats", holds: "Subscriptions, seats, yearly cost, renewal dates, owners", users: "Technology, Admin, Finance" },
  { page: "Documents", purpose: "One library for runbooks, policies and contracts", holds: "Files, versions, review dates, who may read them", users: "By folder" },
  { page: "Workflows", purpose: "The approval routes for technology requests", holds: "Route steps, running requests, time taken per step", users: "Technology, Management" },
  { page: "Reports", purpose: "Send the right numbers to the right people", holds: "Report definitions, schedules, recipients, run history", users: "Management, MIS" },
  { page: "Settings", purpose: "Rules the section runs on", holds: "Priorities, time limits, categories, hours, notifications, connections", users: "Admin, Management" },
];

export const CONNECT_FLOW = [
  "A shed camera goes offline",
  "Service Desk ticket",
  "Assets shows the camera and installer",
  "Boards or Backlog holds the fix",
  "Changes approves the release",
  "Command Centre shows it solved",
];

const r = (data: string, holds: string, from: string, who: string): MajorRow => ({ data, holds, from, who });

export const MAJOR_DATA: Record<string, MajorRow[]> = {
  "Command Centre": [
    r("Health figures", "Counts and rates, such as tickets fixed within target", "Service Desk and system checks", "Technology, Management"),
    r("System checks", "Up, slow or down for 7 systems, every 5 minutes", "Monitoring", "Technology"),
    r("Backup log", "Each backup and each restore test, with result", "Database", "Technology"),
    r("Field snapshot", "Cameras online, phones synced, entries waiting", "Assets and offline sync", "Technology, Operations"),
    r("Data quality score", "Share of checked records that pass", "MIS & Data", "Technology, MIS, Management"),
  ],
  "My Queue": [
    r("Assigned items", "Tickets and tasks owned by this person", "Service Desk, Boards", "The person and their manager"),
    r("Approvals waiting", "Requests that need this person to say yes or no", "Workflows", "The person"),
    r("Time limits", "How long is left on each item", "Settings (time limits)", "The person"),
    r("Watched items", "Items followed for updates", "Chosen by the person", "The person"),
    r("Mentions and notes", "Messages that name this person", "Ticket and card notes", "The person"),
  ],
  "Service Desk": [
    r("Tickets", "Title, details, priority, status, owner, notes, history", "Raised by any user or by a system check", "Requester, Technology, Management"),
    r("Kinds of request", "Camera and light, field phone, login, access, reports, data correction, new feature", "Settings", "Technology"),
    r("Time limits", "Target time for each priority and the time left", "Settings", "Technology, Management"),
    r("Links", "Shed, work order, device, installer, related tickets", "Operations and Assets records", "Technology"),
    r("Answers library", "Short guides for common problems, such as a new phone login", "Documents", "Everyone"),
  ],
  Boards: [
    r("Work cards", "Title, notes, owner, due date, priority, status, comments", "Created by the team, or from a Service Desk ticket or Backlog item", "Technology, Management"),
    r("Projects", "Field app, camera monitoring, WhatsApp, reports, security", "Technology", "Technology, Management"),
    r("Columns and limits", "To do, in progress, in review, done, and how many may be in progress", "Settings", "Technology"),
    r("Links", "Ticket, backlog item, change request behind each card", "Service Desk, Backlog, Changes", "Technology"),
    r("History", "When a card moved and who moved it", "Automatic", "Technology"),
  ],
  Backlog: [
    r("Backlog items", "Request, why it matters, who asked, source, value, effort", "Tickets, field feedback, Management requests", "Technology, Management"),
    r("Ranking", "The agreed order and the date it was last changed", "Technology and Management", "Technology, Management"),
    r("Release plan", "Which items go in which release and the date", "Changes", "Technology, Management"),
    r("Links", "Tickets, cards and changes made from an item", "Service Desk, Boards, Changes", "Technology"),
    r("Decisions", "Why something was postponed or refused", "Management", "Technology, Management"),
  ],
  Changes: [
    r("Change requests", "What, why, who is affected, risk, test result, time of release", "Technology", "Technology, Management"),
    r("Approvals", "Who approved, when, and any note", "Workflows", "Technology, Management"),
    r("Rollback plans", "How to go back, and how long it takes", "Technology", "Technology"),
    r("Release notes", "What changed, in plain words, for the people who use it", "Technology", "Everyone"),
    r("Freeze periods", "Dates when only urgent changes are allowed, such as month-end close", "Settings and Finance close status", "Technology, Finance, Management"),
  ],
  "MIS & Data": [
    r("Dataset list", "Name, owner, size, last update, quality", "Every module", "MIS, Management"),
    r("Data dictionary", "Each field, its meaning and who may fill it", "MIS", "Everyone in the section"),
    r("Quality checks", "The rules, nightly result and the records that fail", "MIS", "MIS, record owners"),
    r("Number meanings", "One agreed meaning for each figure used in reports", "Management", "Everyone"),
    r("Data corrections", "Fixes made to records, who asked and who approved", "Workflows", "MIS, Management"),
  ],
  Security: [
    r("People and roles", "Who they are, role, two-step status, last sign-in", "Admin", "Admin, Management"),
    r("Access requests", "Who asked, for what, who approved, when", "Workflows", "Admin, Management"),
    r("Sign-in log", "Successful and failed sign-ins, locked accounts, new phones", "Operations app", "Technology, Admin"),
    r("Leaver checklists", "Steps to remove access when someone leaves", "HR and Admin", "Admin, HR"),
    r("Audit log", "Every change to roles, money figures, exports and devices", "Automatic", "Management, Admin"),
  ],
  Assets: [
    r("Device records", "Type, make, serial number, purchase date, warranty", "Technology, Procurement", "Technology, Operations"),
    r("Assignments", "Who or which shed has the device, since when", "Handover forms", "Technology, Operations"),
    r("Repair history", "Faults, repairs, parts, cost", "Service Desk", "Technology"),
    r("SIM and router details", "Numbers and plans for shed connections", "Technology", "Technology"),
    r("Handover and return forms", "Signed forms with condition and photos", "Documents", "Technology, Admin"),
  ],
  Licences: [
    r("Licence records", "Item, vendor, plan, owner, contract file", "Technology, Admin", "Technology, Admin, Finance"),
    r("Seats and balance", "Seats bought, seats used, credits left", "Vendor and Security", "Technology"),
    r("Cost", "Yearly cost and the bills paid for it", "Finance & Accounts", "Finance, Management"),
    r("Renewal dates", "Next date, reminder, auto-renew or not", "Technology", "Technology, Admin"),
    r("Contracts", "Signed agreements and vendor contacts", "Documents", "Technology, Admin, Management"),
  ],
  Documents: [
    r("Files", "The file, its type, size and who uploaded it", "Uploads and Documents module", "By folder"),
    r("Versions", "Every earlier version, kept and readable", "Automatic", "Owner, Management"),
    r("Review dates", "When each file must be checked again", "Owner", "Technology"),
    r("Links", "Which ticket, device or licence a file belongs to", "Service Desk, Assets, Licences", "Technology"),
    r("Access levels", "Everyone, Technology only, or Management only", "Settings", "Admin"),
  ],
  Workflows: [
    r("Route definitions", "The steps, who does each step, and the rules", "Settings and Management", "Admin, Management"),
    r("Running requests", "Each request, its current step and how long it has waited", "Workflows", "People in the route"),
    r("Step history", "Who did each step, when, and any reason given", "Automatic", "Management, Admin"),
    r("Time per step", "Average and longest wait at each step", "Automatic", "Technology, Management"),
    r("Links", "The ticket, change or device a request belongs to", "Service Desk, Changes, Assets", "Technology"),
  ],
  Reports: [
    r("Report definitions", "Name, purpose, the figures it uses and who owns it", "MIS", "MIS, Management"),
    r("Schedules", "When each report runs and who receives it", "MIS", "MIS"),
    r("Run history", "Each run, its date, result and the file made", "Automatic", "MIS, Management"),
    r("Recipients", "People and roles who receive each report", "Settings", "MIS"),
    r("Export log", "Who downloaded what, and when", "Automatic", "Management, Admin"),
  ],
  Settings: [
    r("Priorities and time limits", "The four priorities and their targets", "Management", "Admin, Management"),
    r("Request kinds", "Kinds of request, owners and approval rules", "Technology", "Admin, Technology"),
    r("Notification rules", "Who is told, when and by which channel", "Technology", "Admin, Technology"),
    r("Connections", "WhatsApp, bank import, camera cloud, email and their status", "Technology", "Admin, Technology"),
    r("Hours, holidays and keeping rules", "Working time, holidays, how long data is kept", "Admin", "Admin, Management"),
    r("Settings history", "Every change with who, when and the old value", "Automatic", "Admin, Management"),
  ],
};

// ── Sample panels: no live source until monitoring (T6) and the field-sync feed exist ──

export type SampleStatus = "Up" | "Slow" | "Down";

export const SAMPLE_SYSTEMS: { name: string; note: string; status: SampleStatus }[] = [
  { name: "Operations app and API", note: "Answers in under a second", status: "Up" },
  { name: "Database and daily backup", note: "Last backup 2 Nov, 11:30 pm", status: "Up" },
  { name: "Background jobs", note: "Messages and bank import · 12 waiting", status: "Up" },
  { name: "WhatsApp gateway", note: "Replies take about 40 seconds", status: "Slow" },
  { name: "Offline sync for field phones", note: "6 entries waiting to sync", status: "Up" },
  { name: "Document storage", note: "Plenty of space left", status: "Up" },
  { name: "Camera monitoring", note: "33 of 38 sheds online", status: "Up" },
];

export const SAMPLE_FIELD = [
  { label: "Sheds with camera online", value: "33 of 38", sub: "5 sheds need a look" },
  { label: "Field phones synced today", value: "17 of 18", sub: "1 phone has not synced in 2 days" },
  { label: "Entries waiting to sync", value: "6", sub: "Oldest is 3 hours" },
];
