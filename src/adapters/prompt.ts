import type { ContextPack, Task } from "../domain/schema";

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord | null {
  return typeof value === "object" && value !== null
    ? (value as AnyRecord)
    : null;
}

export function buildEmployeePrompt(
  task: Task,
  context: ContextPack,
  instruction: string,
): string {
  const memory = Array.isArray(context.memory)
    ? context.memory
        .map((entry) => {
          const row = asRecord(entry);
          return row ? `${String(row.key)}: ${JSON.stringify(row.value)}` : "";
        })
        .filter(Boolean)
        .slice(-6)
        .join("\n")
    : "";
  const related = Array.isArray(context.related_reports)
    ? context.related_reports
        .map((entry) => {
          const row = asRecord(entry);
          return row ? `- ${String(row.task_id)}: ${String(row.summary)}` : "";
        })
        .filter(Boolean)
        .slice(-4)
        .join("\n")
    : "";
  return [
    "You are an employee of an AI company. Work only in the current directory.",
    "Do the task directly. Do not ask the human questions; if blocked, explain the blocker and stop.",
    "Do not access files outside the current directory. Do not print secrets.",
    "",
    `Task: ${task.title}`,
    `Objective: ${task.objective}`,
    `Acceptance criteria:\n${task.acceptance.map((item) => `- ${item}`).join("\n")}`,
    `Constraints: ${JSON.stringify(task.constraints ?? {})}`,
    memory ? `Position memory:\n${memory}` : "",
    related ? `Related reports:\n${related}` : "",
    `Current instruction: ${instruction}`,
    "",
    "Make the smallest correct change. Run the relevant tests when possible.",
    "Finish with a concise summary of changes, evidence, risks and next steps.",
  ]
    .filter(Boolean)
    .join("\n");
}
