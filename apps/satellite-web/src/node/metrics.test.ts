import { describe, expect, it } from "vitest";
import { MissionLog, busyPercent } from "./metrics.js";

describe("datos operativos", () => {
  it("resume estados y tiempos sin guardar contenido", () => {
    const log = new MissionLog();
    log.touch("aaaaaaaa-1111", { phase: "puja" }, 1_000);
    log.touch("bbbbbbbb-2222", { phase: "ok", totalMs: 120, computeMs: 3 }, 2_000);
    log.touch("cccccccc-3333", { phase: "error", totalMs: 300 }, 3_000);
    log.touch("dddddddd-4444", { phase: "rechazada" }, 4_000);
    const s = log.summary();
    expect(s).toMatchObject({ bids: 4, ok: 1, error: 1, rejected: 1, assigned: 3, avgMs: 210, maxMs: 300 });
    expect(log.list()[0].id).toBe("dddddddd");
    // El registro solo tiene campos operativos.
    expect(Object.keys(log.list(1)[0]).sort()).toEqual(["id", "phase", "startedAt"]);
  });

  it("actualiza la misma misión y acota la memoria", () => {
    const log = new MissionLog();
    log.touch("abcdefgh-1", { phase: "puja" }, 1);
    log.touch("abcdefgh-1", { phase: "ejecutando" }, 2);
    expect(log.list()).toHaveLength(1);
    expect(log.list()[0]).toMatchObject({ phase: "ejecutando", startedAt: 1 });
    for (let i = 0; i < 80; i += 1) log.touch(`m${String(i).padStart(7, "0")}`, {}, i);
    expect(log.list(100).length).toBeLessThanOrEqual(50);
  });

  it("calcula la ocupación del motor en una ventana", () => {
    expect(busyPercent([{ start: 0, end: 6_000 }], 60_000, 60_000)).toBe(10);
    expect(busyPercent([{ start: -10_000, end: 3_000 }], 60_000, 60_000)).toBe(5);
    expect(busyPercent([], 60_000, 60_000)).toBe(0);
  });
});
