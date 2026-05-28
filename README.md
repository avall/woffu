# woffu-auto-complete-day

GitHub Action that fills your daily presence proof (*comprobante de presencia*) in
[Woffu](https://app.woffu.com) every weekday at **22:00 Europe/Madrid**.

It detects holidays, weekends, absences and pre-existing fichajes/slots, and
only writes when the day is genuinely empty.

## What it does.

Every Monday-Friday at 22:00 Madrid time the workflow:

1. Authenticates against Woffu with email/password (replicating the standard
   browser login flow).
2. Reads today's diary summary to confirm the day is a working day (not weekend,
   holiday, absence event, etc.).
3. Aborts if the day already has worked hours or pending slots, so it never
   overwrites manual entries.
4. Generates randomized time slots that respect the configured ranges and total
   contractual hours:

   | Day      | Slots | Total |
   |----------|-------|-------|
   | Mon-Thu  | 2 (morning + afternoon with lunch break) | exactly 8h |
   | Fri      | 1 (single block) | exactly 6h |

5. Sends a `PUT` to
   `/api/svc/core/users/{userId}/diarysummaries/workday/slots/self` with the
   generated slots — same operation the Woffu UI performs when you fill the day
   manually.

### Slot ranges

- **Mon-Thu**
  - entry: 08:30-09:00
  - lunch-out: 13:00-14:00
  - lunch-in: 14:30-15:00
  - end: 18:30-19:00
- **Fri**
  - entry: 08:00-09:00
  - exit: entry + 6h (resulting in 14:00-15:00)

> The Mon-Thu entry window is 08:30-09:00 (not 08:00-09:00) because that is the
> only sub-range mathematically compatible with the four range constraints plus
> an exact 8h daily total. Relax the totals in
> `.github/scripts/woffu-complete-day.mjs` if you prefer 08:00 entries.

## Setup

Configure these repository secrets (*Settings → Secrets and variables →
Actions*):

| Secret | Required | Description |
|---|---|---|
| `WOFFU_URL` | yes | Main Woffu URL, e.g. `https://app.woffu.com/api` |
| `WOFFU_COMPANY_URL` | yes | Company-scoped URL, e.g. `https://yourco.woffu.com` |
| `WOFFU_EMAIL` | yes | Woffu login email |
| `WOFFU_PASSWORD` | yes | Woffu password |
| `TELEGRAM_BOT_TOKEN` | no | For failure notifications |
| `TELEGRAM_CHAT_ID` | no | For failure notifications |

## Manual run

Actions → *Auto Complete Day* → **Run workflow**. Tick `dry-run` to authenticate
and print the slots that would be sent without performing the `PUT`.

## Files

- `.github/workflows/auto-complete-day.yml` — cron + manual trigger, Madrid-time
  guard, env wiring.
- `.github/scripts/woffu-complete-day.mjs` — Node.js script (no dependencies)
  with the auth flow, working-day detection, slot generation and `PUT` call.

## License

MIT — see [LICENSE](LICENSE).
