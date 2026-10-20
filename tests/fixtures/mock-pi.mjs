const args = process.argv.slice(2);
const modelIndex = args.indexOf("--model");
const model = modelIndex >= 0 ? args[modelIndex + 1] : "mock/model";
const sessionIndex = args.indexOf("--session-id");
const sessionID = sessionIndex >= 0 ? args[sessionIndex + 1] : "pi_mock";

const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

emit({ type: "session", version: 3, id: sessionID, cwd: process.cwd() });
emit({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: `PI_MOCK ${model}` }],
    usage: {
      input: 10,
      output: 2,
      totalTokens: 12,
      cost: { input: 0, output: 0, total: 0 },
    },
  },
});
emit({ type: "agent_end" });
