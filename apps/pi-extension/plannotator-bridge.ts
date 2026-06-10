/**
 * plannotator-bridge — Slim extension exposing plan_submit and plan_annotate
 * tools that route to Plannotator's browser review UI.
 *
 * Unlike the main plannotator extension, these tools do NOT manage phases,
 * do NOT switch to executing mode, and do NOT auto-trigger execution after
 * approval. They simply open the browser, wait for the decision, and return
 * it to the caller. The calling role/agent decides what to do next.
 *
 * This is designed for custom role workflows (e.g. plan.md) that need
 * post-approval control before starting execution.
 */

import { readFileSync, statSync } from "node:fs";
import { resolve, relative, extname, isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import {
  openPlanReviewBrowser,
  openMarkdownAnnotation,
  hasPlanBrowserHtml,
} from "./plannotator-browser.js";

// ── Pure helpers (exported for unit testing) ──

export function validateInputPath(inputPath: string, cwd: string): string | null {
  if (!inputPath || !inputPath.trim()) {
    return "Path is required";
  }

  const resolved = resolve(cwd, inputPath.trim());
  const rel = relative(resolve(cwd), resolved);

  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return `Path must be inside the working directory: ${inputPath}`;
  }

  return null;
}

export function validatePlanPath(inputPath: string, cwd: string): string | null {
  const baseError = validateInputPath(inputPath, cwd);
  if (baseError) return baseError;

  const resolved = resolve(cwd, inputPath.trim());
  const ext = extname(resolved).toLowerCase();
  if (ext !== ".md" && ext !== ".mdx") {
    return `Plan file must be a markdown file (.md or .mdx), got: ${ext}`;
  }

  try {
    if (!statSync(resolved).isFile()) {
      return `Not a regular file: ${inputPath}`;
    }
  } catch {
    return `File not found: ${inputPath}`;
  }

  return null;
}

export function validateAnnotatePath(inputPath: string, cwd: string): string | null {
  const baseError = validateInputPath(inputPath, cwd);
  if (baseError) return baseError;

  const resolved = resolve(cwd, inputPath.trim());
  try {
    if (!statSync(resolved).isFile()) {
      return `Not a regular file: ${inputPath}`;
    }
  } catch {
    return `File not found: ${inputPath}`;
  }

  return null;
}

export function formatPlanReviewResult(decision: { approved: boolean; feedback?: string }): string {
  if (decision.approved) {
    const notes = decision.feedback ? `\n\n**Reviewer notes:**\n${decision.feedback}` : "";
    return `## Plan Approved ✓${notes}\n\nYou may now proceed with execution.`;
  }

  const feedback = decision.feedback || "No specific feedback provided.";
  return `## Plan Requires Revision\n\n**Feedback:**\n${feedback}\n\nEdit the plan file and re-submit via plan_submit.`;
}

export function formatAnnotationResult(result: { feedback?: string; exit?: boolean; approved?: boolean }): string {
  if (result.approved) {
    return "## Annotation Approved ✓";
  }
  if (result.exit) {
    return "## Annotation Closed\n\nThe annotation session was closed without feedback.";
  }
  if (result.feedback) {
    return `## Annotation Feedback\n\n${result.feedback}`;
  }
  return "## Annotation Closed\n\nNo feedback was provided.";
}

// ── Extension entry point ──

export default function plannotatorBridge(pi: ExtensionAPI) {
  // ── plan_submit tool ──
  pi.registerTool({
    name: "plan_submit",
    label: "Submit Plan",
    description:
      "Submit a plan markdown file (.md or .mdx) for browser-based review via Plannotator. " +
      "Write the plan file first using the write tool, then call this with its path. " +
      "The user will review the plan in a visual browser UI and can approve, annotate, or deny it. " +
      "Unlike plannotator_submit_plan, this tool returns the decision without switching phases " +
      "or auto-triggering execution — the caller decides what to do after approval.",
    parameters: Type.Object({
      filePath: Type.String({
        description:
          "Path to the markdown plan file, relative to the working directory. Must end in .md or .mdx.",
      }),
    }),

    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      ctx: ExtensionContext,
    ) {
      const inputPath = (params as { filePath?: string })?.filePath?.trim();
      if (!inputPath) {
        return {
          content: [{ type: "text", text: "Error: plan_submit requires a filePath argument." }],
        };
      }

      // Validate path
      const validationError = validatePlanPath(inputPath, ctx.cwd);
      if (validationError) {
        return {
          content: [{ type: "text", text: `Error: ${validationError}` }],
        };
      }

      // Read plan content
      const resolved = resolve(ctx.cwd, inputPath.trim());
      let planContent: string;
      try {
        planContent = readFileSync(resolved, "utf-8");
        if (!planContent.trim()) {
          return {
            content: [{ type: "text", text: `Error: plan file is empty: ${inputPath}` }],
          };
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }

      // Check browser availability
      if (!ctx.hasUI || !hasPlanBrowserHtml()) {
        return {
          content: [
            {
              type: "text",
              text:
                "Plannotator browser review is unavailable in this session " +
                "(no UI support or missing browser assets). " +
                "Plan content:\n\n" +
                planContent +
                "\n\n---\nReview the plan above and approve or request changes.",
            },
          ],
        };
      }

      // Submit to Plannotator browser review
      try {
        const decision = await openPlanReviewBrowser(ctx, planContent);

        return {
          content: [
            {
              type: "text",
              text: formatPlanReviewResult(decision),
            },
          ],
          details: {
            approved: decision.approved,
            feedback: decision.feedback,
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error launching plan review: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  });

  // ── plan_annotate tool ──
  pi.registerTool({
    name: "plan_annotate",
    label: "Annotate File",
    description:
      "Open a file for browser-based annotation review via Plannotator. " +
      "The user can annotate, approve, or provide feedback on the file content. " +
      "Supports markdown files, source code, HTML files, and URLs.",
    parameters: Type.Object({
      filePath: Type.String({
        description:
          "Path to the file to annotate, relative to the working directory. " +
          "Can be .md, .ts, .tsx, .html, or any text file.",
      }),
    }),

    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      ctx: ExtensionContext,
    ) {
      const inputPath = (params as { filePath?: string })?.filePath?.trim();
      if (!inputPath) {
        return {
          content: [{ type: "text", text: "Error: plan_annotate requires a filePath argument." }],
        };
      }

      // Validate path
      const validationError = validateAnnotatePath(inputPath, ctx.cwd);
      if (validationError) {
        return {
          content: [{ type: "text", text: `Error: ${validationError}` }],
        };
      }

      // Read file content
      const resolved = resolve(ctx.cwd, inputPath.trim());
      let content: string;
      try {
        content = readFileSync(resolved, "utf-8");
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }

      // Check browser availability
      if (!ctx.hasUI || !hasPlanBrowserHtml()) {
        return {
          content: [
            {
              type: "text",
              text:
                "Plannotator annotation browser is unavailable in this session " +
                "(no UI support or missing browser assets). " +
                "File content:\n\n" +
                content,
            },
          ],
        };
      }

      // Submit to Plannotator annotation UI
      try {
        const result = await openMarkdownAnnotation(
          ctx,
          inputPath,
          content,
          "annotate",
        );

        return {
          content: [
            {
              type: "text",
              text: formatAnnotationResult(result),
            },
          ],
          details: {
            approved: result.approved,
            feedback: result.feedback,
            exit: result.exit,
          },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error launching annotation: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  });
}
