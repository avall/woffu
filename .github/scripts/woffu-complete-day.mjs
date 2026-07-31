#!/usr/bin/env node
/**
 * Woffu - Auto Complete Day
 *
 * Fills today's presence slots via the Woffu API for non-holiday weekdays.
 * Uses the standard Woffu email/password login flow (same as the browser UI).
 *
 * Schedule generated:
 *   Mon-Thu (8h total):
 *     - Morning slot:   entry 08:30-09:00, exit (lunch) 13:00-14:00
 *     - Afternoon slot: entry 14:30-15:00, exit 18:30-19:00
 *     (Entry is constrained to 08:30+ because the math of the 4 ranges plus
 *      exactly 8h work only admits entry from 08:30 onwards.)
 *
 *   Fri (6h total):
 *     - Single slot: entry 08:00-09:00, exit = entry + 6h
 *
 * Env vars:
 *   WOFFU_URL          Main app URL (e.g. https://app.woffu.com)         required
 *   WOFFU_COMPANY_URL  Company-scoped URL (e.g. https://acme.woffu.com)  required
 *   WOFFU_EMAIL        Login email                                       required
 *   WOFFU_PASSWORD     Login password                                    required
 *
 * Flags:
 *   --dry-run   Authenticate and compute slots, but don't PUT to the API.
 *
 * After filling the slots the day is also confirmed (the "Confirmar" action in
 * the Woffu UI), so no manual step is left.
 */

import { pathToFileURL } from "node:url";

const WOFFU_URL = (process.env.WOFFU_URL || "").replace(/\/+$/, "");
const COMPANY_URL = (process.env.WOFFU_COMPANY_URL || "").replace(/\/+$/, "");
const EMAIL = process.env.WOFFU_EMAIL || "";
const PASSWORD = process.env.WOFFU_PASSWORD || "";
const DRY_RUN = process.argv.includes("--dry-run");

function requireEnv() {
  for (const [name, value] of [
    ["WOFFU_URL", WOFFU_URL],
    ["WOFFU_COMPANY_URL", COMPANY_URL],
    ["WOFFU_EMAIL", EMAIL],
    ["WOFFU_PASSWORD", PASSWORD],
  ]) {
    if (!value) {
      console.error(`ERROR: ${name} must be set`);
      process.exit(1);
    }
  }
}

const BROWSER_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "es,es-ES;q=0.9",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  Cookie: 'user-language="es"; woffu.lang=es',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function minToHHMM(m) {
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/** Returns today in Europe/Madrid as { date: 'YYYY-MM-DD', dow: 1..7 } (1=Mon..7=Sun). */
function getTodayMadrid() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(new Date());

  const get = (type) => parts.find((p) => p.type === type).value;
  const dowMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    dow: dowMap[get("weekday")],
  };
}

// ---------------------------------------------------------------------------
// Auth (4-step Woffu browser-equivalent login flow)
// ---------------------------------------------------------------------------

/**
 * Authenticates against Woffu and returns { token, userId }.
 * Steps:
 *   1) GET  {WOFFU_URL}/svc/accounts/authorization/use-new-login?email=...
 *   2) GET  {WOFFU_URL}/svc/accounts/companies/login-configuration-by-email?email=...
 *   3) POST {WOFFU_URL}/svc/accounts/authorization/token   (form, sets cookies)
 *   4) GET  {COMPANY_URL}/api/svc/accounts/authorization/users/token  (with cookies)
 *   5) GET  {COMPANY_URL}/api/users   (with Bearer)  -> UserId
 */
async function authenticate() {
  const appHeaders = {
    ...BROWSER_HEADERS,
    Origin: WOFFU_URL,
    Referer: WOFFU_URL + "/v2/login",
  };

  // Step 1 - email pre-check
  const step1 = await fetch(
    `${WOFFU_URL}/svc/accounts/authorization/use-new-login?email=${encodeURIComponent(EMAIL)}`,
    { headers: appHeaders }
  );
  if (!step1.ok) {
    throw new Error(`auth step 1 failed: HTTP ${step1.status} ${await step1.text()}`);
  }

  // Step 2 - login configuration
  const step2 = await fetch(
    `${WOFFU_URL}/svc/accounts/companies/login-configuration-by-email?email=${encodeURIComponent(EMAIL)}`,
    { headers: appHeaders }
  );
  if (!step2.ok) {
    throw new Error(`auth step 2 failed: HTTP ${step2.status} ${await step2.text()}`);
  }

  // Step 3 - exchange credentials for cookies
  const form = new URLSearchParams({
    grant_type: "password",
    username: EMAIL,
    password: PASSWORD,
  });
  const step3 = await fetch(`${WOFFU_URL}/svc/accounts/authorization/token`, {
    method: "POST",
    headers: {
      ...appHeaders,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
    redirect: "manual",
  });

  if (step3.status === 400 || step3.status === 401) {
    throw new Error(`auth step 3: wrong credentials (HTTP ${step3.status})`);
  }

  // Collect cookies from Set-Cookie header(s).
  const rawSetCookie = step3.headers.getSetCookie
    ? step3.headers.getSetCookie()
    : [step3.headers.get("set-cookie")].filter(Boolean);
  const cookieKVs = rawSetCookie
    .map((c) => c.split(";")[0])
    .filter(Boolean);
  const cookieHeader = `user-language="es"; woffu.lang=es; ${cookieKVs.join("; ")}`;

  // Step 4 - exchange cookies for bearer token on company URL
  const step4 = await fetch(
    `${COMPANY_URL}/api/svc/accounts/authorization/users/token`,
    {
      headers: {
        ...BROWSER_HEADERS,
        Referer: COMPANY_URL + "/v2",
        Cookie: cookieHeader,
      },
    }
  );
  if (!step4.ok) {
    throw new Error(`auth step 4 failed: HTTP ${step4.status} ${await step4.text()}`);
  }
  const tokenJson = await step4.json();
  const token = tokenJson?.Token || tokenJson?.token || tokenJson?.access_token;
  if (!token) throw new Error("auth step 4: no token in response");

  // Step 5 - resolve user id
  const step5 = await fetch(`${COMPANY_URL}/api/users`, {
    headers: {
      ...BROWSER_HEADERS,
      Referer: COMPANY_URL + "/v2",
      Authorization: `Bearer ${token}`,
    },
  });
  if (!step5.ok) {
    throw new Error(`auth step 5 failed: HTTP ${step5.status} ${await step5.text()}`);
  }
  const user = await step5.json();
  const userId = user?.UserId ?? user?.userId;
  if (!userId) throw new Error("auth step 5: no UserId in response");

  return { token, userId: String(userId) };
}

// ---------------------------------------------------------------------------
// Woffu API (using bearer + company URL)
// ---------------------------------------------------------------------------

function bearerHeaders(token) {
  return {
    ...BROWSER_HEADERS,
    Referer: COMPANY_URL + "/v2",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

/** Fetches the diary entry for `date` (or null if missing). */
async function diarySummary(token, userId, date) {
  const url =
    `${COMPANY_URL}/api/svc/core/diariesquery/users/${userId}` +
    `/diaries/summary/presence?userId=${userId}` +
    `&fromDate=${date}&toDate=${date}` +
    `&pageSize=1&includeHourTypes=true&includeNotHourTypes=true&includeDifference=true`;
  const res = await fetch(url, { headers: bearerHeaders(token) });
  if (!res.ok) {
    throw new Error(`diary summary failed: HTTP ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const diaries = data?.diaries ?? data?.Diaries ?? [];
  return diaries.find((d) => (d?.date ?? d?.Date ?? "").startsWith(date)) || null;
}

/** Extracts the diary summary id from a diary entry, or null if absent. */
function diarySummaryId(diary) {
  const n = parseInt(diary?.diarySummaryId, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Returns the first numeric value inside a Woffu `*Formatted` block (hours). */
function formattedHours(block) {
  const v = block?.values?.[0];
  if (v === undefined || v === null) return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/** Working day check based on real field names returned by Woffu. */
function isWorkingDay(today) {
  if (!today) return { working: false, reason: "no diary entry" };
  if (today.isWeekend) return { working: false, reason: "weekend" };
  if (today.isHoliday) return { working: false, reason: "holiday" };
  if (today.isEvent) return { working: false, reason: "calendar event" };
  if (today?.calendarEvents?.isHoliday) return { working: false, reason: "calendar holiday" };
  if (today?.calendarEvents?.isEvent) return { working: false, reason: "calendar event" };
  const absences = today.absenceEvents;
  if (Array.isArray(absences) && absences.length > 0) {
    return { working: false, reason: "absence event" };
  }
  const pendingAbsences = today.pendingAbsenceEvents;
  if (Array.isArray(pendingAbsences) && pendingAbsences.length > 0) {
    return { working: false, reason: "pending absence event" };
  }
  const expectedH = formattedHours(today.workingTimeFormatted) || formattedHours(today.scheduleTimeFormatted);
  if (expectedH <= 0) return { working: false, reason: "no expected hours scheduled" };
  return { working: true, expectedHours: expectedH };
}

/**
 * Returns a reason string if the day is already closed for writing, else null.
 *
 * `accepted === true` marks a day the user already confirmed. Woffu then flips
 * `isUserEditable` to false, so both the slots PUT and a second confirm would be
 * rejected (or silently overwrite a confirmed day). Note that a confirmed day
 * can still report 0 worked hours and `in`/`out` equal to the schedule
 * placeholders, so this check cannot be folded into `existingWorkReason`.
 */
function closedReason(today) {
  if (!today) return null;
  if (today.accepted === true) return "day already confirmed (accepted=true)";
  if (today.isUserEditable === false) return "day is not user-editable";
  return null;
}

/**
 * Returns a reason string if the day already has work or pending slots, else null.
 *
 * Woffu diary semantics:
 *   - `workedTimeFormatted` > 0 means actual signs counted as worked time.
 *   - `presenceEvents` / `pendingPresenceEvents` carry real or pending sign data.
 *   - On an untouched day `in`/`out` mirror the schedule placeholders
 *     `maxStartTime` / `minEndTime`. After a `slots/self` PUT they reflect the
 *     first slot's in and the last slot's out, so a divergence from the
 *     schedule defaults signals the day was already filled. This is a heuristic,
 *     not a guarantee: a day whose slots happen to match the placeholders exactly
 *     looks untouched here, which is why `closedReason` is checked as well.
 */
function existingWorkReason(today) {
  if (!today) return null;
  const worked = formattedHours(today.workedTimeFormatted);
  if (worked > 0) return `workedTimeFormatted=${worked}h`;
  const pe = today.presenceEvents;
  if (Array.isArray(pe) && pe.length > 0) return `presenceEvents=${pe.length}`;
  const ppe = today.pendingPresenceEvents;
  if (Array.isArray(ppe) && ppe.length > 0) return `pendingPresenceEvents=${ppe.length}`;
  // Detect pending user-edited slots: in/out diverged from schedule defaults.
  const inT = today.in, outT = today.out;
  const inDefault = today.maxStartTime, outDefault = today.minEndTime;
  if (inT && outT && inDefault && outDefault) {
    if (inT !== inDefault || outT !== outDefault) {
      return `pending slots present (in=${inT}, out=${outT})`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Slot generation
// ---------------------------------------------------------------------------

/** Mon-Thu: 2 slots, total = 480 min (8h). Entry constrained to 08:30-09:00. */
function pickMonThuSlots() {
  const entry = randInt(510, 540);
  const lbMin = Math.max(30, 630 - entry);
  const lbMax = Math.min(120, 660 - entry);
  const lunchBreak = randInt(lbMin, lbMax);
  const end = entry + 480 + lunchBreak;

  const loMin = Math.max(780, 870 - lunchBreak);
  const loMax = Math.min(840, 900 - lunchBreak);
  const lunchOut = randInt(loMin, loMax);
  const lunchIn = lunchOut + lunchBreak;

  return [
    { in_time: minToHHMM(entry), out_time: minToHHMM(lunchOut) },
    { in_time: minToHHMM(lunchIn), out_time: minToHHMM(end) },
  ];
}

/** Fri: 1 slot, total = 360 min (6h). */
function pickFridaySlots() {
  const entry = randInt(480, 540);
  return [{ in_time: minToHHMM(entry), out_time: minToHHMM(entry + 360) }];
}

// ---------------------------------------------------------------------------
// Payload (matches the MCP "complete_day" shape)
// ---------------------------------------------------------------------------

function buildPayload(date, slots, userId) {
  const uid = parseInt(userId, 10);
  const ts = Date.now();

  const formatted = slots.map((slot, i) => {
    const [inH, inM] = slot.in_time.split(":").map((n) => parseInt(n, 10));
    const [outH, outM] = slot.out_time.split(":").map((n) => parseInt(n, 10));
    const totalMin = outH * 60 + outM - (inH * 60 + inM);

    const inHHmm = `${pad2(inH)}:${pad2(inM)}:00`;
    const outHHmm = `${pad2(outH)}:${pad2(outM)}:00`;

    return {
      id: `${ts}-${i}`,
      in: {
        signId: 0,
        userId: uid,
        date: `${date}T${pad2(inH)}:00:00.000Z`,
        trueDate: `${date}T${pad2(inH)}:00:00.000Z`,
        signIn: true,
        time: inHHmm,
        valueTime: inHHmm,
        shortTime: inHHmm,
        shortTrueTime: inHHmm,
        shortValueTime: inHHmm,
        utcTime: `${inHHmm} +0`,
        signType: 3,
        signStatus: 1,
        deviceType: 0,
        deleted: false,
      },
      out: {
        signId: 0,
        userId: uid,
        date: `${date}T${pad2(outH)}:00:00.000Z`,
        trueDate: `${date}T${pad2(outH)}:00:00.000Z`,
        signIn: false,
        time: outHHmm,
        valueTime: outHHmm,
        shortTime: outHHmm,
        shortTrueTime: outHHmm,
        shortValueTime: outHHmm,
        utcTime: `${outHHmm} +0`,
        signType: 3,
        signStatus: 1,
        deviceType: 0,
        deleted: false,
      },
      totalMin,
    };
  });

  return { date, comments: "", userId: uid, slots: formatted };
}

async function completeDay(token, userId, date, slots) {
  const url = `${COMPANY_URL}/api/svc/core/users/${userId}/diarysummaries/workday/slots/self`;
  const res = await fetch(url, {
    method: "PUT",
    headers: bearerHeaders(token),
    body: JSON.stringify(buildPayload(date, slots, userId)),
  });
  if (!res.ok) {
    throw new Error(`complete_day failed: HTTP ${res.status} ${await res.text()}`);
  }
}

/** Confirms the day (equivalent to the "Confirmar" button in the Woffu UI). */
async function confirmDay(token, summaryId) {
  const url = `${COMPANY_URL}/api/svc/core/diariesquery/users/diarysummaries/confirm`;
  const res = await fetch(url, {
    method: "PUT",
    headers: bearerHeaders(token),
    body: JSON.stringify({ diarySummaryIds: [summaryId] }),
  });
  if (!res.ok) {
    throw new Error(`confirm failed: HTTP ${res.status} ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
requireEnv();

const { date, dow } = getTodayMadrid();
console.log(`Date (Madrid): ${date}  dow=${dow}  dry_run=${DRY_RUN}`);

if (dow < 1 || dow > 5) {
  console.log("Weekend — skipping.");
  process.exit(0);
}

console.log("Authenticating…");
const { token, userId } = await authenticate();
console.log(`Authenticated as userId=${userId}.`);

const today = await diarySummary(token, userId, date);
const status = isWorkingDay(today);
if (!status.working) {
  console.log(`Not a working day (${status.reason}) — skipping.`);
  process.exit(0);
}
console.log(`Working day confirmed (expected=${status.expectedHours}h).`);

const closed = closedReason(today);
if (closed) {
  console.log(`Day is closed (${closed}) — skipping.`);
  process.exit(0);
}

const existing = existingWorkReason(today);
if (existing) {
  console.log(`Day already has work logged (${existing}) — skipping to avoid overwrite.`);
  process.exit(0);
}

const slots = dow === 5 ? pickFridaySlots() : pickMonThuSlots();
const totalMin = slots.reduce((acc, s) => {
  const [ih, im] = s.in_time.split(":").map(Number);
  const [oh, om] = s.out_time.split(":").map(Number);
  return acc + (oh * 60 + om - (ih * 60 + im));
}, 0);

console.log("Generated slots:");
for (const s of slots) console.log(`  ${s.in_time}  →  ${s.out_time}`);
console.log(`Total: ${Math.floor(totalMin / 60)}h ${pad2(totalMin % 60)}m`);

// Resolved before the PUT: Woffu pre-creates a diary summary per calendar day,
// so the id is already known and does not change when the slots are written.
// Resolving it ahead of the dry-run exit means a dry run also proves the id can
// be read from the live API, not just that the slots were computed.
const summaryId = diarySummaryId(today);
if (summaryId === null) {
  console.error(`ERROR: no diarySummaryId on the diary for ${date} — aborting.`);
  process.exit(1);
}
console.log(`Resolved diarySummaryId=${summaryId} (used to confirm the day).`);

if (DRY_RUN) {
  console.log("DRY RUN — slots not sent, day not confirmed.");
  process.exit(0);
}

await completeDay(token, userId, date, slots);
console.log("Slots saved in Woffu.");

await confirmDay(token, summaryId);
console.log(`Done — day completed and confirmed (diarySummaryId=${summaryId}).`);
}

// Only run when executed directly, so the pure helpers above can be imported
// by tests without triggering the real API calls.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

export { diarySummaryId, closedReason, existingWorkReason, isWorkingDay };
