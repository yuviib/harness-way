// Starts all four demo agents against the same feed. Each opens its own
// real WebSocket subscription through the gateway, exactly like a browser
// dashboard client would -- these are real consumers of the relay, not a
// simulation of one. Kept in one process for a single `npm run dev`, but
// each agent's own connection, state, and reconnect loop is fully
// independent of the others.

import { startGapAwareAgent } from "./gapAwareAgent.ts";
import { startOrderingAgent } from "./orderingAgent.ts";
import { startResumeAgent } from "./resumeAgent.ts";
import { loadConfig } from "./shared.ts";
import { startSummarizerAgent } from "./summarizerAgent.ts";

const config = loadConfig();
console.log(`Starting agents against ${config.gatewayWsBase} (origin ${config.originUrl}, category ${config.category})`);

void startResumeAgent(config);
void startGapAwareAgent(config);
void startOrderingAgent(config);
if (startSummarizerAgent(config)) {
  console.log("summarizer-agent: GEMINI_API_KEY found, running");
}
