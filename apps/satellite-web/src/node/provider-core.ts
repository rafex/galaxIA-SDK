/**
 * Lógica del provider móvil independiente de libp2p (DEC-0096): el nodo solo
 * ejecuta una misión si hay una oferta y una asignación válidas, del mismo
 * Navigator, vigentes y sin usar antes.
 */

/** Gracia tras el plazo de pujas para aceptar el stream (la subasta tarda). */
export const ASSIGNMENT_GRACE_MS = 60_000;
/** Cuánto espera el provider una asignación que aún no llegó por GossipSub. */
export const ASSIGNMENT_WAIT_MS = 3_000;
const MAX_REMEMBERED = 64;

export interface VerifiedOffer {
  missionId: string;
  navigatorDid: string;
  timestamp: number;
  bidDeadlineMs: number;
}

export interface VerifiedAssign {
  missionId: string;
  navigatorDid: string;
  assignedProvider: string;
  timestamp: number;
}

/** `bid_deadline_ms` llega relativo (Rust) o como Unix ms (el IDL). */
export function offerDeadline(offer: VerifiedOffer): number {
  return offer.bidDeadlineMs > 1e12 ? offer.bidDeadlineMs : offer.timestamp + offer.bidDeadlineMs;
}

export type Authorization = { ok: true } | { ok: false; reason: string };

export class AssignmentBook {
  private offers = new Map<string, VerifiedOffer>();
  private assigns = new Map<string, VerifiedAssign>();
  private used = new Set<string>();
  private waiters = new Map<string, Array<() => void>>();

  constructor(private readonly ownDid: string) {}

  /** Solo entran ofertas con firma ya verificada. */
  recordOffer(offer: VerifiedOffer): void {
    this.remember(this.offers, offer.missionId, offer);
  }

  /** Solo entran asignaciones con firma ya verificada y dirigidas a este nodo. */
  recordAssign(assign: VerifiedAssign): void {
    if (assign.assignedProvider !== this.ownDid) return;
    this.remember(this.assigns, assign.missionId, assign);
    for (const wake of this.waiters.get(assign.missionId) ?? []) wake();
    this.waiters.delete(assign.missionId);
  }

  private remember<T>(map: Map<string, T>, key: string, value: T): void {
    map.set(key, value);
    while (map.size > MAX_REMEMBERED) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  /**
   * Valida la cadena oferta → asignación de `missionId` y la consume (un solo
   * uso). `connectedNavigatorDid` es el Navigator verificado de la conexión.
   */
  consume(missionId: string, connectedNavigatorDid: string, now: number): Authorization {
    if (this.used.has(missionId)) return { ok: false, reason: "la misión ya se atendió" };
    const offer = this.offers.get(missionId);
    const assign = this.assigns.get(missionId);
    if (!offer) return { ok: false, reason: "sin oferta verificada" };
    if (!assign) return { ok: false, reason: "sin asignación verificada" };
    if (offer.navigatorDid !== connectedNavigatorDid) return { ok: false, reason: "la oferta no es del Navigator conectado" };
    if (assign.navigatorDid !== offer.navigatorDid) return { ok: false, reason: "la asignación es de otro Navigator" };
    if (assign.assignedProvider !== this.ownDid) return { ok: false, reason: "la asignación es de otro provider" };
    if (now > offerDeadline(offer) + ASSIGNMENT_GRACE_MS) return { ok: false, reason: "la asignación venció" };
    this.used.add(missionId);
    return { ok: true };
  }

  /** Espera hasta `timeoutMs` a que llegue la asignación de `missionId`. */
  async waitForAssign(missionId: string, timeoutMs: number): Promise<void> {
    if (this.assigns.has(missionId)) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      const list = this.waiters.get(missionId) ?? [];
      list.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.waiters.set(missionId, list);
    });
  }
}
