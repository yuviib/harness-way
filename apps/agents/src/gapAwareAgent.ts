// A real consumer whose entire job is to never treat a gap marker as
// silence. Per the MCP spec revision this project is built against, a
// broken response stream unconditionally loses whatever was in flight --
// the only honest move for a client is to treat every gap marker as an
// explicit resync signal, never to guess that nothing was missed.

import { type Config, connect, loadConfig, logAction, parseMessage } from "./shared.ts";

const AGENT_NAME = "gap-aware-agent";
const AGENT_ROLE =
  "Treats every gap marker as an explicit resync signal instead of silence, and reports exactly what it resynced from.";

function run(config: Config): Promise<never> {
  let lastSeenSeq = 0;
  let gapsHandled = 0;

  function connectOnce(): void {
    const ws = connect(config, lastSeenSeq);

    ws.addEventListener("message", (evt: MessageEvent) => {
      const msg = parseMessage(String(evt.data));
      if (msg.type === "gap") {
        gapsHandled++;
        void logAction(config, {
          agentName: AGENT_NAME,
          agentRole: AGENT_ROLE,
          actionType: "resync",
          seq: msg.oldestAvailableSeq,
          detail: `gap #${gapsHandled}: resyncing from seq ${msg.oldestAvailableSeq} rather than assuming nothing was missed`,
        });
        lastSeenSeq = Math.max(lastSeenSeq, msg.oldestAvailableSeq - 1);
      } else if (msg.type === "replay") {
        if (msg.events.length > 0) lastSeenSeq = msg.events[msg.events.length - 1]!.seq;
      } else {
        lastSeenSeq = msg.seq;
      }
    });

    ws.addEventListener("close", () => {
      setTimeout(connectOnce, 500);
    });
  }

  connectOnce();
  return new Promise<never>(() => {});
}

export function startGapAwareAgent(config: Config = loadConfig()): Promise<never> {
  return run(config);
}
