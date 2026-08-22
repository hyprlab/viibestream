"""Unit tests for the late-joiner buffer's container parsers (no browser).

The invariant that matters for playback: whatever `late_joiner_payload`
returns must be BYTE-CONTINUOUS with the live chunk stream — the next
`stream:chunk` a late joiner receives picks up exactly where the payload
ended. For mp4 that includes partially-received boxes (`pending`).
"""
import struct

import pytest

from app.stream.state import BroadcastState


SID = "sid-1"


def _box(typ: bytes, payload: bytes = b"") -> bytes:
    return struct.pack(">I", len(payload) + 8) + typ + payload


def _large_box(typ: bytes, payload: bytes = b"") -> bytes:
    # size==1 → 64-bit largesize follows the type.
    return struct.pack(">I", 1) + typ + struct.pack(">Q", len(payload) + 16) + payload


def _mp4_state() -> BroadcastState:
    st = BroadcastState()
    assert st.start(SID, "admin", "video/mp4;codecs=avc1.42E01E,mp4a.40.2")
    return st


def _webm_state() -> BroadcastState:
    st = BroadcastState()
    assert st.start(SID, "admin", "video/webm;codecs=vp9,opus")
    return st


# ── fMP4 ────────────────────────────────────────────────────────────────

FTYP = _box(b"ftyp", b"isom....")
MOOV = _box(b"moov", b"m" * 40)
FRAG1 = _box(b"moof", b"f1") + _box(b"mdat", b"d" * 32)
FRAG2 = _box(b"moof", b"f2") + _box(b"mdat", b"e" * 32)
FRAG3 = _box(b"moof", b"f3") + _box(b"mdat", b"g" * 32)


def test_mp4_single_chunk_payload_is_whole_stream():
    st = _mp4_state()
    st.ingest_chunk(SID, FTYP + MOOV + FRAG1 + FRAG2)
    # header + last complete fragment + in-progress fragment == everything
    assert st.late_joiner_payload() == FTYP + MOOV + FRAG1 + FRAG2


def test_mp4_old_fragments_are_dropped():
    st = _mp4_state()
    st.ingest_chunk(SID, FTYP + MOOV + FRAG1 + FRAG2 + FRAG3)
    # Fragment 1 ages out; init + the two most recent fragments remain.
    assert st.late_joiner_payload() == FTYP + MOOV + FRAG2 + FRAG3


def test_mp4_split_mid_box_stays_byte_continuous():
    stream = FTYP + MOOV + FRAG1 + FRAG2
    # Feed the same bytes at every possible split point; the payload must
    # always be exactly the full stream (nothing dropped or reordered).
    for cut in range(1, len(stream)):
        st = _mp4_state()
        st.ingest_chunk(SID, stream[:cut])
        st.ingest_chunk(SID, stream[cut:])
        assert st.late_joiner_payload() == stream, f"discontinuity at cut={cut}"


def test_mp4_largesize_box():
    st = _mp4_state()
    frag = _large_box(b"moof", b"f") + _box(b"mdat", b"d" * 8)
    st.ingest_chunk(SID, FTYP + MOOV + frag)
    assert st.late_joiner_payload() == FTYP + MOOV + frag


def test_mp4_corrupt_size_stops_segmenting_but_stays_continuous():
    st = _mp4_state()
    good = FTYP + MOOV + FRAG1
    junk = struct.pack(">I", 3) + b"zzzz" + b"x" * 64   # size < 8 → not a box
    st.ingest_chunk(SID, good)
    st.ingest_chunk(SID, junk)
    st.ingest_chunk(SID, b"more-bytes")
    # Segmentation halts, but the payload still continues the byte stream.
    assert st.late_joiner_payload() == good + junk + b"more-bytes"


def test_mp4_reset_on_restart():
    st = _mp4_state()
    st.ingest_chunk(SID, FTYP + MOOV + FRAG1)
    assert st.start(SID, "admin", "video/mp4")   # same-sid restart resets
    assert st.late_joiner_payload() is None


# ── WebM (regression) ───────────────────────────────────────────────────

CLUSTER_ID = b"\x1f\x43\xb6\x75"
WEBM_HEADER = b"\x1a\x45\xdf\xa3" + b"h" * 24        # EBML magic + filler
WEBM_C1 = CLUSTER_ID + b"a" * 16
WEBM_C2 = CLUSTER_ID + b"b" * 16
WEBM_C3 = CLUSTER_ID + b"c" * 16


def test_webm_header_and_clusters():
    st = _webm_state()
    st.ingest_chunk(SID, WEBM_HEADER + WEBM_C1 + WEBM_C2 + WEBM_C3)
    # Cluster 1 ages out; header + last complete + current remain.
    assert st.late_joiner_payload() == WEBM_HEADER + WEBM_C2 + WEBM_C3


def test_webm_split_stays_byte_continuous():
    stream = WEBM_HEADER + WEBM_C1 + WEBM_C2
    for cut in range(1, len(stream)):
        st = _webm_state()
        st.ingest_chunk(SID, stream[:cut])
        st.ingest_chunk(SID, stream[cut:])
        assert st.late_joiner_payload() == stream, f"discontinuity at cut={cut}"


def test_container_detection():
    assert _mp4_state()._s.container == "mp4"          # noqa: SLF001
    assert _webm_state()._s.container == "webm"        # noqa: SLF001
