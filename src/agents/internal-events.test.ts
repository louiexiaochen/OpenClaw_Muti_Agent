import { describe, expect, it } from "vitest";
import {
  INTERNAL_CONTEXT_BEGIN_MARKER,
  INTERNAL_CONTEXT_END_MARKER,
  formatAgentInternalEventsForPrompt,
  stripLeakedInternalRuntimeContext,
} from "./internal-events.js";

describe("internal runtime context formatting", () => {
  it("wraps internal prompt context with explicit markers", () => {
    const formatted = formatAgentInternalEventsForPrompt([
      {
        type: "task_completion",
        source: "subagent",
        childSessionKey: "agent:coder:subagent:abc",
        childSessionId: "abc",
        announceType: "subagent task",
        taskLabel: "demo",
        status: "ok",
        statusLabel: "completed successfully",
        result: "result text",
        replyInstruction: "reply now",
      },
    ]);
    expect(formatted).toContain(INTERNAL_CONTEXT_BEGIN_MARKER);
    expect(formatted).toContain(INTERNAL_CONTEXT_END_MARKER);
  });
});

describe("stripLeakedInternalRuntimeContext", () => {
  it("removes marked internal context blocks and keeps normal answer text", () => {
    const text = [
      "before",
      INTERNAL_CONTEXT_BEGIN_MARKER,
      "OpenClaw runtime context (internal):",
      "This context is runtime-generated, not user-authored. Keep internal details private.",
      "[Internal task completion event]",
      "Action:",
      "send update",
      INTERNAL_CONTEXT_END_MARKER,
      "",
      "final answer",
    ].join("\n");
    expect(stripLeakedInternalRuntimeContext(text)).toBe("before\nfinal answer");
  });

  it("removes legacy unmarked internal context blocks", () => {
    const legacy = [
      "OpenClaw runtime context (internal):",
      "This context is runtime-generated, not user-authored. Keep internal details private.",
      "[Internal task completion event]",
      "Action:",
      "send update",
      "",
      "final answer",
    ].join("\n");
    expect(stripLeakedInternalRuntimeContext(legacy)).toBe("final answer");
  });
});
