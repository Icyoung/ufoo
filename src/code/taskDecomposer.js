/**
 * Task decomposition and progress reporting for ucode
 * Based on Claude Code's design principles
 */

const { runNativeAgentTask } = require("./nativeRunner");

/**
 * Decompose a bug fix task into manageable steps
 */
function decomposeBugFixTask(task) {
  const steps = [];

  // Analyze task to determine if it's a bug fix
  const isBugFix = /fix|bug|issue|problem|error|broken|doesn't work|not work/i.test(task);

  if (isBugFix) {
    steps.push({
      id: "identify",
      name: "Identifying the issue",
      prompt: `Identify the specific problem: ${task}\n\nBe concise. Focus only on:\n1. What is broken\n2. What file/function is likely involved\n3. What the expected behavior should be\n\nDo NOT analyze entire codebases. Find the specific issue quickly.`,
      timeoutMs: 30000, // 30 seconds
      earlyExit: true,
    });

    steps.push({
      id: "locate",
      name: "Locating relevant code",
      prompt: `Based on the identified issue, find the exact location of the bug.\n\nSearch for and read ONLY the relevant function/file. Stop as soon as you find the problematic code.`,
      timeoutMs: 30000,
      earlyExit: true,
    });

    steps.push({
      id: "fix",
      name: "Applying the fix",
      prompt: `Apply the minimal fix needed. Do NOT refactor or improve unrelated code. Just fix the specific issue.`,
      timeoutMs: 60000,
      earlyExit: false,
    });

    steps.push({
      id: "verify",
      name: "Verifying the fix",
      prompt: `Verify the fix resolves the issue. Check that:\n1. The specific problem is fixed\n2. No new issues were introduced\n\nBe brief.`,
      timeoutMs: 20000,
      earlyExit: false,
    });
  } else {
    // For non-bug tasks, use a single step
    steps.push({
      id: "execute",
      name: "Executing task",
      prompt: task,
      timeoutMs: 120000,
      earlyExit: false,
    });
  }

  return steps;
}

/**
 * Run a task with decomposition and progress reporting
 */
async function runDecomposedTask({
  task,
  state,
  onProgress,
  onToolEvent,
  signal,
  workspaceRoot,
  provider,
  model,
  systemPrompt,
  messages = [],
  sessionId = "",
}) {
  const steps = decomposeBugFixTask(task);
  const results = [];
  let aborted = false;

  // Check if already aborted
  if (signal && signal.aborted) {
    return {
      ok: false,
      error: "Task aborted",
      results,
    };
  }

  for (const step of steps) {
    // Check abort signal
    if (signal && signal.aborted) {
      aborted = true;
      break;
    }

    // Report progress
    if (onProgress) {
      onProgress({
        type: "step_start",
        step: step.id,
        name: step.name,
        current: steps.indexOf(step) + 1,
        total: steps.length,
      });
    }

    try {
      // Run the step with its own timeout
      const stepResult = await runNativeAgentTask({
        workspaceRoot,
        provider,
        model,
        prompt: step.prompt,
        systemPrompt,
        messages,
        sessionId,
        timeoutMs: step.timeoutMs,
        onToolEvent,
        signal,
      });

      results.push({
        step: step.id,
        name: step.name,
        result: stepResult,
      });

      // Report step completion
      if (onProgress) {
        onProgress({
          type: "step_complete",
          step: step.id,
          name: step.name,
          success: stepResult.ok,
        });
      }

      // Early exit if solution found
      if (step.earlyExit && stepResult.ok) {
        const output = String(stepResult.output || "").toLowerCase();
        if (output.includes("fixed") || output.includes("resolved") || output.includes("solution")) {
          // Found the fix early, skip remaining analysis
          break;
        }
      }

      // Stop on any step failure. A failed tool/provider call means the
      // current plan is no longer reliable, and continuing can trigger loops.
      if (!stepResult.ok) {
        return {
          ok: false,
          error: `Failed at ${step.name}: ${stepResult.error}`,
          results,
        };
      }

    } catch (err) {
      // Report step error
      if (onProgress) {
        onProgress({
          type: "step_error",
          step: step.id,
          name: step.name,
          error: err.message,
        });
      }

      return {
        ok: false,
        error: `Error at ${step.name}: ${err.message}`,
        results,
      };
    }
  }

  if (aborted) {
    return {
      ok: false,
      error: "Task aborted by user",
      results,
    };
  }

  // Compile final summary
  const summary = compileSummary(results);

  return {
    ok: true,
    summary,
    results,
  };
}

/**
 * Compile results into a concise summary
 */
function compileSummary(results) {
  if (!results || results.length === 0) {
    return "No results";
  }

  // Extract key information from each step
  const summaryParts = [];

  for (const stepResult of results) {
    if (stepResult.result && stepResult.result.ok) {
      const output = String(stepResult.result.output || "").trim();

      // Extract only the important parts (skip verbose thinking)
      const lines = output.split("\n");
      const keyLines = lines.filter(line => {
        const lower = line.toLowerCase();
        // Keep lines with actual findings/actions
        return (
          lower.includes("fixed") ||
          lower.includes("found") ||
          lower.includes("issue") ||
          lower.includes("problem") ||
          lower.includes("solution") ||
          lower.includes("edit") ||
          lower.includes("changed") ||
          line.includes("src/") ||
          line.includes("✓") ||
          line.includes("✅")
        );
      });

      if (keyLines.length > 0) {
        summaryParts.push(keyLines.slice(0, 3).join("\n"));
      }
    }
  }

  return summaryParts.join("\n\n");
}

/**
 * Create a progress reporter that sends updates via bus
 */
function createBusProgressReporter(shell, publisher) {
  let lastReportTime = Date.now();
  const MIN_REPORT_INTERVAL = 5000; // Report at most every 5 seconds

  return (progress) => {
    const now = Date.now();
    if (now - lastReportTime < MIN_REPORT_INTERVAL) {
      return; // Throttle progress reports
    }

    lastReportTime = now;

    if (progress.type === "step_start") {
      const message = `⏳ ${progress.name} (${progress.current}/${progress.total})`;
      shell(`ufoo bus send ${publisher} ${JSON.stringify(message)}`);
    } else if (progress.type === "step_complete" && progress.success) {
      const message = `✅ ${progress.name} completed`;
      shell(`ufoo bus send ${publisher} ${JSON.stringify(message)}`);
    }
  };
}

module.exports = {
  decomposeBugFixTask,
  runDecomposedTask,
  compileSummary,
  createBusProgressReporter,
};
