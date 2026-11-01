import { getApp, getApps, initializeApp } from "firebase/app";
import {
  collection,
  getDocs,
  getFirestore,
} from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDN01MPv0CZyrytoGiE-ncNTbN1do5chPY",
  authDomain: "innovation-showcase-2026-d19de.firebaseapp.com",
  projectId: "innovation-showcase-2026-d19de",
  storageBucket: "innovation-showcase-2026-d19de.firebasestorage.app",
  messagingSenderId: "178394050941",
  appId: "1:178394050941:web:7c85ec9b28571981ec1c14",
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
export const db = getFirestore(app);

function toIsoString(value, fallback = "") {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  if (value && typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }
  return fallback;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * Parses any date/time representation into total minutes from midnight.
 * Handles "HH:mm", "H:mm", "HH:mm:ss", ISO strings, Date objects, or Firestore Timestamps.
 */
export function parseTimeToMinutes(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    return value;
  }
  if (typeof value?.toDate === "function") {
    value = value.toDate();
  }
  if (value instanceof Date) {
    return value.getHours() * 60 + value.getMinutes();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.includes("T")) {
      const d = new Date(trimmed);
      if (!Number.isNaN(d.getTime())) {
        return d.getHours() * 60 + d.getMinutes();
      }
    }
    const match = trimmed.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (match) {
      let hours = parseInt(match[1], 10);
      const minutes = parseInt(match[2], 10);
      const meridian = match[4]?.toLowerCase();
      if (meridian === "pm" && hours < 12) hours += 12;
      if (meridian === "am" && hours === 12) hours = 0;
      return hours * 60 + minutes;
    }
  }
  return null;
}

export function isTimeInRange(timeVal, startMinutes, endMinutes) {
  const m = parseTimeToMinutes(timeVal);
  if (m === null) return false;
  return m >= startMinutes && m <= endMinutes;
}

export async function parseParticipantDocuments(documents) {
  return Promise.all(
    documents.map(async (participantDocument) => {
      const data = participantDocument.data();
      const summary = data.summary ?? {};
      let tests = [];

      try {
        const boothsSnapshot = await getDocs(
          collection(db, "participants", participantDocument.id, "booths"),
        );
        tests = boothsSnapshot.docs
          .map((boothDocument) => {
            const booth = boothDocument.data();
            return {
              boothId: typeof booth.boothId === "string" ? booth.boothId : boothDocument.id,
              boothNumber: toNumber(booth.boothNumber),
              boothTitle: typeof booth.boothTitle === "string" ? booth.boothTitle : "",
              topicTitle: typeof booth.topicTitle === "string" ? booth.topicTitle : "",
              score: toNumber(booth.score),
              totalQuestions: toNumber(booth.totalQuestions),
              percentage: toNumber(booth.percentage),
              timeTakenSeconds: toNumber(booth.timeTakenSeconds),
              completedAt: toIsoString(booth.completedAt),
            };
          })
          .sort((left, right) => left.boothNumber - right.boothNumber);
      } catch (err) {
        console.warn(`Could not load booths for participant ${participantDocument.id}:`, err);
      }

      const boothTotalScore = tests.reduce((total, test) => total + test.score, 0);
      const boothTotalQuestions = tests.reduce(
        (total, test) => total + test.totalQuestions,
        0,
      );
      const latestTest = tests
        .map((test) => test.completedAt)
        .filter(Boolean)
        .sort()
        .at(-1);
      const registeredAt =
        toIsoString(data.registeredAt) || new Date().toISOString();

      const totalScore = toNumber(summary.totalScore) || boothTotalScore;
      const totalQuestions = toNumber(summary.totalQuestions) || boothTotalQuestions;
      const totalTimeSeconds = toNumber(summary.totalTimeSeconds);
      const completionTime = data.completionTime || summary.completionTime || "";

      return {
        id: participantDocument.id,
        name: typeof data.name === "string" ? data.name : "Anonymous Attendee",
        email: typeof data.email === "string" ? data.email : participantDocument.id,
        registeredAt,
        totalTestsAppeared: tests.length || toNumber(summary.boothsCompleted),
        totalScore,
        totalQuestions,
        totalTimeSeconds,
        completionTime,
        overallAccuracy:
          toNumber(summary.accuracy) ||
          (totalQuestions === 0
            ? 0
            : Math.round((totalScore / totalQuestions) * 100)),
        isPrizeEligible: Boolean(
          summary.isPrizeEligible ?? (tests.length >= 4),
        ),
        summary: {
          ...summary,
          isPrizeEligible: Boolean(summary.isPrizeEligible),
          totalScore,
          totalQuestions,
          totalTimeSeconds,
          completionTime,
        },
        lastUpdated:
          toIsoString(data.lastUpdated) ||
          latestTest ||
          toIsoString(data.lastActiveAt) ||
          registeredAt,
        tests,
      };
    }),
  );
}

/**
 * Query and filter participants for a specific slot:
 * - isPrizeEligible must be true (in summary object)
 * - completionTime between startMinutes and endMinutes
 * - sorted by totalScore DESC, then totalTimeSeconds ASC
 * - returns top 10 records
 */
export async function fetchTopParticipantsForSlot({
  startMinutes,
  endMinutes,
  limitCount = 10,
}) {
  const snapshot = await getDocs(collection(db, "participants"));

  const eligibleDocs = [];
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const summary = data.summary ?? {};

    // 1. isPrizeEligible must be true in Summary object
    const isPrizeEligible = Boolean(summary.isPrizeEligible ?? data.isPrizeEligible);
    if (!isPrizeEligible) {
      continue;
    }

    // 2. completionTime between startMinutes and endMinutes
    const compTime = summary.completionTime || data.completionTime;
    if (!compTime) {
      continue;
    }

    if (!isTimeInRange(compTime, startMinutes, endMinutes)) {
      continue;
    }

    eligibleDocs.push(doc);
  }

  const participants = await parseParticipantDocuments(eligibleDocs);

  // Sort: highest totalScore first, ties broken by lowest totalTimeSeconds
  participants.sort((a, b) => {
    const scoreA = Number(a.summary?.totalScore ?? a.totalScore ?? 0);
    const scoreB = Number(b.summary?.totalScore ?? b.totalScore ?? 0);
    if (scoreB !== scoreA) {
      return scoreB - scoreA;
    }
    const timeA = Number(a.summary?.totalTimeSeconds ?? a.totalTimeSeconds ?? 0);
    const timeB = Number(b.summary?.totalTimeSeconds ?? b.totalTimeSeconds ?? 0);
    return timeA - timeB;
  });

  return participants.slice(0, limitCount);
}
