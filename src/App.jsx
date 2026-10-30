import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchParticipantsFromServer,
  subscribeToParticipants,
} from "./services/firebase.js";
import {
  DEFAULT_REPO_NAME,
  DEFAULT_REPO_OWNER,
  commitLeaderboardToGitHub,
  fetchCurrentLeaderboardSha,
  getAutoCommitPreference,
  getStoredGitHubToken,
  saveAutoCommitPreference,
  saveStoredGitHubToken,
} from "./services/github.js";

function formatDate(value) {
  if (!value) return "Not available";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatDuration(seconds) {
  const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;

  return minutes ? `${minutes}m ${remainingSeconds}s` : `${remainingSeconds}s`;
}

function App() {
  const [participants, setParticipants] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [jsonUrl, setJsonUrl] = useState("");

  // GitHub integration state
  const [githubToken, setGithubToken] = useState(() => getStoredGitHubToken());
  const [autoCommit, setAutoCommit] = useState(() => getAutoCommitPreference());
  const [committing, setCommitting] = useState(false);
  const [commitStatus, setCommitStatus] = useState(null); // { type: 'success' | 'unchanged' | 'error', message, commitSha, commitUrl, time }
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tokenInput, setTokenInput] = useState(() => getStoredGitHubToken());
  const [testingToken, setTestingToken] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const lastCommittedJsonRef = useRef("");
  const autoCommitTimerRef = useRef(null);

  // Generate downloadable JSON
  useEffect(() => {
    if (participants.length === 0) {
      setJsonUrl("");
      return undefined;
    }

    const jsonFile = new Blob([`${JSON.stringify(participants, null, 2)}\n`], {
      type: "application/json",
    });
    const downloadUrl = URL.createObjectURL(jsonFile);
    setJsonUrl(downloadUrl);

    return () => URL.revokeObjectURL(downloadUrl);
  }, [participants]);

  // Handler to perform commit to GitHub
  const handleCommitToGitHub = useCallback(
    async (currentParticipants, isAutomated = false) => {
      const dataToCommit = currentParticipants || participants;
      if (!dataToCommit || dataToCommit.length === 0) return;

      const activeToken = githubToken || getStoredGitHubToken();
      if (!activeToken) {
        if (!isAutomated) {
          setSettingsOpen(true);
          setCommitStatus({
            type: "error",
            message: "GitHub token missing. Please save your Personal Access Token below.",
          });
        }
        return;
      }

      const jsonString = `${JSON.stringify(dataToCommit, null, 2)}\n`;
      if (isAutomated && lastCommittedJsonRef.current === jsonString) {
        return;
      }

      setCommitting(true);
      try {
        const result = await commitLeaderboardToGitHub({
          participants: dataToCommit,
          token: activeToken,
        });

        lastCommittedJsonRef.current = jsonString;

        if (result.status === "committed") {
          setCommitStatus({
            type: "success",
            message: result.deployTriggered
              ? `Committed (${result.commitSha}) & triggered Deploy Action!`
              : `Committed to GitHub!`,
            commitSha: result.commitSha,
            commitUrl: result.commitUrl,
            time: new Date().toLocaleTimeString(),
          });
        } else if (result.status === "unchanged") {
          setCommitStatus({
            type: "unchanged",
            message: `GitHub repository is already up to date.`,
            commitSha: result.sha?.slice(0, 7),
            time: new Date().toLocaleTimeString(),
          });
        }
      } catch (commitErr) {
        setCommitStatus({
          type: "error",
          message: commitErr.message || "Failed to commit to GitHub.",
          time: new Date().toLocaleTimeString(),
        });
      } finally {
        setCommitting(false);
      }
    },
    [participants, githubToken],
  );

  // Handle manual Refresh button
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const freshData = await fetchParticipantsFromServer();
      setParticipants(freshData);
      setLastUpdated(new Date());
      setError("");

      if (autoCommit && freshData.length > 0) {
        handleCommitToGitHub(freshData, true);
      }
    } catch (loadError) {
      setError(loadError.message || "Unable to load leaderboard data.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [autoCommit, handleCommitToGitHub]);

  const autoCommitRef = useRef(autoCommit);
  autoCommitRef.current = autoCommit;

  const handleCommitRef = useRef(handleCommitToGitHub);
  handleCommitRef.current = handleCommitToGitHub;

  // Firestore live subscription & auto-commit on incoming data
  useEffect(() => {
    const unsubscribe = subscribeToParticipants(
      (data) => {
        setParticipants(data);
        setLastUpdated(new Date());
        setLoading(false);
        setError("");

        // Auto-commit debounce when fresh results arrive
        if (autoCommitRef.current && data && data.length > 0) {
          if (autoCommitTimerRef.current) {
            clearTimeout(autoCommitTimerRef.current);
          }
          autoCommitTimerRef.current = setTimeout(() => {
            if (handleCommitRef.current) {
              handleCommitRef.current(data, true);
            }
          }, 1200);
        }
      },
      (subscriptionError) => {
        setError(subscriptionError.message || "Unable to connect to Firestore.");
        setLoading(false);
      },
    );

    return () => {
      unsubscribe();
      if (autoCommitTimerRef.current) {
        clearTimeout(autoCommitTimerRef.current);
      }
    };
  }, []);

  // Toggle auto-commit preference
  const handleToggleAutoCommit = (e) => {
    const enabled = e.target.checked;
    setAutoCommit(enabled);
    saveAutoCommitPreference(enabled);
  };

  // Save token from modal
  const handleSaveToken = () => {
    const cleaned = tokenInput.trim();
    setGithubToken(cleaned);
    saveStoredGitHubToken(cleaned);
    setTestResult({
      type: "success",
      message: cleaned
        ? "Token saved successfully!"
        : "Token cleared.",
    });
  };

  // Test token connection
  const handleTestToken = async () => {
    const tokenToTest = tokenInput.trim();
    if (!tokenToTest) {
      setTestResult({
        type: "error",
        message: "Please enter a token first.",
      });
      return;
    }

    setTestingToken(true);
    setTestResult(null);
    try {
      const info = await fetchCurrentLeaderboardSha(tokenToTest);
      setTestResult({
        type: "success",
        message: `Connected successfully! Existing file found (SHA: ${
          info.sha ? info.sha.slice(0, 7) : "None"
        }). Ready to commit.`,
      });
      // Also auto-save if successful
      setGithubToken(tokenToTest);
      saveStoredGitHubToken(tokenToTest);
    } catch (testErr) {
      setTestResult({
        type: "error",
        message: testErr.message || "Connection failed. Check token permissions.",
      });
    } finally {
      setTestingToken(false);
    }
  };

  return (
    <main className="page-shell">
      <header className="hero">
        <div className="hero-topline">
          <div className="event-brand">
            <span className="event-mark" aria-hidden="true">
              IS
            </span>
            <span className="event-label">INNOVATION SHOWCASE 2026</span>
          </div>

          <div className="header-actions">
            <span className="live-indicator">
              <span className="live-dot" />
              Live leaderboard
            </span>

            <button
              type="button"
              className={`github-settings-pill ${githubToken ? "configured" : "needed"}`}
              onClick={() => {
                setTokenInput(githubToken);
                setSettingsOpen(true);
                setTestResult(null);
              }}
              title="Configure GitHub Token & Commit Settings"
            >
              <svg
                className="icon-git"
                viewBox="0 0 16 16"
                width="14"
                height="14"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9 1.05 1.27.42.5 1.19.46 1.87.35 0 .68.01 1.33.01 1.54 0 .21-.15.46-.55.38A8.013 8.013 0 0 1 0 8c0-4.42 3.58-8 8-8z" />
              </svg>
              <span>{githubToken ? "GitHub Ready" : "Set GitHub Token"}</span>
            </button>
          </div>
        </div>

        <div className="hero-copy">
          <p className="eyebrow">THE CHALLENGE</p>
          <h1>Quiz leaderboard</h1>
          <p className="hero-description">
            Live scores synchronized from Firebase and committed to GitHub as{" "}
            <code>public/data/leaderboard.json</code>.
          </p>
        </div>

        <div className="hero-stats" aria-label="Leaderboard summary">
          <div className="hero-stat">
            <span className="stat-value">{participants.length}</span>
            <span className="stat-label">LEADERS</span>
          </div>
          <div className="stat-divider" />
          <div className="hero-stat">
            <span className="stat-value">15</span>
            <span className="stat-label">TOP PLACES</span>
          </div>
          <div className="stat-divider" />
          <div className="hero-stat updated-stat">
            <span className="stat-value">{formatDate(lastUpdated)}</span>
            <span className="stat-label">DATA CHECKED</span>
          </div>
          <div className="stat-divider" />
          <div className="hero-stat updated-stat">
            <span className="stat-value">
              {commitStatus?.time ? commitStatus.time : "Pending"}
            </span>
            <span className="stat-label">GITHUB SYNC</span>
          </div>
        </div>
      </header>

      {/* GitHub Commit Status Toast / Banner */}
      {commitStatus && (
        <div
          className={`commit-status-bar status-${commitStatus.type}`}
          role="status"
        >
          <div className="status-content">
            <span className="status-indicator-dot" />
            <span className="status-text">{commitStatus.message}</span>
            {commitStatus.commitSha && (
              <span className="commit-tag">
                SHA:{" "}
                {commitStatus.commitUrl ? (
                  <a
                    href={commitStatus.commitUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="commit-link"
                  >
                    {commitStatus.commitSha} ↗
                  </a>
                ) : (
                  commitStatus.commitSha
                )}
              </span>
            )}
            {commitStatus.time && (
              <span className="status-time">at {commitStatus.time}</span>
            )}
          </div>
          <button
            type="button"
            className="status-dismiss"
            onClick={() => setCommitStatus(null)}
            aria-label="Dismiss notification"
          >
            ×
          </button>
        </div>
      )}

      <section
        className="leaderboard-section"
        aria-labelledby="leaderboard-title"
      >
        <div className="section-heading">
          <div>
            <p className="eyebrow">THE FRONT RUNNERS</p>
            <h2 id="leaderboard-title">Top 15 players</h2>
            <p className="ranking-note">
              Ranked by score, then fastest total time
            </p>
          </div>

          <div className="heading-controls">
            {/* Auto-commit switch */}
            <label
              className="auto-commit-toggle"
              title="Automatically commit leaderboard.json to GitHub when Firebase updates"
            >
              <input
                type="checkbox"
                checked={autoCommit}
                onChange={handleToggleAutoCommit}
              />
              <span className="toggle-slider" />
              <span className="toggle-label">Auto-commit</span>
            </label>

            {/* Manual Commit Button */}
            <button
              className="commit-button"
              type="button"
              onClick={() => handleCommitToGitHub(participants, false)}
              disabled={committing || loading || participants.length === 0}
              title="Commit current leaderboard.json to GitHub repository"
            >
              <svg
                viewBox="0 0 16 16"
                width="14"
                height="14"
                fill="currentColor"
                aria-hidden="true"
              >
                <path d="M10.5 7.75a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zm1.43.75a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 1 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 1 1 0 1.5h-3.32z" />
              </svg>
              {committing ? "Committing to GitHub…" : "Commit to GitHub"}
            </button>

            {/* Refresh Button */}
            <button
              className="refresh-button"
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
            >
              {refreshing ? "Refreshing…" : "Refresh"}
            </button>

            {/* Download JSON */}
            {jsonUrl && (
              <a
                className="json-download"
                href={jsonUrl}
                download="leaderboard.json"
              >
                Download JSON
              </a>
            )}
          </div>
        </div>

        {error && (
          <div className="notice error-notice" role="alert">
            <strong>Could not load the leaderboard.</strong> {error}
          </div>
        )}

        <div className="leaderboard-card">
          {loading ? (
            <div className="empty-state" role="status">
              Loading the latest scores…
            </div>
          ) : participants.length === 0 ? (
            <div className="empty-state">
              No quiz results yet. Check back after the first booth is
              completed.
            </div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">RANK</th>
                    <th scope="col">PLAYER</th>
                    <th scope="col">BOOTH TESTS</th>
                    <th scope="col">SCORE</th>
                    <th scope="col">ACCURACY</th>
                    <th scope="col">TOTAL TIME</th>
                    <th scope="col">PRIZE</th>
                  </tr>
                </thead>
                <tbody>
                  {participants.map((participant, index) => (
                    <tr
                      key={`${participant.name}-${participant.registeredAt}-${index}`}
                    >
                      <td>
                        <span
                          className={`rank-badge ${
                            index < 3 ? `rank-${index + 1}` : ""
                          }`}
                        >
                          {String(index + 1).padStart(2, "0")}
                        </span>
                      </td>
                      <td>
                        <div className="player-cell">
                          <span className="player-avatar" aria-hidden="true">
                            {(participant.name || "?").trim().charAt(0).toUpperCase()}
                          </span>
                          <span>
                            <strong className="player-name">
                              {participant.name || "Quiz player"}
                            </strong>
                            <span className="player-date">
                              Joined {formatDate(participant.registeredAt)}
                            </span>
                          </span>
                        </div>
                      </td>
                      <td>{participant.totalTestsAppeared ?? 0}</td>
                      <td>
                        <strong className="score-value">
                          {participant.totalScore ?? 0}
                        </strong>
                        <span className="score-total">
                          {" "}
                          / {participant.totalQuestions ?? 0}
                        </span>
                      </td>
                      <td>
                        <span className="accuracy-value">
                          {participant.overallAccuracy ?? 0}%
                        </span>
                      </td>
                      <td>
                        {formatDuration(
                          participant.tests?.reduce(
                            (total, test) =>
                              total + (Number(test.timeTakenSeconds) || 0),
                            0,
                          ),
                        )}
                      </td>
                      <td>
                        <span
                          className={`prize-badge ${
                            participant.isPrizeEligible ? "eligible" : ""
                          }`}
                        >
                          {participant.isPrizeEligible ? "Eligible" : "—"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {!loading && participants.length > 0 && (
          <div className="results-footnote">
            <span>
              Showing {participants.length} of the highest-scoring participants
            </span>
            <span>
              Last activity: {formatDate(participants[0]?.lastUpdated)}
            </span>
          </div>
        )}
      </section>

      {/* GitHub Token & Sync Settings Modal */}
      {settingsOpen && (
        <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
          <div
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <div className="modal-header">
              <h3 id="settings-title">GitHub Commit Settings</h3>
              <button
                type="button"
                className="modal-close"
                onClick={() => setSettingsOpen(false)}
                aria-label="Close modal"
              >
                ×
              </button>
            </div>

            <div className="modal-body">
              <p className="modal-desc">
                Configure your GitHub Personal Access Token to commit{" "}
                <code>public/data/leaderboard.json</code> directly to{" "}
                <strong>{DEFAULT_REPO_OWNER}/{DEFAULT_REPO_NAME}</strong>.
              </p>

              <div className="field-group">
                <label htmlFor="github-token-input">GitHub Token (PAT)</label>
                <input
                  id="github-token-input"
                  type="password"
                  placeholder="ghp_... or github_pat_..."
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  autoComplete="off"
                  spellCheck="false"
                />
                <span className="field-hint">
                  Requires <strong>Contents: Read and Write</strong> or{" "}
                  <strong>repo</strong> scope.
                </span>
              </div>

              {testResult && (
                <div className={`modal-notice notice-${testResult.type}`}>
                  {testResult.message}
                </div>
              )}

              <div className="field-group">
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={autoCommit}
                    onChange={handleToggleAutoCommit}
                  />
                  <span>
                    <strong>Auto-commit on new Firebase results:</strong>{" "}
                    Automatically commit to GitHub whenever Firestore updates
                    the leaderboard.
                  </span>
                </label>
              </div>

              <div className="repo-meta-box">
                <div className="meta-item">
                  <span className="meta-label">Repository:</span>
                  <span className="meta-val">
                    {DEFAULT_REPO_OWNER}/{DEFAULT_REPO_NAME}
                  </span>
                </div>
                <div className="meta-item">
                  <span className="meta-label">Branch:</span>
                  <span className="meta-val">main</span>
                </div>
                <div className="meta-item">
                  <span className="meta-label">File target:</span>
                  <span className="meta-val">public/data/leaderboard.json</span>
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button
                type="button"
                className="btn-secondary"
                onClick={handleTestToken}
                disabled={testingToken || !tokenInput.trim()}
              >
                {testingToken ? "Testing…" : "Test Connection"}
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  handleSaveToken();
                  setSettingsOpen(false);
                }}
              >
                Save & Close
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="page-footer">
        <span>Innovation Showcase 2026</span>
        <span>Live Firestore & GitHub Sync</span>
      </footer>
    </main>
  );
}

export default App;
