import { describe, expect, it } from "vitest";
import { DEMO_QUESTIONS } from "@/lib/demo-fixture";

// The demo quiz is played in front of OWASP audiences, so its answer key has
// to agree with the OWASP Top 10: A03:2021 Injection includes Cross-Site
// Scripting, so XSS is an injection vulnerability here too.
describe("demo quiz answer key", () => {
  it("counts SQL injection, command injection and XSS as injection, and broken access control not", () => {
    const q = DEMO_QUESTIONS.find((x) => x.id === "injection-types");
    if (!q) throw new Error("injection-types missing from the demo quiz");
    const label = (id: string) => q.choices.find((c) => c.id === id)?.label;
    expect(q.correct.map(label).sort()).toEqual(["Command Injection", "Cross-Site Scripting", "SQL Injection"]);
  });
});
