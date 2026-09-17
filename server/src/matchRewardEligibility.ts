/** Capture once from the authoritative roster, before charging entry.
 * A later disconnect/takeover must not change a human-started match's eligibility.
 * Display names, VIP appearance and current connection state are not identity.
 */
export function allHumanStartingRoster(
  totalSeats: number,
  humanUsers: ReadonlyMap<number, string>,
  botSeats: Iterable<number>,
): boolean {
  if (totalSeats !== 2 && totalSeats !== 4) return false;
  if (humanUsers.size !== totalSeats || [...botSeats].length !== 0) return false;
  const identities = new Set<string>();
  for (let seat = 0; seat < totalSeats; seat++) {
    const uid = humanUsers.get(seat)?.trim();
    if (!uid || identities.has(uid)) return false;
    identities.add(uid);
  }
  return true;
}
