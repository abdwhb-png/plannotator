import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  validateInputPath,
  validatePlanPath,
  validateAnnotatePath,
  formatPlanReviewResult,
  formatAnnotationResult,
} from "./plannotator-bridge";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "plannotator-bridge-test-"));
  writeFileSync(join(tmpDir, "plan.md"), "# Test Plan\n\nStep 1: do something");
  writeFileSync(join(tmpDir, "plan.mdx"), "# Test MDX Plan");
  writeFileSync(join(tmpDir, "source.ts"), 'export const x = 1;\n');
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── validateInputPath ──

describe("validateInputPath", () => {
  test("rejects empty path", () => {
    expect(validateInputPath("", tmpDir)).toBe("Path is required");
    expect(validateInputPath("  ", tmpDir)).toBe("Path is required");
  });

  test("rejects path traversal outside cwd", () => {
    expect(validateInputPath("../etc/passwd", tmpDir)).toMatch(/Path must be inside/);
    expect(validateInputPath("/etc/passwd", tmpDir)).toMatch(/Path must be inside/);
  });

  test("allows relative path inside cwd", () => {
    expect(validateInputPath("plan.md", tmpDir)).toBeNull();
    expect(validateInputPath("./plan.md", tmpDir)).toBeNull();
  });

  test("rejects absolute path", () => {
    expect(validateInputPath("/etc/passwd", tmpDir)).toMatch(/Path must be inside/);
  });
});

// ── validatePlanPath ──

describe("validatePlanPath", () => {
  test("rejects non-markdown extensions", () => {
    expect(validatePlanPath("source.ts", tmpDir)).toMatch(/must be a markdown file/);
    expect(validatePlanPath("data.json", tmpDir)).toMatch(/must be a markdown file/);
  });

  test("accepts .md and .mdx files", () => {
    expect(validatePlanPath("plan.md", tmpDir)).toBeNull();
    expect(validatePlanPath("plan.mdx", tmpDir)).toBeNull();
  });

  test("rejects missing files", () => {
    expect(validatePlanPath("nonexistent.md", tmpDir)).toMatch(/File not found/);
  });

  test("rejects path traversal even with valid extension", () => {
    expect(validatePlanPath("../plan.md", tmpDir)).toMatch(/Path must be inside/);
  });
});

// ── validateAnnotatePath ──

describe("validateAnnotatePath", () => {
  test("accepts any file type", () => {
    expect(validateAnnotatePath("source.ts", tmpDir)).toBeNull();
    expect(validateAnnotatePath("plan.md", tmpDir)).toBeNull();
  });

  test("rejects missing files", () => {
    expect(validateAnnotatePath("missing.ts", tmpDir)).toMatch(/File not found/);
  });

  test("rejects path traversal", () => {
    expect(validateAnnotatePath("../etc/hosts", tmpDir)).toMatch(/Path must be inside/);
  });

  test("rejects empty path", () => {
    expect(validateAnnotatePath("", tmpDir)).toBe("Path is required");
  });
});

// ── formatPlanReviewResult ──

describe("formatPlanReviewResult", () => {
  test("returns approved message with optional notes", () => {
    const result = formatPlanReviewResult({ approved: true });
    expect(result).toContain("Plan Approved");
    expect(result).toContain("proceed with execution");

    const withNotes = formatPlanReviewResult({ approved: true, feedback: "Fix step 3" });
    expect(withNotes).toContain("Fix step 3");
  });

  test("returns revision message when denied", () => {
    const result = formatPlanReviewResult({ approved: false });
    expect(result).toContain("Requires Revision");

    const withFeedback = formatPlanReviewResult({ approved: false, feedback: "Too vague" });
    expect(withFeedback).toContain("Too vague");
  });

  test("falls back to default feedback string", () => {
    const result = formatPlanReviewResult({ approved: false });
    expect(result).toContain("No specific feedback provided");
  });
});

// ── formatAnnotationResult ──

describe("formatAnnotationResult", () => {
  test("approved", () => {
    expect(formatAnnotationResult({ approved: true })).toContain("Approved");
  });

  test("exit without feedback", () => {
    const result = formatAnnotationResult({ exit: true });
    expect(result).toContain("Closed");
  });

  test("feedback provided", () => {
    const result = formatAnnotationResult({ feedback: "Great work" });
    expect(result).toContain("Great work");
  });

  test("fallback for no data", () => {
    const result = formatAnnotationResult({});
    expect(result).toContain("No feedback was provided");
  });
});