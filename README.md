# Innovation Showcase Quiz Leaderboard

The React dashboard connects directly to Firebase Cloud Firestore and listens
for changes to the top 15 participants. Participants are ranked by
`summary.totalScore` (highest first), then by `summary.totalTimeSeconds`
(lowest first). The Refresh button requests fresh data from the Firestore
server.

## Firestore data expected

- Participant documents: `participants/{email}`
- Booth quiz documents: `participants/{email}/booths/{booth-id}`
- Participant ranking fields: `summary.totalScore` and
  `summary.totalTimeSeconds`
- Participant details: `name`, `registeredAt`, `lastActiveAt`, and
  `summary.isPrizeEligible`
- Booth fields: `boothNumber`, `boothId`, `boothTitle`, `topicTitle`, `score`,
  `totalQuestions`, `percentage`, `timeTakenSeconds`, and `completedAt`

The dashboard aggregates score, question count, booth-test count, and accuracy
from each selected participant's booth documents. It displays participant
names and quiz statistics, but does not read or display email addresses,
device data, or answer selections.

After Firestore data loads or is refreshed, use **Download JSON** to download
the current top-15 records in the requested JSON shape. The download is
generated in the browser and is not a permanent public URL or a write to the
repository.

## Firestore access and security

The Firebase web configuration in `src/services/firebase.js` identifies the
Firebase project; it is not a private credential. Browser access is controlled
by Firestore Security Rules. Configure rules to allow only the intended
read-only access to the leaderboard data. Do not allow public writes. Since the
dashboard displays names and scores, consider whether those fields should be
public before publishing it.

The top-15 Firestore query orders by `summary.totalScore` and
`summary.totalTimeSeconds`. If Firestore reports that a composite index is
required, create the index it links to for the `participants` collection.

## Direct GitHub commit from Dashboard

The dashboard can commit `public/data/leaderboard.json` directly to the GitHub repository (`innovation-showcase-2026/quiz_sync`) using a GitHub Personal Access Token (PAT).

- **On-demand commit**: Click **Commit to GitHub** in the dashboard to commit immediately.
- **Auto-commit**: Enable the **Auto-commit** switch in the dashboard to automatically commit changes whenever new Firestore results arrive.
- **Token Configuration**: Click the **Set GitHub Token** button in the header to enter your token and test the connection, or specify `VITE_GITHUB_TOKEN` in `.env`.
- **Token Permissions**: The token requires **Contents: Read and Write** permissions on the repository.

## Optional scheduled JSON export

The GitHub Actions workflow separately runs every five minutes and writes
`public/data/leaderboard.json`. It uses the Firebase web configuration in
`src/services/firebase.js`, the same configuration as the dashboard, and does
not require a service-account secret. The Firestore Security Rules must allow
the GitHub Actions runner to read the participant query and booth documents.

Ensure GitHub Actions is enabled and can write repository contents. The
workflow commits changes to the JSON only when the generated output differs.
Once that file is included in a GitHub Pages deployment, other applications
can fetch it from the site's `/data/leaderboard.json` URL.

The dashboard's **Download JSON** link creates a local download. The scheduled
workflow is what updates the stable hosted JSON file; requesting the GitHub
Pages index URL does not run the export.

## Run locally

```sh
npm install
npm run dev
```

To run the optional JSON export locally, run `npm run sync` with Firestore
access permitted for the configured Firebase project.

Build the static React app with `npm run build`.
