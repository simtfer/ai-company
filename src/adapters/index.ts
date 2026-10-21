import { FakeHarness } from "./fake";
import { OpencodeAdapter } from "./opencode";
import { ClaudeCodeAdapter } from "./claude-code";
import { ClaudeSdkAdapter } from "./claude-sdk";
import { PiAdapter } from "./pi";
import { discoverHarnesses, type DiscoveredHarnesses } from "./discovery";
import type { HarnessAdapter } from "./types";

export { FakeHarness } from "./fake";
export { OpencodeAdapter } from "./opencode";
export { ClaudeCodeAdapter } from "./claude-code";
export { ClaudeSdkAdapter } from "./claude-sdk";
export { PiAdapter } from "./pi";
export { discoverHarnesses } from "./discovery";
export type { DiscoveredHarnesses } from "./discovery";

export interface RealAdapterSet {
  adapters: HarnessAdapter[];
  discovered: DiscoveredHarnesses;
}

/**
 * Register only harnesses whose binaries were actually found. Fake is always
 * present as a deterministic test/demo adapter.
 */
export function createRealAdapters(): RealAdapterSet {
  const discovered = discoverHarnesses();
  const adapters: HarnessAdapter[] = [new FakeHarness(0)];
  if (discovered.opencode) adapters.push(new OpencodeAdapter());
  if (discovered.claude) {
    adapters.push(new ClaudeCodeAdapter());
    adapters.push(new ClaudeSdkAdapter());
  }
  if (discovered.pi) adapters.push(new PiAdapter());
  return { adapters, discovered };
}
