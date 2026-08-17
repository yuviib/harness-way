"""Unit tests for the correctness-analysis engine itself, against synthetic
message sequences -- no live gateway needed. These are the tests that make
metrics.py trustworthy as a judge of a real chaos run: if the checker can't
correctly flag an OBVIOUSLY broken sequence here, it can't be trusted to
flag a subtle one in real recorded data either.
"""

from harness.metrics import ReceivedMessage, analyze, check_replay_correctness


def _event(client_id: str, seq: int, t: float = 0.0) -> ReceivedMessage:
    return ReceivedMessage(client_id=client_id, msg_type="event", received_at=t, seq=seq)


def _gap(client_id: str, from_seq: int, t: float = 0.0) -> ReceivedMessage:
    return ReceivedMessage(client_id=client_id, msg_type="gap", received_at=t, gap_from_seq=from_seq)


def _replay(client_id: str, seqs: tuple[int, ...], t: float = 0.0) -> ReceivedMessage:
    return ReceivedMessage(client_id=client_id, msg_type="replay", received_at=t, replay_seqs=seqs)


class TestNoSilentGaps:
    def test_consecutive_events_pass(self):
        result = analyze([_event("a", 1), _event("a", 2), _event("a", 3)])
        assert result.passed

    def test_a_jump_with_no_gap_message_is_a_violation(self):
        result = analyze([_event("a", 1), _event("a", 2), _event("a", 5)])
        assert not result.passed
        assert any(v.property_name == "no_silent_gaps" for v in result.violations)

    def test_a_jump_bracketed_by_a_gap_message_is_fine(self):
        result = analyze([_event("a", 1), _event("a", 2), _gap("a", 10), _event("a", 10), _event("a", 11)])
        assert result.passed

    def test_a_jump_bracketed_by_a_replay_is_fine(self):
        # a reconnect's replay legitimately carries the events that would
        # otherwise look like a "jump" in the live stream -- realistic
        # data: the replay's own content connects seamlessly (picks up at
        # seq 3, right after this client's last-known seq 2, and hands
        # over everything through 8), so live events resuming at 9 is not
        # a silent gap at all.
        result = analyze(
            [
                _event("a", 1),
                _event("a", 2),
                _replay("a", (3, 4, 5, 6, 7, 8)),
                _event("a", 9),
                _event("a", 10),
            ]
        )
        assert result.passed

    def test_gaps_are_isolated_per_client(self):
        # client b's broken sequence must not fail client a's check
        result = analyze([_event("a", 1), _event("a", 2), _event("b", 1), _event("b", 9)])
        assert not result.passed
        assert all(v.client_id == "b" for v in result.violations if v.property_name == "no_silent_gaps")


class TestNoDuplicateSeqs:
    def test_unique_seqs_pass(self):
        result = analyze([_event("a", 1), _event("a", 2)])
        assert result.passed

    def test_a_repeated_seq_is_a_violation(self):
        result = analyze([_event("a", 1), _event("a", 2), _event("a", 2)])
        assert not result.passed
        assert any(v.property_name == "no_duplicate_seqs" for v in result.violations)


class TestStrictlyIncreasing:
    def test_increasing_seqs_pass(self):
        result = analyze([_event("a", 1), _event("a", 2), _event("a", 3)])
        assert result.passed

    def test_out_of_order_delivery_is_a_violation(self):
        result = analyze([_event("a", 2), _event("a", 1)])
        assert not result.passed
        assert any(v.property_name == "strictly_increasing" for v in result.violations)


class TestReplaySelfConsistency:
    def test_first_ever_connection_replay_is_unconstrained(self):
        # no prior last-known-seq to compare against -- any replay content
        # is structurally fine on a client's very first connection
        result = analyze([_replay("a", (5, 6, 7))])
        assert result.passed

    def test_replay_internally_contiguous_passes(self):
        result = analyze([_event("a", 1), _gap("a", 10), _replay("a", (10, 11, 12))])
        assert result.passed

    def test_a_hole_inside_one_replay_message_is_a_violation(self):
        result = analyze([_replay("a", (5, 7))])
        assert not result.passed
        assert any(v.property_name == "replay_internally_contiguous" for v in result.violations)

    def test_replay_after_an_event_must_pick_up_at_exactly_plus_one(self):
        result = analyze([_event("a", 5), _replay("a", (6, 7))])
        assert result.passed

    def test_replay_after_an_event_skipping_ahead_without_a_gap_is_a_violation(self):
        result = analyze([_event("a", 5), _replay("a", (9, 10))])
        assert not result.passed
        assert any(v.property_name == "replay_connects_seamlessly" for v in result.violations)

    def test_empty_replay_after_being_fully_caught_up_is_fine(self):
        result = analyze([_event("a", 5), _replay("a", ())])
        assert result.passed

    def test_replay_after_a_gap_must_pick_up_exactly_at_the_gap_boundary(self):
        # gap reports oldestAvailableSeq=10 -- a correctly-behaving client
        # (see chaos_client.py's gap handling) reconnects expecting to
        # pick up exactly at seq 10
        result = analyze([_event("a", 1), _gap("a", 10), _replay("a", (10, 11))])
        assert result.passed

    def test_replay_after_a_gap_that_does_not_match_the_boundary_is_a_violation(self):
        result = analyze([_event("a", 1), _gap("a", 10), _replay("a", (15, 16))])
        assert not result.passed
        assert any(v.property_name == "replay_connects_seamlessly" for v in result.violations)


class TestReplayCorrectness:
    def test_exact_match_passes(self):
        violations = check_replay_correctness(
            client_id="a",
            last_seen_seq=5,
            replay_seqs=(6, 7, 8),
            buffer_capacity=200,
            all_known_seqs_at_disconnect=(1, 2, 3, 4, 5, 6, 7, 8),
        )
        assert violations == []

    def test_missing_a_retained_event_is_a_violation(self):
        violations = check_replay_correctness(
            client_id="a",
            last_seen_seq=5,
            replay_seqs=(6, 8),  # 7 silently missing
            buffer_capacity=200,
            all_known_seqs_at_disconnect=(1, 2, 3, 4, 5, 6, 7, 8),
        )
        assert len(violations) == 1
        assert violations[0].property_name == "replay_correctness"

    def test_replay_beyond_the_buffer_window_is_bounded_to_what_was_retained(self):
        # capacity 3, 10 total seqs assigned -- only 8,9,10 are still
        # retained, so a client with lastSeenSeq=0 must only get those,
        # NOT everything from 1
        violations = check_replay_correctness(
            client_id="a",
            last_seen_seq=0,
            replay_seqs=(8, 9, 10),
            buffer_capacity=3,
            all_known_seqs_at_disconnect=tuple(range(1, 11)),
        )
        assert violations == []

    def test_replaying_evicted_history_is_a_violation(self):
        violations = check_replay_correctness(
            client_id="a",
            last_seen_seq=0,
            replay_seqs=(1, 2, 3),  # these were evicted, must not be replayed
            buffer_capacity=3,
            all_known_seqs_at_disconnect=tuple(range(1, 11)),
        )
        assert len(violations) == 1
