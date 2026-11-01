/**
 * Time slots definition and utilities for Quiz Leaderboard synchronization.
 * Half-hour intervals between 10:00 and 18:00 (24-hour format).
 * Each slot has a query window: (slotTime - 31m) to (slotTime + 1m).
 * Target file: public/data/{HHmm}.json
 */

export function generateTimeSlots() {
  const slots = [];
  // 10:00 to 18:00 every 30 minutes in minutes from midnight
  const START_MINUTE = 10 * 60; // 600 (10:00)
  const END_MINUTE = 18 * 60;   // 1080 (18:00)
  const STEP_MINUTE = 30;

  for (let m = START_MINUTE; m <= END_MINUTE; m += STEP_MINUTE) {
    const slotHour = Math.floor(m / 60);
    const slotMinute = m % 60;
    const timeLabel = `${String(slotHour).padStart(2, "0")}:${String(slotMinute).padStart(2, "0")}`;
    const id = `${String(slotHour).padStart(2, "0")}${String(slotMinute).padStart(2, "0")}`;
    const fileName = `${id}.json`;
    const filePath = `public/data/${fileName}`;

    // Window: 31 minutes before to 1 minute after
    const startM = m - 31;
    const endM = m + 1;

    const startH = Math.floor(startM / 60);
    const startMin = startM % 60;
    const endH = Math.floor(endM / 60);
    const endMin = endM % 60;

    const startTimeStr = `${String(startH).padStart(2, "0")}:${String(startMin).padStart(2, "0")}`;
    const endTimeStr = `${String(endH).padStart(2, "0")}:${String(endMin).padStart(2, "0")}`;

    slots.push({
      id,
      timeLabel,         // e.g. "10:30" (24-hr format)
      slotHour,
      slotMinute,
      fileName,          // e.g. "1030.json"
      filePath,          // e.g. "public/data/1030.json"
      startMinutes: startM,
      endMinutes: endM,
      startTimeStr,      // e.g. "09:59"
      endTimeStr,        // e.g. "10:31"
      rangeLabel: `${startTimeStr} to ${endTimeStr}`,
    });
  }

  return slots;
}

export const TIME_SLOTS = generateTimeSlots();
