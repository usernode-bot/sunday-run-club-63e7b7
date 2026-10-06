# Sunday Run Club

A run tracker for a running club: one week board shows everyone's miles
for the current week side by side, so you can see who's keeping up and
who's slipping.

- **The week board** — the current week (Monday to Sunday) at the top:
  every runner in the club with their miles and a strip showing their
  progress against their own weekly goal, plus the three previous weeks
  in a grid below.
- **Log a run** — distance in miles, an optional note, and the date
  (pre-filled with today; a Sunday run can be logged on Monday). Runs
  are logged for yourself only.
- **Weekly goal** — each runner picks their own weekly mile goal and
  saves it in the same card; the strip fills toward it as the week goes
  on, and past weeks are not rewritten.
- **Sign-in** — the server verifies the platform-issued user token (an
  RS256 JWT) on every request, so the app knows who is using it, with no
  accounts to build. Guests can look at the board but not log runs.
- **Styling** — Tailwind CSS, precompiled by `npm run build` during
  image creation with either Kubernetes/Paketo or standalone Docker, in
  a light and a dark look that follow the viewer's Homeroom theme.

Weeks run Monday to Sunday and are computed in UTC; totals reset each
week. The club's roster comes from the platform's members API, so the
board shows the project's members even before they log anything.

## Changing the app

Ask Homeroom bot: open the app on Homeroom, tap the Homeroom icon in the
header, then **Suggest an improvement**, and describe what you'd like in
plain English. You can also run Claude Code against this repo directly;
start with `CLAUDE.md`, which carries the app-specific notes and points
at the platform rules.