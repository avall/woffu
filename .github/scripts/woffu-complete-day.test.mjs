#!/usr/bin/env node
/**
 * Tests the pure diary-inspection helpers against real Woffu API payloads
 * captured from `diaries/summary/presence`.
 *
 * Run: node .github/scripts/woffu-complete-day.test.mjs
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  diarySummaryId,
  closedReason,
  existingWorkReason,
  isWorkingDay,
} from "./woffu-complete-day.mjs";

const hours = (v) => ({ resource: "_HoursFormatted", values: [v] });

const base = {
  userId: 2873604,
  name: "SONOC REGTECH",
  comments: null,
  differenceTime: 0,
  isUserEditable: true,
  notRecognizedTimeFormatted: hours("0"),
  diaryHourTypes: [],
  shift: null,
  pendingAbsenceEvents: null,
  absenceEvents: null,
  pendingPresenceEvents: null,
  presenceEvents: null,
  calendarEvents: {
    name: null, color: null, eventNames: null, holidayNames: null,
    isDisabled: false, isHoliday: false, isEvent: false,
  },
  isPending: false,
  isToday: false,
  isWeekend: false,
  isHoliday: false,
  isEvent: false,
  accepted: null,
  fullName: null,
  hasPendingDiaryChangeUser: false,
  hasPendingDiaryChangeTargetUser: false,
  diaryChangeRequestId: null,
};

/** Empty Friday, today, ready to be filled. Real payload for 2026-07-31. */
const TODAY_EMPTY = {
  ...base,
  diaryId: 1051136593,
  diarySummaryId: 828062131,
  date: "2026-07-31",
  maxStartTime: "09:00:00",
  minEndTime: "15:00:00",
  differenceTime: -21600,
  isToday: true,
  in: "09:00:00",
  out: "15:00:00",
  breaks: hours("0"),
  workingTimeFormatted: hours("6"),
  workedTimeFormatted: hours("0"),
  differenceTimeFormatted: hours("-6"),
  scheduleTimeFormatted: hours("6"),
};

/**
 * Already-confirmed day: accepted=true, not editable, 0 worked hours, and
 * in/out identical to the schedule placeholders. Real payload for 2026-07-30.
 */
const CONFIRMED_EMPTY = {
  ...base,
  diaryId: 1051136592,
  diarySummaryId: 828062130,
  date: "2026-07-30",
  maxStartTime: "08:00:00",
  minEndTime: "17:00:00",
  accepted: true,
  differenceTime: -28800,
  isUserEditable: false,
  in: "08:00:00",
  out: "17:00:00",
  breaks: hours("1"),
  workingTimeFormatted: hours("8"),
  workedTimeFormatted: hours("0"),
  differenceTimeFormatted: hours("-8"),
  scheduleTimeFormatted: hours("8"),
};

/** Day already worked, not yet confirmed. Real payload for 2026-07-01. */
const WORKED = {
  ...base,
  diaryId: 1051136563,
  diarySummaryId: 828062101,
  date: "2026-07-01",
  maxStartTime: "08:00:00",
  minEndTime: "17:00:00",
  in: "08:57:00",
  out: "18:33:00",
  breaks: { resource: "_HoursMinutesFormatted", values: ["1", "36"] },
  workingTimeFormatted: hours("8"),
  workedTimeFormatted: hours("8"),
  differenceTimeFormatted: hours("0"),
  scheduleTimeFormatted: hours("8"),
};

/** Weekend. Real payload for 2026-07-04. */
const WEEKEND = {
  ...base,
  diaryId: 1051136566,
  diarySummaryId: 828062104,
  date: "2026-07-04",
  name: "_Weekend",
  isWeekend: true,
  maxStartTime: null,
  minEndTime: null,
  in: "",
  out: "",
  breaks: null,
  workingTimeFormatted: null,
  workedTimeFormatted: hours("0"),
  differenceTimeFormatted: hours("0"),
  scheduleTimeFormatted: hours("8"),
};

test("diarySummaryId reads the id from a real diary", () => {
  assert.equal(diarySummaryId(TODAY_EMPTY), 828062131);
  assert.equal(diarySummaryId(CONFIRMED_EMPTY), 828062130);
});

test("diarySummaryId returns null when the field is missing or invalid", () => {
  assert.equal(diarySummaryId(null), null);
  assert.equal(diarySummaryId(undefined), null);
  assert.equal(diarySummaryId({}), null);
  assert.equal(diarySummaryId({ diarySummaryId: 0 }), null);
  assert.equal(diarySummaryId({ diarySummaryId: null }), null);
});

test("closedReason blocks a confirmed day that looks empty", () => {
  // Regression: workedTime=0 and in/out equal to the schedule placeholders make
  // this day look untouched to existingWorkReason.
  assert.equal(existingWorkReason(CONFIRMED_EMPTY), null);
  assert.match(closedReason(CONFIRMED_EMPTY), /already confirmed/);
});

test("closedReason blocks a non-editable day", () => {
  const locked = { ...TODAY_EMPTY, isUserEditable: false };
  assert.match(closedReason(locked), /not user-editable/);
});

test("closedReason lets an open day through", () => {
  assert.equal(closedReason(TODAY_EMPTY), null);
  assert.equal(closedReason(WORKED), null);
  assert.equal(closedReason(null), null);
});

test("existingWorkReason detects a day that was already worked", () => {
  assert.match(existingWorkReason(WORKED), /workedTimeFormatted=8h/);
});

test("existingWorkReason lets an untouched day through", () => {
  assert.equal(existingWorkReason(TODAY_EMPTY), null);
});

test("existingWorkReason detects pending presence events", () => {
  const pending = { ...TODAY_EMPTY, pendingPresenceEvents: [{ id: 1 }] };
  assert.match(existingWorkReason(pending), /pendingPresenceEvents=1/);
});

test("existingWorkReason detects slots diverging from the schedule", () => {
  const filled = { ...TODAY_EMPTY, in: "08:45:00", out: "14:45:00" };
  assert.match(existingWorkReason(filled), /pending slots present/);
});

test("isWorkingDay accepts today and rejects the weekend", () => {
  assert.deepEqual(isWorkingDay(TODAY_EMPTY), { working: true, expectedHours: 6 });
  assert.equal(isWorkingDay(WEEKEND).working, false);
  assert.equal(isWorkingDay(WEEKEND).reason, "weekend");
  assert.equal(isWorkingDay(null).working, false);
});

test("isWorkingDay rejects holidays and absences", () => {
  assert.equal(isWorkingDay({ ...TODAY_EMPTY, isHoliday: true }).reason, "holiday");
  assert.equal(
    isWorkingDay({ ...TODAY_EMPTY, absenceEvents: [{ id: 1 }] }).reason,
    "absence event"
  );
});
