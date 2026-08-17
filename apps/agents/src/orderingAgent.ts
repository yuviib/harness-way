// A real consumer that asserts, live, that event sequence numbers arrive
// strictly increasing under concurrent fan-out (correctness property 4 in
// PLAN.md), and reports periodic status so the dashboard shows this agent
// actively checking, not just silently trusting.

import { type Config, connect, loadConfig, logAction, parseMessage } from "./shared.ts";

const AGENT_NAME = "ordering-agent";
const AGENT_ROLE =
  "Asserts live that sequence numbers arrive strictly increasing, and reports a periodic status even when everything checks out.";
// Events between status reports -- a demo cadence, not a correctness boundary.
const HEARTBEAT_EVERY = 25;

function run(config: Config): Promise<never> {
  let lastSeenSeq = 0;
  // Null right after a gap: the next event's seq becomes the new
  // baseline rather than a violation, since a gap legitimately resets
  // what "next" means.
  let expectingSeq: number | null = null;
  let eventsSinceHeartbeat = 0;
  let violations = 0;

  function connectOnce(): void {
    const ws = connect(config, lastSeenSeq);

    ws.addEventListener("message", (evt: MessageEvent) => {
      const msg = parseMessage(String(evt.data));
      if (msg.type === "gap") {
        expectingSeq = null;
        lastSeenSeq = Math.max(lastSeenSeq, msg.oldestAvailableSeq - 1);
      } else if (msg.type === "replay") {
        if (msg.events.length > 0) {
          lastSeenSeq = msg.events[msg.events.length - 1]!.seq;
          expectingSeq = lastSeenSeq + 1;
        }
      } else {
        if (expectingSeq !== null && msg.seq !== expectingSeq) {
          violations++;
          void logAction(config, {
            agentName: AGENT_NAME,
            agentRole: AGENT_ROLE,
            actionType: "error",
            seq: msg.seq,
            detail: `ordering violation: expected seq ${expectingSeq}, got ${msg.seq}`,
          });
        }
        lastSeenSeq = msg.seq;
        expectingSeq = msg.seq + 1;
        eventsSinceHeartbeat++;
        if (eventsSinceHeartbeat >= HEARTBEAT_EVERY) {
          eventsSinceHeartbeat = 0;
          void logAction(config, {
            agentName: AGENT_NAME,
            agentRole: AGENT_ROLE,
            actionType: "order_check",
            seq: msg.seq,
            detail: `checked ${HEARTBEAT_EVERY} more events through seq ${msg.seq}: ${violations} ordering violation(s) total since start`,
          });
        }
      }
    });

    ws.addEventListener("close", () => {
      setTimeout(connectOnce, 500);
    });
  }

  connectOnce();
  return new Promise<never>(() => {});
}

export function startOrderingAgent(config: Config = loadConfig()): Promise<never> {
  return run(config);
}
