// Noticing when people in a room are watching videos of different lengths,
// which usually means they aren't watching the same thing (another episode,
// a cut with a different intro, a trailer).

import { MAX_DURATION_SEC, type Member } from "@wps/protocol";

/** Lengths further apart than this count as different videos. Seconds. */
export const LENGTH_TOLERANCE_SEC = 2;

/**
 * The length worth reporting for a video's `duration`: rounded to a tenth of
 * a second, or 0 when it isn't known yet or has no end (a live stream).
 */
export function reportableLength(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  const rounded = Math.round(duration * 10) / 10;
  return rounded > MAX_DURATION_SEC ? 0 : rounded;
}

/** A length as the player shows it: 1:02:03, or 4:05 under an hour. */
export function formatLength(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * A warning naming everyone's video length when they differ by more than
 * `toleranceSec`, or null when they match (or fewer than two are known).
 * `me` is this tab's clientId, shown as "You".
 */
export function lengthWarning(
  members: Member[],
  me: string | null,
  toleranceSec = LENGTH_TOLERANCE_SEC,
): string | null {
  const known = members.filter((m) => (m.duration ?? 0) > 0);
  if (known.length < 2) return null;
  const lengths = known.map((m) => m.duration!);
  if (Math.max(...lengths) - Math.min(...lengths) <= toleranceSec) return null;
  const list = known
    .map(
      (m) =>
        `${m.clientId === me ? "You" : m.name} ${formatLength(m.duration!)}`,
    )
    .join(", ");
  return `Videos differ in length (${list}). You may not be watching the same thing.`;
}
