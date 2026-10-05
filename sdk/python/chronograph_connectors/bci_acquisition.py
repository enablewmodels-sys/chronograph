"""Local acquisition only. Device configuration and control stay outside ChronoDB.

Every source is declared once in chronograph_connectors.sources. These entry points keep
working by delegating to that one generic writer, so a synthetic stream, a live board, an
LSL outlet and a recorded file all share a single code path. Adding a board or a format is
a registry row rather than another function here.
"""

from .sources import run_source


def synthetic(
    session,
    *,
    seconds=30,
    rate=250,
    channels=8,
    start_us=0,
    realtime=False,
    seed=42,
    channel_names=None,
    chunk_samples=None,
):
    """Record the deterministic synthetic board. It does not sleep unless realtime.

    chunk_samples trades commit frequency for a larger single record: 2000 samples as
    four 500-sample commits cost a quarter of the disk synchronizations of forty
    50-sample commits, and store exactly the same samples.
    """
    if (
        not 1 <= channels <= 512
        or not 80 <= rate <= 100_000
        or not 0 < seconds <= 86400
    ):
        raise ValueError("Invalid synthetic recording bounds")
    return run_source(
        session,
        "synthetic",
        seconds=seconds,
        rate=rate,
        channels=channels,
        start_us=start_us,
        realtime=realtime,
        seed=seed,
        channel_names=channel_names,
        chunk_samples=chunk_samples,
    )


def recorded_file(
    session, path, *, start_us, chunk_samples=1024, reference="unspecified"
):
    """Read a local EDF, BDF, FIF, BrainVision or EEGLAB recording.

    Non-voltage channels are never relabelled as volts, and annotations and bad channels
    are preserved as events.
    """
    return run_source(
        session,
        "mne_file",
        path=path,
        start_us=start_us,
        chunk_samples=chunk_samples,
        reference=reference,
        clock_domain=getattr(session, "clock", "unix_us"),
    )


def brainflow_capture(
    session,
    *,
    board_id,
    params,
    seconds=30,
    preset=0,
    units=None,
    reference="unspecified",
):
    """Acquire any BrainFlow board. The caller owns nothing; this owns the session.

    Geometry, channel names and sampling rate come from the installed board descriptor,
    so every board the library defines is supported without board-specific code here.
    """
    return run_source(
        session,
        "brainflow",
        board_id=board_id,
        params=params,
        seconds=seconds,
        preset=preset,
        units=units,
        reference=reference,
    )


def lsl_capture(
    session,
    *,
    source_id,
    channels,
    units,
    seconds=30,
    expected_rate=None,
    reference="unspecified",
    pull_samples=None,
):
    """Adapt a local LSL outlet. Its clock is local, never Unix time.

    pull_samples sets samples per inlet read and per durable commit; see
    chronograph_connectors.sources.lsl for the latency tradeoff.
    """
    return run_source(
        session,
        "lsl",
        source_id=source_id,
        channels=channels,
        units=units,
        seconds=seconds,
        expected_rate=expected_rate,
        reference=reference,
        pull_samples=pull_samples,
    )
