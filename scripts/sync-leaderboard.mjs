import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchTopParticipantsForSlot,
} from "../src/services/firebase.js";
import { TIME_SLOTS } from "../src/services/slots.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

async function commitToGitHub(filePath, output, customMessage) {
  const token = process.env.VITE_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    console.log("No VITE_GITHUB_TOKEN or GITHUB_TOKEN found; skipping GitHub commit.");
    return;
  }

  const owner = process.env.VITE_GITHUB_REPO_OWNER || "innovationshowcase26";
  const repo = process.env.VITE_GITHUB_REPO_NAME || "quiz_sync";
  const branch = process.env.VITE_GITHUB_BRANCH || "main";

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
    console.log(`Remote ${filePath} in GitHub is already up to date.`);
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
      message: customMessage || `chore: sync ${filePath} [skip ci]`,
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
  console.log(`Successfully committed ${filePath} to GitHub! Commit SHA: ${result.commit?.sha?.slice(0, 7)}`);
}

async function syncSlot(slot) {
  console.log(`\nSyncing slot ${slot.timeLabel} (${slot.rangeLabel}) -> ${slot.filePath}`);
  const topRecords = await fetchTopParticipantsForSlot({
    startMinutes: slot.startMinutes,
    endMinutes: slot.endMinutes,
    limitCount: 10,
  });

  const output = `${JSON.stringify(topRecords, null, 2)}\n`;
  const localPath = path.join(ROOT, slot.filePath);
  await mkdir(path.dirname(localPath), { recursive: true });
  await writeFile(localPath, output, "utf8");
  console.log(`Wrote ${topRecords.length} records to ${localPath}`);

  await commitToGitHub(
    slot.filePath,
    output,
    `chore: sync ${slot.timeLabel} leaderboard (${topRecords.length} records) [${slot.rangeLabel}]`,
  );
}

async function main() {
  await loadEnv();

  const targetArg = process.argv[2];

  if (!targetArg || targetArg === "all") {
    // Sync all 17 slots
    console.log(`Syncing all ${TIME_SLOTS.length} time slots (10:00 to 18:00)...`);
    for (const slot of TIME_SLOTS) {
      await syncSlot(slot);
    }
    console.log("\nAll slots processed successfully.");
  } else {
    // Find specific slot by ID or time (e.g. "1030" or "10:30")
    const cleaned = targetArg.replace(":", "");
    const slot = TIME_SLOTS.find((s) => s.id === cleaned || s.timeLabel === targetArg);

    if (!slot) {
      console.error(`Slot "${targetArg}" not found. Available slots: ${TIME_SLOTS.map((s) => s.id).join(", ")}`);
      process.exit(1);
    }

    await syncSlot(slot);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error("Leaderboard sync failed:", error);
  process.exit(1);
});
