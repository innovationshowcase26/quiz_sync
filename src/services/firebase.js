import { getApp, getApps, initializeApp } from "firebase/app";
import {
  collection,
  getDocs,
  getDocsFromServer,
  getFirestore,
  limit,
  onSnapshot,
  orderBy,
  query,
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

const TOP_PARTICIPANTS_LIMIT = 15;

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

function participantQuery() {
  return query(
    collection(db, "participants"),
    orderBy("summary.totalScore", "desc"),
    orderBy("summary.totalTimeSeconds", "asc"),
    limit(TOP_PARTICIPANTS_LIMIT),
  );
}

async function parseParticipantDocuments(documents) {
  return Promise.all(
    documents.map(async (participantDocument) => {
      const data = participantDocument.data();
      const summary = data.summary ?? {};
      const boothsSnapshot = await getDocs(
        collection(db, "participants", participantDocument.id, "booths"),
      );
      const tests = boothsSnapshot.docs
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

      const totalScore = tests.reduce((total, test) => total + test.score, 0);
      const totalQuestions = tests.reduce(
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

      return {
        name: typeof data.name === "string" ? data.name : "Anonymous Attendee",
        registeredAt,
        totalTestsAppeared: tests.length,
        totalScore: toNumber(summary.totalScore) || totalScore,
        totalQuestions: toNumber(summary.totalQuestions) || totalQuestions,
        overallAccuracy:
          toNumber(summary.accuracy) ||
          (totalQuestions === 0
            ? 0
            : Math.round((totalScore / totalQuestions) * 100)),
        isPrizeEligible: Boolean(
          summary.isPrizeEligible ?? tests.length >= 4,
        ),
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

export function subscribeToParticipants(onData, onError) {
  let latestSnapshotVersion = 0;

  return onSnapshot(
    participantQuery(),
    (snapshot) => {
      const currentVersion = ++latestSnapshotVersion;
      parseParticipantDocuments(snapshot.docs)
        .then((participants) => {
          if (currentVersion === latestSnapshotVersion) onData(participants);
        })
        .catch(onError);
    },
    onError,
  );
}

export async function fetchParticipantsFromServer() {
  const snapshot = await getDocsFromServer(participantQuery());
  return parseParticipantDocuments(snapshot.docs);
}
