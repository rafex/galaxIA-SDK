/**
 * Datos operativos del nodo móvil para mostrar en pantalla. Por diseño no
 * guardan nada del contenido de una misión (ni expresión ni resultado ni
 * códigos de error del cálculo): solo estado, tiempos y conteos.
 */

export type MissionPhase = "puja" | "asignada" | "ejecutando" | "ok" | "error" | "rechazada";

export interface MissionRecord {
  /** Primeros 8 caracteres del id de la misión (UUID aleatorio, sin contenido). */
  id: string;
  phase: MissionPhase;
  /** Cuándo apareció la oferta para este nodo (ms epoch). */
  startedAt: number;
  /** Duración total desde la recepción de la llamada hasta responder. */
  totalMs?: number;
  /** Tiempo dentro del motor (WASM). */
  computeMs?: number;
}

export interface MissionSummary {
  bids: number;
  assigned: number;
  ok: number;
  error: number;
  rejected: number;
  running: number;
  avgMs?: number;
  p50Ms?: number;
  maxMs?: number;
}

const MAX_RECORDS = 50;

export class MissionLog {
  private records = new Map<string, MissionRecord>();

  /** Crea o actualiza el registro de una misión. */
  touch(missionId: string, patch: Partial<Omit<MissionRecord, "id">>, now = Date.now()): void {
    const id = missionId.slice(0, 8);
    const current = this.records.get(id) ?? { id, phase: "puja" as MissionPhase, startedAt: now };
    this.records.set(id, { ...current, ...patch });
    while (this.records.size > MAX_RECORDS) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }

  /** Más recientes primero. */
  list(limit = 10): MissionRecord[] {
    return [...this.records.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
  }

  summary(): MissionSummary {
    const all = [...this.records.values()];
    const done = all.filter((r) => r.totalMs !== undefined).map((r) => r.totalMs as number).sort((a, b) => a - b);
    return {
      bids: all.length,
      assigned: all.filter((r) => r.phase !== "puja").length,
      ok: all.filter((r) => r.phase === "ok").length,
      error: all.filter((r) => r.phase === "error").length,
      rejected: all.filter((r) => r.phase === "rechazada").length,
      running: all.filter((r) => r.phase === "ejecutando").length,
      avgMs: done.length ? Math.round(done.reduce((a, b) => a + b, 0) / done.length) : undefined,
      p50Ms: done.length ? done[Math.floor((done.length - 1) / 2)] : undefined,
      maxMs: done.length ? done[done.length - 1] : undefined,
    };
  }
}

export interface ResourceSnapshot {
  /** Retraso medio del hilo principal (ms): proxy de la carga de CPU. */
  loopLagMs?: number;
  /** Porcentaje del último minuto que el motor estuvo calculando. */
  engineBusyPct: number;
  heapUsedMb?: number;
  heapLimitMb?: number;
  cores?: number;
  deviceMemoryGb?: number;
  batteryPct?: number;
  charging?: boolean;
  network?: string;
}

interface BatteryManagerLike {
  level: number;
  charging: boolean;
}

/** Porcentaje de ocupación del motor en una ventana (puro, para pruebas). */
export function busyPercent(intervals: Array<{ start: number; end: number }>, now: number, windowMs: number): number {
  const from = now - windowMs;
  const busy = intervals.reduce((sum, i) => sum + Math.max(0, Math.min(i.end, now) - Math.max(i.start, from)), 0);
  return Math.min(100, Math.round((busy / windowMs) * 1000) / 10);
}

/** Mide recursos con las APIs que el navegador ofrezca (no todas existen). */
export class ResourceSampler {
  private lag: number | undefined;
  private busy: Array<{ start: number; end: number }> = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private battery: BatteryManagerLike | undefined;
  private static readonly WINDOW_MS = 60_000;
  private static readonly TICK_MS = 1_000;

  start(): void {
    let expected = performance.now() + ResourceSampler.TICK_MS;
    this.timer = setInterval(() => {
      const now = performance.now();
      const drift = Math.max(0, now - expected);
      this.lag = this.lag === undefined ? drift : this.lag * 0.7 + drift * 0.3;
      expected = now + ResourceSampler.TICK_MS;
    }, ResourceSampler.TICK_MS);
    const nav = navigator as unknown as { getBattery?: () => Promise<BatteryManagerLike> };
    void nav.getBattery?.().then((b) => (this.battery = b)).catch(() => undefined);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Registra un intervalo en que el motor estuvo calculando. */
  recordCompute(startMs: number, endMs: number): void {
    this.busy.push({ start: startMs, end: endMs });
    const cutoff = performance.now() - ResourceSampler.WINDOW_MS;
    this.busy = this.busy.filter((i) => i.end > cutoff);
  }

  snapshot(): ResourceSnapshot {
    const perf = performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } };
    const nav = navigator as unknown as {
      hardwareConcurrency?: number;
      deviceMemory?: number;
      connection?: { effectiveType?: string; rtt?: number };
    };
    const mb = (bytes: number) => Math.round(bytes / 1_048_576);
    return {
      loopLagMs: this.lag === undefined ? undefined : Math.round(this.lag * 10) / 10,
      engineBusyPct: busyPercent(this.busy, performance.now(), ResourceSampler.WINDOW_MS),
      heapUsedMb: perf.memory ? mb(perf.memory.usedJSHeapSize) : undefined,
      heapLimitMb: perf.memory ? mb(perf.memory.jsHeapSizeLimit) : undefined,
      cores: nav.hardwareConcurrency,
      deviceMemoryGb: nav.deviceMemory,
      batteryPct: this.battery ? Math.round(this.battery.level * 100) : undefined,
      charging: this.battery?.charging,
      network: nav.connection?.effectiveType
        ? `${nav.connection.effectiveType}${nav.connection.rtt !== undefined ? ` · rtt ${nav.connection.rtt} ms` : ""}`
        : undefined,
    };
  }
}
