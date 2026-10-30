import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collection,
  getDocs,
  limit,
  orderBy,
  query,
} from "firebase/firestore";
import { db } from "../src/services/firebase.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_PATH = path.join(ROOT, "public", "data", "leaderboard.json");
const TOP_PARTICIPANTS_LIMIT = 15;

async function loadEnv() {
  try {
    const envContent = await readFile(path.join(ROOT, ".env"), "utf8");
    for (const line of envContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const equalsIdx = trimmed.indexOf("=");
      if (equalsIdx > 0) {
        const key = trimmed.slice(0, equalsIdx).trim();
        const value = trimmed.slice(equalsIdx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = value.replace(/^["'](.*)["']$/, "$1");
        }
      }
    }
  } catch {
    // Ignore if .env is missing
  }
}

function toIsoString(value, fieldName) {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }

  if (value && typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }

  throw new Error(`Expected ${fieldName} to be a valid ISO date or Firestore timestamp.`);
}

function requiredNumber(value, fieldName) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected ${fieldName} to be a finite number.`);
  }

  return value;
}

function optionalText(value) {
  return typeof value === "string" ? value : "";
}

async function makeParticipantResult(participantDocument) {
  const participant = participantDocument.data();
  const summary = participant.summary ?? {};
  const boothsSnapshot = await getDocs(
    collection(db, "participants", participantDocument.id, "booths"),
  );
  const tests = boothsSnapshot.docs
    .map((boothDocument) => boothDocument.data())
    .sort((left, right) => (left.boothNumber ?? 0) - (right.boothNumber ?? 0))
    .map((test) => ({
      boothId: optionalText(test.boothId),
      boothNumber: requiredNumber(test.boothNumber, "boothNumber"),
      boothTitle: optionalText(test.boothTitle),
      topicTitle: optionalText(test.topicTitle),
      score: requiredNumber(test.score, "score"),
      totalQuestions: requiredNumber(test.totalQuestions, "totalQuestions"),
      percentage: requiredNumber(test.percentage, "percentage"),
      timeTakenSeconds: requiredNumber(test.timeTakenSeconds, "timeTakenSeconds"),
      completedAt: toIsoString(test.completedAt, "completedAt"),
    }));

  const totalScore = tests.reduce((total, test) => total + test.score, 0);
  const totalQuestions = tests.reduce(
    (total, test) => total + test.totalQuestions,
    0,
  );
  const lastTestAt = tests
    .map((test) => test.completedAt)
    .sort()
    .at(-1);

  return {
    name: optionalText(participant.name) || "Quiz player",
    registeredAt: toIsoString(participant.registeredAt, "registeredAt"),
    totalTestsAppeared: tests.length,
    totalScore,
    totalQuestions,
    overallAccuracy:
      totalQuestions === 0 ? 0 : Math.round((totalScore / totalQuestions) * 100),
    isPrizeEligible: summary.isPrizeEligible === true,
    lastUpdated: lastTestAt
      ? lastTestAt
      : toIsoString(participant.lastActiveAt, "lastActiveAt"),
    tests,
  };
}

async function commitToGitHub(output) {
  const token = process.env.VITE_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    console.log("No VITE_GITHUB_TOKEN or GITHUB_TOKEN found in environment; skipping GitHub commit.");
    return;
  }

  const owner = process.env.VITE_GITHUB_REPO_OWNER || "innovation-showcase-2026";
  const repo = process.env.VITE_GITHUB_REPO_NAME || "quiz_sync";
  const branch = process.env.VITE_GITHUB_BRANCH || "main";
  const filePath = "public/data/leaderboard.json";

  const getUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`;
  let sha;
  let remoteContent;

  try {
    const getRes = await fetch(getUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (getRes.ok) {
      const data = await getRes.json();
      sha = data.sha;
      if (data.content) {
        remoteContent = Buffer.from(data.content.replace(/\s/g, ""), "base64").toString("utf8");
      }
    }
  } catch (err) {
    console.warn("Could not check existing remote GitHub file:", err.message);
  }

  if (remoteContent && remoteContent === output) {
    console.log("Remote leaderboard.json in GitHub is already up to date.");
    return;
  }

  const putUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
  const putRes = await fetch(putUrl, {
    method: "PUT",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      message: "chore: sync leaderboard data [skip ci]",
      content: Buffer.from(output, "utf8").toString("base64"),
      branch,
      sha,
    }),
  });

  if (!putRes.ok) {
    const errorJson = await putRes.json().catch(() => ({}));
    throw new Error(`GitHub commit failed (HTTP ${putRes.status}): ${errorJson.message || putRes.statusText}`);
  }

  const result = await putRes.json();
  console.log(`Successfully committed leaderboard.json to GitHub! Commit SHA: ${result.commit?.sha?.slice(0, 7)}`);

  // Trigger deploy workflow
  try {
    const dispatchUrl = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/deploy.yml/dispatches`;
    const dispatchRes = await fetch(dispatchUrl, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ ref: branch }),
    });
    if (dispatchRes.status === 204) {
      console.log("Successfully triggered deployment workflow (deploy.yml).");
    }
  } catch (dispErr) {
    console.warn("Could not trigger deployment workflow:", dispErr.message);
  }
}

async function main() {
  await loadEnv();

  let participantsDocs;
  try {
    const participantsQuery = query(
      collection(db, "participants"),
      orderBy("summary.totalScore", "desc"),
      orderBy("summary.totalTimeSeconds", "asc"),
      limit(TOP_PARTICIPANTS_LIMIT),
    );
    const participantsSnapshot = await getDocs(participantsQuery);
    participantsDocs = participantsSnapshot.docs;
  } catch (err) {
    if (err?.code === "failed-precondition") {
      console.warn(
        "Firestore composite index is not yet built. Falling back to fetching and sorting in memory.\n" +
          "Create composite index: https://console.firebase.google.com/v1/r/project/innovation-showcase-2026-d19de/firestore/indexes?create_composite=CmNwcm9qZWN0cy9pbm5vdmF0aW9uLXNob3djYXNlLTIwMjYtZDE5ZGUvZGF0YWJhc2VzLyhkZWZhdWx0KS9jb2xsZWN0aW9uR3JvdXBzL3BhcnRpY2lwYW50cy9pbmRleGVzL18QARoWChJzdW1tYXJ5LnRvdGFsU2NvcmUQAhocChhzdW1tYXJ5LnRvdGFsVGltZVNlY29uZHMQARoMCghfX25hbWVfXxAB",
      );
      const allDocsSnapshot = await getDocs(collection(db, "participants"));
      participantsDocs = [...allDocsSnapshot.docs]
        .sort((a, b) => {
          const aData = a.data()?.summary || {};
          const bData = b.data()?.summary || {};
          const scoreDiff = (bData.totalScore || 0) - (aData.totalScore || 0);
          if (scoreDiff !== 0) return scoreDiff;
          return (aData.totalTimeSeconds || 0) - (bData.totalTimeSeconds || 0);
        })
        .slice(0, TOP_PARTICIPANTS_LIMIT);
    } else {
      throw err;
    }
  }

  const leaderboard = await Promise.all(
    participantsDocs.map(makeParticipantResult),
  );

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  const output = `${JSON.stringify(leaderboard, null, 2)}\n`;
  let currentOutput = "";
  try {
    currentOutput = await readFile(OUTPUT_PATH, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  await writeFile(OUTPUT_PATH, output, "utf8");
  console.log(`Wrote ${leaderboard.length} top participants to public/data/leaderboard.json.`);

  await commitToGitHub(output);
  process.exit(0);
}

main().catch((error) => {
  console.error("Leaderboard sync failed:", error);
  process.exit(1);
});
