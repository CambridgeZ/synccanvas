/**
 * Lamport Logical Clock & Total-Order Stamp Comparator
 *
 * Total order over concurrent writes:
 *   Stamp(l1, c1) > Stamp(l2, c2) iff l1 > l2 || (l1 === l2 && c1 > c2)
 *
 * Because clientIds are unique per session/replica, distinct writes form a strict total order,
 * guaranteeing that register joins are commutative, associative, and idempotent.
 */
export class LamportClock {
  private counter: number;
  public readonly clientId: string;

  constructor(clientId: string, initialValue = 0) {
    this.clientId = clientId;
    this.counter = Math.max(0, Math.floor(initialValue));
  }

  public get value(): number {
    return this.counter;
  }

  /** Advance logical clock for a new local mutation */
  public tick(): number {
    this.counter += 1;
    return this.counter;
  }

  /** Merge remote logical timestamp and advance */
  public witness(remoteLamport: number): number {
    if (remoteLamport > this.counter) {
      this.counter = remoteLamport;
    }
    this.counter += 1;
    return this.counter;
  }

  /** Align clock floor without generating a new local write event (e.g. snapshot load) */
  public syncFloor(remoteLamport: number): void {
    if (remoteLamport > this.counter) {
      this.counter = remoteLamport;
    }
  }
}

/**
 * Returns > 0 if (aLamport, aClient) wins over (bLamport, bClient),
 * < 0 if it loses, and 0 if identical.
 */
export function compareStamp(
  aLamport: number,
  aClient: string,
  bLamport: number,
  bClient: string,
): number {
  if (aLamport !== bLamport) {
    return aLamport - bLamport;
  }
  if (aClient === bClient) {
    return 0;
  }
  return aClient > bClient ? 1 : -1;
}

export function isIncomingNewer(
  incomingLamport: number,
  incomingClient: string,
  currentLamport: number,
  currentClient: string,
): boolean {
  return compareStamp(incomingLamport, incomingClient, currentLamport, currentClient) > 0;
}
