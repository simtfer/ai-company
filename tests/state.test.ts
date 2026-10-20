import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  isTerminal,
} from "../src/domain/state";

describe("task state machine", () => {
  it("allows the normal assignment -> running -> done path", () => {
    expect(canTransition("assigned", "running")).toBe(true);
    expect(canTransition("running", "done")).toBe(true);
    expect(canTransition("assigned", "done")).toBe(false);
  });

  it("allows continuing a done task and cancelling terminal states", () => {
    expect(canTransition("done", "running")).toBe(true);
    expect(canTransition("done", "cancelled")).toBe(true);
    expect(() => assertTransition("cancelled", "running")).toThrow(
      /Invalid task transition/,
    );
  });

  it("treats waiting_approval as a terminal wait state", () => {
    expect(isTerminal("waiting_approval")).toBe(true);
    expect(isTerminal("running")).toBe(false);
  });
});
