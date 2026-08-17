"""Correctness analysis over a chaos run's recorded message log.

This is the actual verification engine, not a reporting/stats layer bolted
on after the fact -- it turns PLAN.md's correctness properties (2: no
silent gaps, 3: at-least-once delivery within the buffer window, 4:
ordering under fan-out) into concrete, checkable assertions against
whatever a chaos_client.py run actually recorded. Deliberately pure and
synchronous: no network, no asyncio, so it's testable with plain pytest
against synthetic message sequences, independent of any live gateway.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from itertools import pairwise


@dataclass(frozen=True)
class ReceivedMessage:
    """One message a single simulated client actually received, in the
    order it arrived. `seq`/`gap_from_seq` are None for a replay message;
    `replay_seqs` is None for event/gap messages."""

    client_id: str
    msg_type: str  # "replay" | "event" | "gap"
    received_at: float  # time.monotonic() when the client observed it
    seq: int | None = None  # for "event"
    gap_from_seq: int | None = None  # for "gap": the reported oldestAvailableSeq
    replay_seqs: tuple[int, ...] | None = None  # for "replay": events[].seq, in order


@dataclass
class Violation:
    property_name: str
    client_id: str
    detail: str


@dataclass
class AnalysisResult:
    total_messages: int
    violations: list[Violation] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return len(self.violations) == 0

    def summary(self) -> str:
        if self.passed:
            return f"PASS -- {self.total_messages} messages across all clients, 0 violations"
        lines = [f"FAIL -- {len(self.violations)} violation(s) across {self.total_messages} messages:"]
        for v in self.violations:
            lines.append(f"  [{v.property_name}] client={v.client_id}: {v.detail}")
        return "\n".join(lines)


def analyze(messages: list[ReceivedMessage]) -> AnalysisResult:
    """Runs every correctness check below across all clients. Order of
    `messages` only matters within a single client_id's own subsequence
    (each check groups by client_id itself), so interleaving clients in
    the input list is fine -- that's exactly what a real concurrent chaos
    run produces."""
    violations: list[Violation] = []
    by_client: dict[str, list[ReceivedMessage]] = {}
    for m in messages:
        by_client.setdefault(m.client_id, []).append(m)

    for client_id, client_messages in by_client.items():
        violations.extend(_check_no_silent_gaps(client_id, client_messages))
        violations.extend(_check_no_duplicate_seqs(client_id, client_messages))
        violations.extend(_check_strictly_increasing_within_run(client_id, client_messages))
        violations.extend(_check_replay_is_self_consistent(client_id, client_messages))

    return AnalysisResult(total_messages=len(messages), violations=violations)


def _event_seqs_between_gaps(messages: list[ReceivedMessage]) -> list[list[int]]:
    """Splits a client's message stream into runs of consecutive "event"
    seqs, breaking at every "gap" or "replay" message (both are legitimate
    resync points -- what must never happen is a jump WITHOUT one of these
    in between)."""
    runs: list[list[int]] = []
    current: list[int] = []
    for m in messages:
        if m.msg_type == "event":
            assert m.seq is not None
            current.append(m.seq)
        else:
            if current:
                runs.append(current)
            current = []
    if current:
        runs.append(current)
    return runs


def _check_no_silent_gaps(client_id: str, messages: list[ReceivedMessage]) -> list[Violation]:
    """Property 2: no silent gaps, ever. Within one unbroken run of "event"
    messages (no gap/replay in between), consecutive seqs must be exactly
    +1 apart -- any larger jump means something was dropped without the
    honest signal PLAN.md requires."""
    out: list[Violation] = []
    for run in _event_seqs_between_gaps(messages):
        for prev, nxt in pairwise(run):
            if nxt != prev + 1:
                out.append(
                    Violation(
                        "no_silent_gaps",
                        client_id,
                        f"seq jumped from {prev} to {nxt} with no gap/replay message between them",
                    )
                )
    return out


def _check_no_duplicate_seqs(client_id: str, messages: list[ReceivedMessage]) -> list[Violation]:
    """A given client should never receive the same seq twice via live
    "event" delivery -- replay and live delivery are drawn from disjoint
    seq ranges by construction (replay is always seq <= lastSeenSeq's
    successor and earlier; live events are always newer), so any repeat
    indicates a real double-delivery bug, not an artifact of the chaos
    client's own reconnect behavior."""
    seen: set[int] = set()
    out: list[Violation] = []
    for m in messages:
        if m.msg_type != "event":
            continue
        assert m.seq is not None
        if m.seq in seen:
            out.append(Violation("no_duplicate_seqs", client_id, f"seq {m.seq} delivered more than once"))
        seen.add(m.seq)
    return out


def _check_strictly_increasing_within_run(client_id: str, messages: list[ReceivedMessage]) -> list[Violation]:
    """Property 4 (ordering): live events within one unbroken run must
    arrive in increasing seq order -- reordering would be just as much a
    correctness break as an outright drop, even though it's a different
    failure mode than _check_no_silent_gaps above."""
    out: list[Violation] = []
    for run in _event_seqs_between_gaps(messages):
        for prev, nxt in pairwise(run):
            if nxt <= prev:
                out.append(Violation("strictly_increasing", client_id, f"seq went from {prev} to {nxt} (not increasing)"))
    return out


def _check_replay_is_self_consistent(client_id: str, messages: list[ReceivedMessage]) -> list[Violation]:
    """A replay message's own content must be internally contiguous (a
    hole inside one replay response is broken, not a legitimate resync
    point on its own), and -- since FeedRelay's sendReplay sends EITHER a
    gap OR a replay for a given lastSeenSeq, never both -- any "replay"
    message at all is itself a guarantee that nothing was evicted, so its
    first seq must be exactly this client's own prior last-known-seq + 1.
    Checkable from one client's own message stream alone, no cross-client
    ground truth needed (unlike check_replay_correctness below, which
    verifies completeness against what was actually retained -- this
    verifies the replay is honest about connecting seamlessly to what came
    before it, a different and complementary property).
    """
    out: list[Violation] = []
    last_known_seq: int | None = None
    for m in messages:
        if m.msg_type == "event":
            assert m.seq is not None
            last_known_seq = m.seq
        elif m.msg_type == "gap":
            assert m.gap_from_seq is not None
            # Matches chaos_client.py's own gap handling: oldestAvailableSeq
            # - 1 is the new effective baseline once a client has
            # acknowledged the gap, not the old (pre-gap) last_known_seq.
            candidate = m.gap_from_seq - 1
            last_known_seq = candidate if last_known_seq is None else max(last_known_seq, candidate)
        elif m.msg_type == "replay":
            seqs = m.replay_seqs or ()
            for prev, nxt in pairwise(seqs):
                if nxt != prev + 1:
                    out.append(
                        Violation(
                            "replay_internally_contiguous",
                            client_id,
                            f"replay seqs jumped from {prev} to {nxt} within a single replay message",
                        )
                    )
            if last_known_seq is not None and seqs and seqs[0] != last_known_seq + 1:
                out.append(
                    Violation(
                        "replay_connects_seamlessly",
                        client_id,
                        f"replay started at seq {seqs[0]}, expected {last_known_seq + 1} -- a gap message should "
                        "have been sent instead if history was actually missing",
                    )
                )
            if seqs:
                last_known_seq = seqs[-1] if last_known_seq is None else max(last_known_seq, seqs[-1])
    return out


def check_replay_correctness(
    client_id: str,
    last_seen_seq: int,
    replay_seqs: tuple[int, ...],
    buffer_capacity: int,
    all_known_seqs_at_disconnect: tuple[int, ...],
) -> list[Violation]:
    """Property 3: at-least-once delivery within the buffer window.
    `all_known_seqs_at_disconnect` is the reference truth (every seq the
    upstream actually assigned up to the moment this client reconnected,
    independent of what any one client saw) -- reconstructed by the caller
    from the full multi-client run, not from this client's own
    (potentially gappy) view. Everything in the retained window
    (the most recent `buffer_capacity` seqs) that's also newer than
    `last_seen_seq` MUST appear in `replay_seqs`, contiguous and in order.
    Separate from `analyze()` above because this needs cross-client
    reference data the per-message stream alone doesn't carry.
    """
    out: list[Violation] = []
    retained_floor = max(0, len(all_known_seqs_at_disconnect) - buffer_capacity)
    retained = all_known_seqs_at_disconnect[retained_floor:]
    expected = tuple(s for s in retained if s > last_seen_seq)

    if replay_seqs != expected:
        out.append(
            Violation(
                "replay_correctness",
                client_id,
                f"expected replay seqs {expected} (lastSeenSeq={last_seen_seq}, retained window starts at "
                f"{retained[0] if retained else 'n/a'}), got {replay_seqs}",
            )
        )
    return out
