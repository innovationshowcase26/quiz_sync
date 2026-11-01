import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchTopParticipantsForSlot,
  parseTimeToMinutes,
} from "./services/firebase.js";
import {
  DEFAULT_BRANCH,
  DEFAULT_REPO_NAME,
  DEFAULT_REPO_OWNER,
  commitJsonFileToGitHub,
  fetchCurrentLeaderboardSha,
  fetchFileSha,
  getStoredGitHubToken,
  saveStoredGitHubToken,
} from "./services/github.js";
import { TIME_SLOTS } from "./services/slots.js";

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
  // Main view state - NO data fetched on page load
  const [activeSlot, setActiveSlot] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [loadingSlot, setLoadingSlot] = useState(false);
  const [error, setError] = useState("");
  const [jsonUrl, setJsonUrl] = useState("");

  // Sync Modal state
  const [syncModalOpen, setSyncModalOpen] = useState(false);
  const [syncingSlotId, setSyncingSlotId] = useState(null);
  const [slotStates, setSlotStates] = useState({}); // { [id]: { status, sha, count, time, error, commitUrl, data } }
  const [slotFilter, setSlotFilter] = useState("");

  // Custom/Test slot helper state
  const [showCustomTester, setShowCustomTester] = useState(false);
  const [customStart, setCustomStart] = useState("09:59");
  const [customEnd, setCustomEnd] = useState("10:31");
  const [customFileId, setCustomFileId] = useState("1030");
  const [customSyncing, setCustomSyncing] = useState(false);

  // GitHub token settings modal state
  const [githubToken, setGithubToken] = useState(() => getStoredGitHubToken());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tokenInput, setTokenInput] = useState(() => getStoredGitHubToken());
  const [testingToken, setTestingToken] = useState(false);
  const [testResult, setTestResult] = useState(null);

  // General notification banner
  const [bannerStatus, setBannerStatus] = useState(null); // { type: 'success' | 'unchanged' | 'error', message, commitSha, commitUrl, time }

  // Generate downloadable JSON blob for the currently active slot
  useEffect(() => {
    if (!participants || participants.length === 0) {
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

  // Handler to sync a single slot
  const handleSyncSlot = useCallback(
    async (slot) => {
      const activeToken = (githubToken || getStoredGitHubToken() || "").trim();
      if (!activeToken) {
        setSettingsOpen(true);
        setBannerStatus({
          type: "error",
          message: "GitHub token missing. Please save your Personal Access Token below to publish to GitHub.",
        });
        return;
      }

      setSyncingSlotId(slot.id);
      setLoadingSlot(true);
      setError("");

      try {
        // 1. Pull top 10 records from DB matching slot criteria
        const topRecords = await fetchTopParticipantsForSlot({
          startMinutes: slot.startMinutes,
          endMinutes: slot.endMinutes,
          limitCount: 10,
        });

        // 2. Publish JSON to GitHub at public/data/${slot.fileName}
        const commitResult = await commitJsonFileToGitHub({
          filePath: slot.filePath,
          data: topRecords,
          token: activeToken,
          customMessage: `chore: sync ${slot.timeLabel} leaderboard (${topRecords.length} records) [${slot.rangeLabel}]`,
        });

        const syncInfo = {
          status: "success",
          count: topRecords.length,
          sha: commitResult.commitSha,
          commitUrl: commitResult.commitUrl,
          time: new Date().toLocaleTimeString(),
          data: topRecords,
        };

        setSlotStates((prev) => ({
          ...prev,
          [slot.id]: syncInfo,
        }));

        // Set as active view on page
        setActiveSlot(slot);
        setParticipants(topRecords);
        setLastUpdated(new Date());

        setBannerStatus({
          type: "success",
          message: `Slot ${slot.timeLabel} (${slot.rangeLabel}) synced successfully! ${topRecords.length} players published to ${slot.filePath}`,
          commitSha: commitResult.commitSha,
          commitUrl: commitResult.commitUrl,
          time: syncInfo.time,
        });
      } catch (syncErr) {
        console.error("Sync error:", syncErr);
        const errMessage = syncErr.message || "Failed to sync slot.";
        setSlotStates((prev) => ({
          ...prev,
          [slot.id]: {
            status: "error",
            error: errMessage,
            time: new Date().toLocaleTimeString(),
          },
        }));
        setBannerStatus({
          type: "error",
          message: `Error syncing slot ${slot.timeLabel}: ${errMessage}`,
          time: new Date().toLocaleTimeString(),
        });
      } finally {
        setSyncingSlotId(null);
        setLoadingSlot(false);
      }
    },
    [githubToken],
  );

  // Handler for custom / arbitrary time slot test
  const handleCustomSync = async () => {
    const startM = parseTimeToMinutes(customStart);
    const endM = parseTimeToMinutes(customEnd);

    if (startM === null || endM === null) {
      alert("Please provide valid times in HH:mm format (e.g. 09:59 and 10:31).");
      return;
    }

    const cleanId = (customFileId || "custom").replace(/[^a-zA-Z0-9_-]/g, "");
    const customSlotObj = {
      id: cleanId,
      timeLabel: `${customStart}-${customEnd}`,
      fileName: `${cleanId}.json`,
      filePath: `public/data/${cleanId}.json`,
      startMinutes: startM,
      endMinutes: endM,
      startTimeStr: customStart,
      endTimeStr: customEnd,
      rangeLabel: `${customStart} to ${customEnd}`,
    };

    setCustomSyncing(true);
    await handleSyncSlot(customSlotObj);
    setCustomSyncing(false);
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
      const info = await fetchFileSha("README.md", tokenToTest);
      setTestResult({
        type: "success",
        message: `Connected successfully to GitHub! (README SHA: ${
          info.sha ? info.sha.slice(0, 7) : "found"
        }). Ready to commit.`,
      });
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

  const handleSaveToken = () => {
    const cleaned = tokenInput.trim();
    setGithubToken(cleaned);
    saveStoredGitHubToken(cleaned);
    setTestResult({
      type: "success",
      message: cleaned ? "Token saved successfully!" : "Token cleared.",
    });
  };

  // Filtered slots in popup
  const filteredSlots = useMemo(() => {
    const q = slotFilter.trim().toLowerCase();
    if (!q) return TIME_SLOTS;
    return TIME_SLOTS.filter(
      (s) =>
        s.timeLabel.includes(q) ||
        s.fileName.toLowerCase().includes(q) ||
        s.rangeLabel.includes(q),
    );
  }, [slotFilter]);

  // Count synced slots
  const syncedCount = useMemo(() => {
    return Object.values(slotStates).filter((s) => s?.status === "success").length;
  }, [slotStates]);

  return (
    <main className="page-shell">
      {/* Top Hero Banner */}
      <header className="hero">
        <div className="hero-topline">
          <div className="event-brand">
            <span className="event-mark" aria-hidden="true">
              IS
            </span>
            <span className="event-label">INNOVATION SHOWCASE 2026</span>
          </div>

          <div className="header-actions">
            {/* Primary Sync Button */}
            <button
              type="button"
              className="sync-modal-launcher-btn"
              onClick={() => setSyncModalOpen(true)}
              title="Open Time Slot Synchronization modal"
            >
              <svg
                viewBox="0 0 24 24"
                width="16"
                height="16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              <span>Sync by Time Slot</span>
              <span className="slot-count-badge">17 Slots</span>
            </button>

            {/* GitHub Settings Pill */}
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
          <p className="eyebrow">TIME-BASED QUIZ LEADERBOARD</p>
          <h1>Scheduled Sync Dashboard</h1>
          <p className="hero-description">
            Sync half-hour quiz intervals between 10:00 and 18:00 (24h format).
            Queries top 10 prize-eligible players sorted by score and fastest time,
            publishing directly to GitHub as <code>public/data/1030.json</code>,{" "}
            <code>1100.json</code>, and more.
          </p>
        </div>

        <div className="hero-stats" aria-label="Slot sync summary">
          <div className="hero-stat">
            <span className="stat-value">{TIME_SLOTS.length}</span>
            <span className="stat-label">TIME SLOTS (10:00–18:00)</span>
          </div>
          <div className="stat-divider" />
          <div className="hero-stat">
            <span className="stat-value">{syncedCount} / {TIME_SLOTS.length}</span>
            <span className="stat-label">SLOTS SYNCED</span>
          </div>
          <div className="stat-divider" />
          <div className="hero-stat updated-stat">
            <span className="stat-value">
              {activeSlot ? activeSlot.timeLabel : "None Selected"}
            </span>
            <span className="stat-label">ACTIVE VIEW</span>
          </div>
          <div className="stat-divider" />
          <div className="hero-stat updated-stat">
            <span className="stat-value">
              {lastUpdated ? lastUpdated.toLocaleTimeString() : "No sync yet"}
            </span>
            <span className="stat-label">LAST ACTION</span>
          </div>
        </div>
      </header>

      {/* Banner Toast Notification */}
      {bannerStatus && (
        <div
          className={`commit-status-bar status-${bannerStatus.type}`}
          role="status"
        >
          <div className="status-content">
            <span className="status-indicator-dot" />
            <span className="status-text">{bannerStatus.message}</span>
            {bannerStatus.commitSha && (
              <span className="commit-tag">
                SHA:{" "}
                {bannerStatus.commitUrl ? (
                  <a
                    href={bannerStatus.commitUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="commit-link"
                  >
                    {bannerStatus.commitSha} ↗
                  </a>
                ) : (
                  bannerStatus.commitSha
                )}
              </span>
            )}
            {bannerStatus.time && (
              <span className="status-time">at {bannerStatus.time}</span>
            )}
          </div>
          <button
            type="button"
            className="status-dismiss"
            onClick={() => setBannerStatus(null)}
            aria-label="Dismiss notification"
          >
            ×
          </button>
        </div>
      )}

      {/* Leaderboard Section */}
      <section className="leaderboard-section">
        <div className="section-heading">
          <div>
            <p className="eyebrow">
              {activeSlot
                ? `SLOT ${activeSlot.timeLabel} • WINDOW: ${activeSlot.rangeLabel}`
                : "QUIZ RESULTS"}
            </p>
            <h2 id="leaderboard-title">
              {activeSlot
                ? `Top 10 Prize-Eligible Players (${activeSlot.fileName})`
                : "No Time Slot Selected"}
            </h2>
            <p className="ranking-note">
              Filtered by <code>isPrizeEligible: true</code> and <code>completionTime</code> in window.
              Ranked by highest score, then fastest total time.
            </p>
          </div>

          <div className="heading-controls">
            <button
              className="sync-trigger-btn"
              type="button"
              onClick={() => setSyncModalOpen(true)}
            >
              <svg
                viewBox="0 0 24 24"
                width="14"
                height="14"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
              Select & Sync Time Slot
            </button>

            {/* Re-sync active slot button if selected */}
            {activeSlot && (
              <button
                className="commit-button"
                type="button"
                onClick={() => handleSyncSlot(activeSlot)}
                disabled={loadingSlot}
                title={`Re-sync ${activeSlot.timeLabel} to GitHub`}
              >
                {loadingSlot ? "Syncing..." : `Re-sync ${activeSlot.timeLabel}`}
              </button>
            )}

            {/* Download JSON for active slot */}
            {jsonUrl && activeSlot && (
              <a
                className="json-download"
                href={jsonUrl}
                download={activeSlot.fileName}
              >
                Download {activeSlot.fileName}
              </a>
            )}
          </div>
        </div>

        {/* Quick Slot Selector Bar (if slots have been synced or for quick switching) */}
        <div className="slot-quick-bar" aria-label="Time slots list">
          <span className="slot-quick-label">Jump to Slot:</span>
          <div className="slot-quick-chips">
            {TIME_SLOTS.map((slot) => {
              const state = slotStates[slot.id];
              const isSelected = activeSlot?.id === slot.id;
              const isSynced = state?.status === "success";

              return (
                <button
                  key={slot.id}
                  type="button"
                  className={`slot-chip ${isSelected ? "selected" : ""} ${isSynced ? "synced" : ""}`}
                  onClick={() => {
                    if (state?.data) {
                      setActiveSlot(slot);
                      setParticipants(state.data);
                      setLastUpdated(new Date());
                    } else {
                      // Open sync modal focused on this slot or trigger sync
                      handleSyncSlot(slot);
                    }
                  }}
                  title={`Slot ${slot.timeLabel} (${slot.rangeLabel}) -> ${slot.fileName}`}
                >
                  <span className="chip-time">{slot.timeLabel}</span>
                  {isSynced && <span className="chip-badge">✓</span>}
                </button>
              );
            })}
          </div>
        </div>

        {error && (
          <div className="notice error-notice" role="alert">
            <strong>Sync error:</strong> {error}
          </div>
        )}

        {/* Leaderboard Table / Empty State */}
        <div className="leaderboard-card">
          {!activeSlot ? (
            <div className="empty-state idle-state">
              <div className="empty-icon-wrap" aria-hidden="true">
                <svg
                  viewBox="0 0 24 24"
                  width="36"
                  height="36"
                  fill="none"
                  stroke="#5368e8"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
              </div>
              <h3>Ready to Synchronize</h3>
              <p>
                No time slot is loaded. Click the button below to choose any
                half-hour interval between 10:00 and 18:00, query Firestore, and
                publish the top 10 prize-eligible players to GitHub.
              </p>
              <button
                type="button"
                className="btn-primary-large"
                onClick={() => setSyncModalOpen(true)}
              >
                Open Time Slot Sync Popup
              </button>
            </div>
          ) : loadingSlot ? (
            <div className="empty-state" role="status">
              <span className="loading-spinner" />
              <span>
                Querying database and synchronizing {activeSlot.timeLabel} ({activeSlot.rangeLabel})…
              </span>
            </div>
          ) : participants.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon-wrap" aria-hidden="true">
                ℹ
              </div>
              <h3>No Eligible Records Found</h3>
              <p>
                No participants with <code>summary.isPrizeEligible: true</code> and{" "}
                <code>completionTime</code> between <strong>{activeSlot.rangeLabel}</strong> were
                found in the database.
              </p>
              <p className="subtle-note">
                Target file <code>public/data/{activeSlot.fileName}</code> was updated
                with an empty leaderboard.
              </p>
            </div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">RANK</th>
                    <th scope="col">PLAYER</th>
                    <th scope="col">COMPLETION TIME</th>
                    <th scope="col">SCORE</th>
                    <th scope="col">ACCURACY</th>
                    <th scope="col">TOTAL TIME</th>
                    <th scope="col">BOOTH TESTS</th>
                    <th scope="col">PRIZE</th>
                  </tr>
                </thead>
                <tbody>
                  {participants.map((participant, index) => (
                    <tr
                      key={`${participant.id}-${participant.registeredAt}-${index}`}
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
                              {participant.email || participant.id}
                            </span>
                          </span>
                        </div>
                      </td>
                      <td>
                        <span className="completion-tag">
                          {participant.completionTime || "—"}
                        </span>
                      </td>
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
                        <strong className="time-value">
                          {formatDuration(participant.totalTimeSeconds)}
                        </strong>
                      </td>
                      <td>{participant.totalTestsAppeared ?? 0}</td>
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

        {activeSlot && participants.length > 0 && (
          <div className="results-footnote">
            <span>
              Showing top {participants.length} records for slot{" "}
              <strong>{activeSlot.timeLabel}</strong> ({activeSlot.rangeLabel})
            </span>
            <span>
              Published target: <code>{activeSlot.filePath}</code>
            </span>
          </div>
        )}
      </section>

      {/* POPUP MODAL: Time Slot Synchronization (10:00 - 18:00) */}
      {syncModalOpen && (
        <div
          className="modal-overlay"
          onClick={() => setSyncModalOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="modal-card modal-card-wide"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <div>
                <div className="modal-tag">SCHEDULED SYNC</div>
                <h3>Synchronize by Time Slot (10:00 – 18:00)</h3>
                <p className="modal-header-desc">
                  Select a half-hour interval to pull top 10 prize-eligible records
                  from Firestore and publish directly to GitHub as <code>1030.json</code>,{" "}
                  <code>1100.json</code>, etc.
                </p>
              </div>
              <button
                type="button"
                className="modal-close"
                onClick={() => setSyncModalOpen(false)}
                aria-label="Close modal"
              >
                ×
              </button>
            </div>

            <div className="modal-controls-row">
              <div className="search-box">
                <input
                  type="text"
                  placeholder="Filter slots (e.g. 10:30, 1100, 14:00)..."
                  value={slotFilter}
                  onChange={(e) => setSlotFilter(e.target.value)}
                />
              </div>

              <div className="quick-stats-pills">
                <span className="info-pill">
                  Total: <strong>{TIME_SLOTS.length} slots</strong>
                </span>
                <span className="info-pill success">
                  Synced: <strong>{syncedCount}</strong>
                </span>
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => setShowCustomTester((prev) => !prev)}
                >
                  {showCustomTester ? "Hide Custom Tester" : "⚙ Custom/Test Slot"}
                </button>
              </div>
            </div>

            {/* Optional Custom/Test Slot Tool */}
            {showCustomTester && (
              <div className="custom-tester-panel">
                <h4>Custom Slot Testing (e.g. Test Current Time)</h4>
                <div className="tester-grid">
                  <div className="tester-field">
                    <label>Start Window (HH:mm)</label>
                    <input
                      type="text"
                      value={customStart}
                      onChange={(e) => setCustomStart(e.target.value)}
                      placeholder="09:59"
                    />
                  </div>
                  <div className="tester-field">
                    <label>End Window (HH:mm)</label>
                    <input
                      type="text"
                      value={customEnd}
                      onChange={(e) => setCustomEnd(e.target.value)}
                      placeholder="10:31"
                    />
                  </div>
                  <div className="tester-field">
                    <label>File Target (public/data/[name].json)</label>
                    <input
                      type="text"
                      value={customFileId}
                      onChange={(e) => setCustomFileId(e.target.value)}
                      placeholder="1030"
                    />
                  </div>
                  <div className="tester-action">
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={handleCustomSync}
                      disabled={customSyncing}
                    >
                      {customSyncing ? "Syncing..." : "Sync Custom Window"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Grid of 17 Half-Hour Slot Panels */}
            <div className="slots-grid">
              {filteredSlots.map((slot) => {
                const state = slotStates[slot.id];
                const isSyncing = syncingSlotId === slot.id;
                const isSynced = state?.status === "success";
                const isError = state?.status === "error";

                return (
                  <div
                    key={slot.id}
                    className={`slot-card ${isSynced ? "is-synced" : ""} ${isSyncing ? "is-syncing" : ""}`}
                  >
                    <div className="slot-card-header">
                      <div className="slot-time-badge">
                        <span className="slot-time">{slot.timeLabel}</span>
                        <span className="slot-badge-24h">24H</span>
                      </div>
                      <span
                        className={`slot-status-pill ${
                          isSyncing
                            ? "status-syncing"
                            : isSynced
                            ? "status-synced"
                            : isError
                            ? "status-err"
                            : "status-idle"
                        }`}
                      >
                        {isSyncing
                          ? "Syncing…"
                          : isSynced
                          ? "Synced"
                          : isError
                          ? "Failed"
                          : "Ready"}
                      </span>
                    </div>

                    <div className="slot-card-body">
                      <div className="slot-meta-row">
                        <span className="slot-meta-label">Query Window:</span>
                        <strong className="slot-meta-val window-highlight">
                          {slot.startTimeStr} to {slot.endTimeStr}
                        </strong>
                      </div>
                      <div className="slot-meta-row">
                        <span className="slot-meta-label">GitHub Target:</span>
                        <code className="slot-filename">{slot.fileName}</code>
                      </div>

                      {isSynced && (
                        <div className="slot-sync-details">
                          <span className="sync-detail-item">
                            👥 {state.count} top players found
                          </span>
                          {state.sha && (
                            <span className="sync-detail-item sha-tag">
                              SHA: {state.sha}
                            </span>
                          )}
                          {state.time && (
                            <span className="sync-detail-item time-tag">
                              at {state.time}
                            </span>
                          )}
                        </div>
                      )}

                      {isError && (
                        <div className="slot-error-msg">
                          {state.error}
                        </div>
                      )}
                    </div>

                    <div className="slot-card-footer">
                      <button
                        type="button"
                        className="slot-sync-btn"
                        onClick={() => handleSyncSlot(slot)}
                        disabled={isSyncing || loadingSlot}
                      >
                        {isSyncing ? (
                          <>
                            <span className="btn-spinner" />
                            Syncing...
                          </>
                        ) : isSynced ? (
                          `Re-sync ${slot.timeLabel}`
                        ) : (
                          `Sync ${slot.timeLabel}`
                        )}
                      </button>

                      {isSynced && state.data && (
                        <button
                          type="button"
                          className="slot-view-btn"
                          onClick={() => {
                            setActiveSlot(slot);
                            setParticipants(state.data);
                            setLastUpdated(new Date());
                            setSyncModalOpen(false);
                          }}
                          title="View top records in dashboard table"
                        >
                          View Table
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="modal-footer">
              <span className="modal-footer-note">
                Target Repository: <strong>{DEFAULT_REPO_OWNER}/{DEFAULT_REPO_NAME}</strong> (Branch: {DEFAULT_BRANCH})
              </span>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setSyncModalOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* GitHub Token & Settings Modal */}
      {settingsOpen && (
        <div
          className="modal-overlay"
          onClick={() => setSettingsOpen(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="modal-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3>GitHub Commit Settings</h3>
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
                <code>public/data/1030.json</code>, <code>1100.json</code>, etc., directly to{" "}
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

              <div className="repo-meta-box">
                <div className="meta-item">
                  <span className="meta-label">Repository:</span>
                  <span className="meta-val">
                    {DEFAULT_REPO_OWNER}/{DEFAULT_REPO_NAME}
                  </span>
                </div>
                <div className="meta-item">
                  <span className="meta-label">Branch:</span>
                  <span className="meta-val">{DEFAULT_BRANCH}</span>
                </div>
                <div className="meta-item">
                  <span className="meta-label">Directory:</span>
                  <span className="meta-val">public/data/[time].json</span>
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

      {/* Page Footer */}
      <footer className="page-footer">
        <span>Innovation Showcase 2026 • Time-Based Quiz Leaderboard</span>
        <span>Half-Hour Synchronizer (10:00 to 18:00)</span>
      </footer>
    </main>
  );
}

export default App;
