const args = process.argv.slice(2);
const sessionIndex = args.indexOf("--session");
const resumed = sessionIndex >= 0;
const sessionID = resumed ? args[sessionIndex + 1] ?? "ses_mock" : "ses_mock";

const emit = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

emit({
  type: "step_start",
  sessionID,
  part: { type: "step-start", sessionID },
});
emit({
  type: "tool_use",
  sessionID,
  part: {
    type: "tool",
    tool: "read",
    state: {
      status: "completed",
      input: { filePath: "hello.mjs" },
      output: "read ok",
    },
  },
});
emit({
  type: "text",
  sessionID,
  part: {
    type: "text",
    text: resumed ? "resumed mock done" : "mock done",
  },
});
emit({
  type: "step_finish",
  sessionID,
  part: {
    tokens: { total: resumed ? 21 : 42, input: 10, output: 5 },
    cost: resumed ? 0.0005 : 0.001,
  },
});
