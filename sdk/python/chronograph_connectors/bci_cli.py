"""chronograph-bci: local acquisition, replay, datasets and decoder runs."""

import argparse
import json
import os
from pathlib import Path
import sys
import threading
import time
from . import ApiError
from .bci import Session, BCIClient, BCITransport, initialize
from .bci_spool import BCISpool, encode


def main():
    p = argparse.ArgumentParser(
        description="ChronoDB BCI research worker. No clinical/device control functions."
    )
    p.add_argument(
        "command",
        choices=[
            "init",
            "synthetic",
            "brainflow",
            "lsl",
            "import",
            "sync",
            "status",
            "pause",
            "resume",
            "cancel",
            "sessions",
            "export",
            "dataset",
            "train",
            "predict",
            "decode",
            "unpack-model",
        ],
    )
    p.add_argument(
        "--url", default=os.getenv("CHRONOGRAPH_URL", "http://127.0.0.1:8080")
    )
    p.add_argument("--token-file")
    p.add_argument("--instance", default="bci_research")
    p.add_argument("--kind", type=int, default=430)
    p.add_argument(
        "--clock-domain",
        choices=["unix_us", "simulation_us", "lsl_local_us", "device_us"],
        default="unix_us",
    )
    p.add_argument("--spool", default="./bci-spool")
    p.add_argument("--partition", default="bci")
    p.add_argument("--start-sequence", type=int, default=0)
    p.add_argument("--session")
    p.add_argument("--name", default="EEG research session")
    p.add_argument("--participant", default="synthetic")
    p.add_argument("--seconds", type=float, default=30)
    p.add_argument(
        "--channels", default="EEG01,EEG02,EEG03,EEG04,EEG05,EEG06,EEG07,EEG08"
    )
    p.add_argument("--rate", type=int, default=250)
    p.add_argument("--start-us", type=int)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--realtime", action="store_true")
    p.add_argument(
        "--sync", action="store_true", help="Send in a separate thread while recording"
    )
    p.add_argument("--stream", default="eeg")
    p.add_argument("--board-id", type=int, default=-1)
    p.add_argument(
        "--board-config", help="Local JSON connection settings; never uploaded"
    )
    p.add_argument("--preset", type=int, default=0)
    p.add_argument("--units", default="uV")
    p.add_argument(
        "--reference",
        default="unspecified",
        help="Original EEG reference; no rereferencing is performed",
    )
    p.add_argument("--source-id")
    p.add_argument("--input")
    p.add_argument("--output")
    p.add_argument(
        "--sessions", help="Comma separated recording IDs for dataset creation"
    )
    p.add_argument("--dataset-id", default="local")
    p.add_argument("--components", type=int, default=4)
    p.add_argument("--model")
    p.add_argument("--run-id", help="Published run ID for live prediction lineage")
    p.add_argument("--format", choices=["numpy", "fif", "bids"], default="numpy")
    p.add_argument("--subject", default="research01")
    p.add_argument("--task", default="motorimagery")
    args = p.parse_args()
    token = (
        Path(args.token_file).read_text().strip()
        if args.token_file
        else os.getenv("CHRONOGRAPH_TOKEN", "")
    )
    client = BCITransport(args.url, token) if token else None
    needs_client = (
        args.command in ("init", "sync", "sessions", "export", "dataset", "train")
        or args.sync
    )
    if needs_client and client is None:
        p.error("This command requires CHRONOGRAPH_TOKEN or --token-file")
    if args.command == "init":
        print(
            json.dumps(initialize(client, args.instance, args.kind, args.clock_domain))
        )
        return
    if args.command == "sessions":
        print(json.dumps(list(BCIClient(client, args.instance).sessions())))
        return
    if args.command == "export":
        if not args.session or not args.output:
            p.error("export requires --session and --output")
        destination = Path(args.output)
        if args.format == "numpy":
            result = BCIClient(client, args.instance).export(
                args.session, args.stream, destination
            )
        else:
            destination.mkdir(mode=0o700, parents=True, exist_ok=False)
            result = BCIClient(client, args.instance).export(
                args.session, args.stream, destination / "exact-source"
            )
            from . import bci_export

            if args.format == "fif":
                bci_export.fif(
                    destination / "exact-source", destination / "recording_raw.fif"
                )
            else:
                bci_export.bids(
                    destination / "exact-source",
                    destination / "bids",
                    subject=args.subject,
                    task=args.task,
                )
        print(
            json.dumps(
                {
                    "chunks": len(result["chunks"]),
                    "output": args.output,
                    "format": args.format,
                }
            )
        )
        return
    if args.command == "train":
        if not args.input or not args.output:
            p.error("train requires --input manifest.json and --output directory")
        from .bci_training import train

        manifest = json.loads(Path(args.input).read_bytes())
        result = train(
            BCIClient(client, args.instance),
            manifest,
            args.output,
            dataset_id=args.dataset_id,
            components=args.components,
        )
        # Publish only when an existing recording spool is explicitly selected.
        if args.sync:
            with BCISpool(args.spool, args.instance, args.partition) as spool:
                if not spool.state():
                    raise ValueError(
                        "Publishing a run requires an existing recording spool"
                    )
                session = Session(spool, clock_domain=args.clock_domain)
                r = session.record(
                    "run",
                    0,
                    name=args.name,
                    dataset_id=args.dataset_id,
                    recipe=result["recipe"],
                    status="succeeded",
                    result=result,
                )
                spool.enqueue([r])
                spool.drain(client)
                result["run_id"] = r["dst"]
        print(json.dumps(result))
        return
    if args.command == "unpack-model":
        if not args.input or not args.output:
            p.error("unpack-model requires --input job.json and --output directory")
        from .bci_training import unpack_managed_result

        print(json.dumps(unpack_managed_result(args.input, args.output)))
        return
    if args.command == "predict":
        if not args.model or not args.input:
            p.error("predict requires --model directory and --input samples.npy")
        import numpy as np
        from .bci_training import predict

        print(json.dumps(predict(args.model, np.load(args.input, allow_pickle=False))))
        return
    with BCISpool(
        args.spool, args.instance, args.partition, start_sequence=args.start_sequence
    ) as spool:
        if args.command in ("pause", "resume", "cancel"):
            spool.control(
                {"pause": "paused", "resume": "running", "cancel": "cancelled"}[
                    args.command
                ]
            )
        elif args.command == "sync":
            spool.drain(client, max_batches=100000)
        elif args.command != "status":
            session = Session(
                spool,
                name=args.name,
                participant=args.participant,
                source=args.command,
                device=str(args.board_id)
                if args.command == "brainflow"
                else args.command,
                clock_domain=args.clock_domain,
                session_id=args.session,
            )
            if args.command == "dataset":
                if not args.sessions or not args.output:
                    p.error("dataset requires --sessions and --output")
                manifest = client.call(
                    "bci_manifest",
                    {
                        "instance": args.instance,
                        "sessions": args.sessions.split(","),
                        "stream": args.stream,
                    },
                )["manifest"]
                from .bci import save_dataset

                did = save_dataset(client, session, args.name, manifest, spool=spool)
                Path(args.output).write_bytes(encode(manifest))
                spool.drain(client)
                print(json.dumps({"dataset_id": did, "manifest": args.output}))
                return
            stop = threading.Event()
            failure = []

            def send():
                with BCISpool(args.spool, args.instance, args.partition) as sender:
                    delay = 1
                    while not stop.is_set():
                        try:
                            sender.drain(client, max_batches=8)
                            delay = 1
                        except (OSError, ApiError) as error:
                            if isinstance(error, ApiError) and error.status not in (
                                429,
                                500,
                                502,
                                503,
                                504,
                            ):
                                failure.append(str(error))
                                stop.set()
                                return
                            delay = min(delay * 2, 30)
                        except Exception as error:
                            failure.append(str(error))
                            stop.set()
                            return
                        stop.wait(0.1 if delay == 1 else delay)

            thread = threading.Thread(target=send, daemon=True) if args.sync else None
            if thread:
                thread.start()
            try:
                from .bci_acquisition import (
                    synthetic,
                    recorded_file,
                    brainflow_capture,
                    lsl_capture,
                )

                start = (
                    args.start_us
                    if args.start_us is not None
                    else round(time.time() * 1e6)
                )
                if args.command == "synthetic":
                    synthetic(
                        session,
                        seconds=args.seconds,
                        rate=args.rate,
                        channels=len(args.channels.split(",")),
                        start_us=start,
                        realtime=args.realtime,
                        seed=args.seed,
                        channel_names=args.channels.split(","),
                    )
                elif args.command == "import":
                    if not args.input or args.start_us is None:
                        p.error(
                            "import requires --input and explicit --start-us (use simulation_us for relative time)"
                        )
                    recorded_file(
                        session,
                        args.input,
                        start_us=args.start_us,
                        reference=args.reference,
                    )
                elif args.command == "brainflow":
                    brainflow_capture(
                        session,
                        board_id=args.board_id,
                        params=json.loads(Path(args.board_config).read_text())
                        if args.board_config
                        else {},
                        seconds=args.seconds,
                        preset=args.preset,
                        units=args.units,
                        reference=args.reference,
                    )
                elif args.command == "decode":
                    if not args.model or not args.source_id or not args.run_id:
                        p.error(
                            "decode requires --model, --source-id, --run-id and lsl_local_us"
                        )
                    from .bci_training import predict
                    import numpy as np

                    model = json.loads((Path(args.model) / "model.json").read_bytes())
                    if args.channels.split(",") != model["channels"] or any(
                        u != args.units for u in model["units"]
                    ):
                        raise ValueError(
                            "Live source channel order and units must match the trained model"
                        )
                    if args.reference != model["reference"]:
                        raise ValueError("Live reference must match the trained model")
                    length = round(
                        (
                            model["preprocessing"]["epoch_end_s"]
                            - model["preprocessing"]["epoch_start_s"]
                        )
                        * model["sample_rate_hz"]
                    )
                    buffer = []
                    timestamps = []

                    def decode(stream, data, times):
                        nonlocal buffer, timestamps
                        if (
                            timestamps
                            and times[0] - timestamps[-1][-1]
                            > 1.5 / model["sample_rate_hz"]
                        ):
                            buffer = []
                            timestamps = []
                        buffer.append(data)
                        timestamps.append(times)
                        values = np.concatenate(buffer, axis=1)
                        ts = np.concatenate(timestamps)
                        if values.shape[1] >= length:
                            values = values[:, -length:]
                            ts = ts[-length:]
                            if np.any(
                                np.abs(np.diff(ts) - 1 / model["sample_rate_hz"])
                                > 0.5 / model["sample_rate_hz"]
                            ):
                                buffer = []
                                timestamps = []
                                return
                            prediction = predict(args.model, values)
                            session.prediction(
                                stream,
                                round(ts[0] * 1e6),
                                round(ts[-1] * 1e6) + 1,
                                run_id=args.run_id,
                                **prediction,
                            )
                        buffer = [values[:, -length:]]
                        timestamps = [ts[-length:]]

                    session.on_signal = decode
                    lsl_capture(
                        session,
                        source_id=args.source_id,
                        channels=args.channels.split(","),
                        units=[args.units] * len(model["channels"]),
                        seconds=args.seconds,
                        expected_rate=model["sample_rate_hz"],
                        reference=args.reference,
                    )
                elif args.command == "lsl":
                    if not args.source_id:
                        p.error("lsl requires a unique --source-id")
                    channels = args.channels.split(",")
                    lsl_capture(
                        session,
                        source_id=args.source_id,
                        channels=channels,
                        units=[args.units] * len(channels),
                        reference=args.reference,
                        seconds=args.seconds,
                    )
            finally:
                stop.set()
                if thread:
                    thread.join(timeout=35)
            if failure:
                raise RuntimeError("Sender stopped; recording retained: " + failure[0])
            if args.sync:
                spool.drain(client, max_batches=100000)
            print(json.dumps({"session": session.id, **spool.status()}))
            return
        print(json.dumps(spool.status()))


def entry():
    try:
        main()
    except KeyboardInterrupt:
        print(
            "BCI worker stopped; queued records remain in the local spool.",
            file=sys.stderr,
        )
        sys.exit(130)
    except (ValueError, BufferError, RuntimeError, OSError, ApiError) as e:
        print(f"BCI worker stopped: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    entry()
