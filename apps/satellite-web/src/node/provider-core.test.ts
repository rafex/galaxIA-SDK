import { describe, expect, it } from "vitest";
import { AssignmentBook, ASSIGNMENT_GRACE_MS, offerDeadline } from "./provider-core.js";

const ME = "did:key:me";
const NAV = "did:key:nav";
const offer = (over = {}) => ({ missionId: "m1", navigatorDid: NAV, timestamp: 1_000, bidDeadlineMs: 2_000, ...over });
const assign = (over = {}) => ({ missionId: "m1", navigatorDid: NAV, assignedProvider: ME, timestamp: 1_500, ...over });

describe("AssignmentBook (DEC-0096)", () => {
  it("rechaza sin oferta o sin asignación", () => {
    const book = new AssignmentBook(ME);
    expect(book.consume("m1", NAV, 2_000).ok).toBe(false);
    book.recordOffer(offer());
    expect(book.consume("m1", NAV, 2_000)).toEqual({ ok: false, reason: "sin asignación verificada" });
  });

  it("acepta oferta + asignación del mismo Navigator y la consume una sola vez", () => {
    const book = new AssignmentBook(ME);
    book.recordOffer(offer());
    book.recordAssign(assign());
    expect(book.consume("m1", NAV, 2_500)).toEqual({ ok: true });
    expect(book.consume("m1", NAV, 2_500)).toEqual({ ok: false, reason: "la misión ya se atendió" });
  });

  it("rechaza si la asignación es de otro Navigator o la oferta no es del conectado", () => {
    const book = new AssignmentBook(ME);
    book.recordOffer(offer());
    book.recordAssign(assign({ navigatorDid: "did:key:otro" }));
    expect(book.consume("m1", NAV, 2_500).ok).toBe(false);
    const other = new AssignmentBook(ME);
    other.recordOffer(offer());
    other.recordAssign(assign());
    expect(other.consume("m1", "did:key:otro", 2_500).ok).toBe(false);
  });

  it("ignora asignaciones dirigidas a otro provider", () => {
    const book = new AssignmentBook(ME);
    book.recordOffer(offer());
    book.recordAssign(assign({ assignedProvider: "did:key:x" }));
    expect(book.consume("m1", NAV, 2_500).ok).toBe(false);
  });

  it("vence pasado el plazo más la gracia", () => {
    const book = new AssignmentBook(ME);
    book.recordOffer(offer());
    book.recordAssign(assign());
    expect(book.consume("m1", NAV, 3_000 + ASSIGNMENT_GRACE_MS + 1)).toEqual({ ok: false, reason: "la asignación venció" });
  });

  it("entiende el plazo relativo (Rust) y el absoluto (IDL)", () => {
    expect(offerDeadline(offer({ timestamp: 5_000, bidDeadlineMs: 2_000 }))).toBe(7_000);
    expect(offerDeadline(offer({ bidDeadlineMs: 1_800_000_000_000 }))).toBe(1_800_000_000_000);
  });

  it("espera la asignación que llega tarde y se rinde sin ella", async () => {
    const book = new AssignmentBook(ME);
    book.recordOffer(offer());
    const waiting = book.waitForAssign("m1", 500);
    setTimeout(() => book.recordAssign(assign()), 20);
    await waiting;
    expect(book.consume("m1", NAV, 2_500).ok).toBe(true);
    const lonely = new AssignmentBook(ME);
    const started = Date.now();
    await lonely.waitForAssign("zz", 30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });
});
