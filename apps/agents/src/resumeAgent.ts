// A real consumer that deliberately disconnects and reconnects on a fixed
// interval, the way a real agent process restarting or briefly losing its
// own connection would, and verifies on every reconnect that the replay it
// gets back is gapless and picks up exactly where it left off. This is the
// single property the whole project exists to provide, demonstrated by an
// actual client depending on it rather than asserted in a test file.

import { type BufferedEvent, type Config, connect, loadConfig, logAction, parseMessage } from "./shared.ts";

const AGENT_NAME = "resume-agent";
const AGENT_ROLE =
  "Reconnects on a fixed interval and verifies the replay it receives is gapless and picks up exactly where it left off.";
const RECONNECT_INTERVAL_MS = 20_000;

function findInternalGap(events: BufferedEvent[]): string | null {
  for (let i = 1; i < events.length; i++) {
    if (events[i]!.seq !== events[i - 1]!.seq + 1) {
      return `internal gap in replay: seq ${events[i - 1]!.seq} then ${events[i]!.seq}`;
    }
  }
  return null;
}

function run(config: Config): Promise<never> {
  let lastSeenSeq = 0;
  // False only before the very first connect ever completes: there is
  // nothing to verify a first replay against (no prior lastSeenSeq to
  // have promised), so the first connect just adopts state silently.
  // Every connect after that is a real reconnect this agent chose to
  // make, and its replay is checked against what was expected.
  let hasConnectedBefore = false;

  function connectOnce(): void {
    const expectedFirstSeq = lastSeenSeq + 1;
    const ws = connect(config, lastSeenSeq);
    // Set right before this agent's own deliberate close, mirroring
    // FeedRelay's own intentionalTeardown flag: found by testing, not
    // assumed, that Node's WebSocket close() can take upwards of 15
    // seconds to actually complete its close handshake against wrangler's
    // local dev server (readyState sits at CLOSING well past that). Waiting
    // on it before opening the next connection would make the reconnect
    // interval below meaningless, so the next connectOnce() starts right
    // away instead; this flag just stops the close handler from ALSO
    // reconnecting once the old socket's handshake eventually does finish.
    let intentionalReconnect = false;

    const reconnectTimer = setTimeout(() => {
      intentionalReconnect = true;
      ws.close();
      connectOnce();
    }, RECONNECT_INTERVAL_MS);

    ws.addEventListener("message", (evt: MessageEvent) => {
      const msg = parseMessage(String(evt.data));
      if (msg.type === "replay") {
        const internalGap = findInternalGap(msg.events);
        if (internalGap) {
          void logAction(config, { agentName: AGENT_NAME, agentRole: AGENT_ROLE, actionType: "error", detail: internalGap });
        } else if (hasConnectedBefore && msg.events.length > 0 && msg.events[0]!.seq !== expectedFirstSeq) {
          void logAction(config, {
            agentName: AGENT_NAME,
            agentRole: AGENT_ROLE,
            actionType: "error",
            detail: `expected replay to start at seq ${expectedFirstSeq}, got ${msg.events[0]!.seq}`,
          });
        } else if (hasConnectedBefore) {
          const detail =
            msg.events.length > 0
              ? `reconnect verified: replay covered seq ${msg.events[0]!.seq}-${msg.events[msg.events.length - 1]!.seq} (${msg.events.length} events), gapless`
              : "reconnect verified: fully caught up, nothing missed";
          void logAction(config, { agentName: AGENT_NAME, agentRole: AGENT_ROLE, actionType: "reconnect_verified", detail });
        }
        if (msg.events.length > 0) lastSeenSeq = msg.events[msg.events.length - 1]!.seq;
        hasConnectedBefore = true;
      } else if (msg.type === "gap") {
        void logAction(config, {
          agentName: AGENT_NAME,
          agentRole: AGENT_ROLE,
          actionType: "resync",
          seq: msg.oldestAvailableSeq,
          detail: `reconnect landed outside the replay window; resyncing from seq ${msg.oldestAvailableSeq}`,
        });
        lastSeenSeq = Math.max(lastSeenSeq, msg.oldestAvailableSeq - 1);
        hasConnectedBefore = true;
      } else {
        lastSeenSeq = msg.seq;
      }
    });

    ws.addEventListener("close", () => {
      clearTimeout(reconnectTimer);
      if (!intentionalReconnect) {
        // A genuine unexpected drop, not this agent's own scheduled
        // reconnect (which already started its replacement connection
        // above) -- reconnect to stay watching the feed.
        setTimeout(connectOnce, 500);
      }
    });
  }

  connectOnce();
  return new Promise<never>(() => {});
}

export function startResumeAgent(config: Config = loadConfig()): Promise<never> {
  return run(config);
}
