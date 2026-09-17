"""Local adapters for external runtimes. Optional packages load only when called.

Model inference, device control and untrusted file conversion never run on the
Chronograph server. These functions produce the normalized v1 transport contract.
"""
import json
from pathlib import Path


def _json(value):
    if hasattr(value, "tolist"):
        value=value.tolist()
    if isinstance(value, dict):
        return {str(k):_json(v) for k,v in value.items()}
    if isinstance(value, (tuple,list)):
        return [_json(v) for v in value]
    if value is None or type(value) in (str,bool,int,float):
        json.dumps(value,allow_nan=False)
        return value
    raise TypeError("Use JSON-compatible values; arbitrary Python objects are never serialized")


def record(src,dst,timestamp_us,*,assets=None,fields=None,episode=None):
    return {"src":str(src),"dst":str(dst),"timestamp_us":str(timestamp_us),
            "assets":assets or {},"fields":_json(fields or {}),"episode":episode}


def tensor(client, value, *, provenance=None):
    """Accept NumPy or detached PyTorch tensors; preserve dtype and element bits."""
    if hasattr(value,"detach"):
        value=value.detach().cpu().contiguous()
        if str(value.dtype)=="torch.bfloat16":
            import torch
            data=value.view(torch.int16).numpy().astype("<i2",copy=False).tobytes()
            return client.asset(data,dtype="bf16",shape=tuple(value.shape),provenance=provenance)
        value=value.numpy()
    return client.tensor(value,provenance=provenance)


def jepa(client, latent, *, checkpoint, src, dst, timestamp_us, tensors=None, action=None, episode=None):
    """I/V-JEPA and JEPA-WMs output adapter. Caller supplies an exact checkpoint identifier.

    Additional named tensors can contain masks, targets and predictions. The
    adapter does not load a checkpoint or assume one upstream model architecture.
    """
    if not isinstance(checkpoint,str) or not checkpoint:
        raise ValueError("Checkpoint provenance is required")
    values={"latent":latent,**(tensors or {})}
    assets={name:tensor(client,value,provenance={"checkpoint":checkpoint}) for name,value in values.items()}
    fields={"checkpoint":checkpoint}
    if action is not None:
        fields["action"]=_json(action)
    return record(src,dst,timestamp_us,assets=assets,fields=fields,episode=episode)


def hierarchical_jepa(client, levels, *, checkpoint, src, first_node, timestamp_us, horizons_us, episode=None):
    """Yield parent-linked levels, from coarse root to finer children. No simulator restoration is implied."""
    if len(levels)!=len(horizons_us) or not 1<=len(levels)<=64:
        raise ValueError("Provide 1–64 levels with matching prediction horizons")
    for level,(latent,horizon) in enumerate(zip(levels,horizons_us)):
        if not isinstance(horizon,int) or not 0<=horizon<2**64:
            raise ValueError("Prediction horizons must be nonnegative microseconds")
        parent=src if level==0 else first_node+level-1
        result=jepa(client,latent,checkpoint=checkpoint,src=parent,dst=first_node+level,timestamp_us=timestamp_us,episode=episode)
        result["fields"].update(level=level,horizon_us=str(horizon),parent_node=str(parent))
        yield result


def transition(client, observation, action, reward, terminated, truncated, *, src, dst, timestamp_us, episode=None, state=None, state_codec=None):
    """Gymnasium/Minari-compatible step. Discrete, continuous and structured actions are retained."""
    if type(terminated) is not bool or type(truncated) is not bool:
        raise ValueError("terminated and truncated must be independent booleans")
    observations=observation if isinstance(observation,dict) else {"observation":observation}
    assets={name:tensor(client,value) for name,value in observations.items()}
    fields={"action":_json(action),"reward":float(reward),"terminated":terminated,"truncated":truncated}
    if state is not None:
        if not state_codec:
            raise ValueError("State restoration requires a named complete-state/RNG codec")
        assets["state"]=client.asset(state,kind="opaque",encoding="complete_state",provenance={"codec":state_codec})
        fields["state_codec"]=state_codec
    return record(src,dst,timestamp_us,assets=assets,fields=fields,episode=episode)


def eeg(client, raw, *, src, dst, start_us, chunk_samples=1024):
    """Stream an MNE Raw object without preloading it. Samples are [channels,samples] in SI volts.

    Configure the instance with raw.ch_names and one 'V' unit per channel. Preserve
    original channel calibration in the source file/provenance if needed.
    """
    if chunk_samples<1 or chunk_samples*len(raw.ch_names)*8>16*1024*1024:
        raise ValueError("EEG chunk exceeds asset bounds")
    sfreq=float(raw.info["sfreq"])
    for start in range(0,raw.n_times,chunk_samples):
        data=raw.get_data(start=start,stop=min(start+chunk_samples,raw.n_times))
        asset=tensor(client,data,provenance={"reader":"MNE","units":"V"})
        yield record(src,dst,int(start_us)+round(start*1_000_000/sfreq),assets={"signal":asset},fields={"sample_start":str(start),"sample_rate_hz":sfreq,"channels":list(raw.ch_names),"units":["V"]*len(raw.ch_names)})


def eeg_file(client,path,**kwargs):
    """Read local EDF, BDF or FIF through MNE's explicit readers (no pickle)."""
    import mne
    path=Path(path)
    if path.is_symlink() or not path.is_file():
        raise ValueError("Use a regular local EEG file")
    readers={".edf":mne.io.read_raw_edf,".bdf":mne.io.read_raw_bdf,".fif":mne.io.read_raw_fif}
    reader=readers.get(path.suffix.lower())
    if reader is None:
        raise ValueError("Supported EEG files: EDF, BDF, FIF")
    raw=reader(path,preload=False,verbose="ERROR")
    try:
        yield from eeg(client,raw,**kwargs)
    finally:
        raw.close()


def lerobot(client,dataset,*,src,first_node,start_us=0):
    """Iterate an already opened LeRobot dataset, including decoded image tensors.

    The official dataset reader controls video decoding. Every numeric feature,
    including image pixels, is stored as an exact tensor. This adapter does not
    rewrite v2.1/v3 dataset files or export MP4 shards.
    """
    for index in range(len(dataset)):
        frame=dataset[index]
        timestamp=float(frame["timestamp"].item() if hasattr(frame["timestamp"],"item") else frame["timestamp"])
        episode=frame.get("episode_index",0)
        if hasattr(episode,"item"): episode=episode.item()
        assets,fields={},{}
        feature_names={}
        for key,value in frame.items():
            if hasattr(value,"dtype"):
                # Preserve dotted LeRobot names in a reversible metadata map.
                name=f"feature_{len(assets)}"
                assets[name]=tensor(client,value)
                feature_names[name]=key
            else:
                fields.setdefault("metadata",{})[key]=_json(value)
        fields["feature_names"]=feature_names
        fields["frame_index"]=str(index)
        yield record(src,first_node+index,int(start_us)+round(timestamp*1_000_000),assets=assets,fields=fields,episode=str(episode))


def qiskit_circuit(client,circuit,*,src,dst,timestamp_us):
    """Export OpenQASM 3 source with Qiskit's exporter. Unsupported exports raise explicitly."""
    import qiskit
    from qiskit import qasm3
    source=qasm3.dumps(circuit).encode()
    asset=client.asset(source,kind="opaque",encoding="openqasm3",provenance={"runtime":"qiskit","version":qiskit.__version__})
    return record(src,dst,timestamp_us,assets={"source":asset},fields={"runtime":"qiskit","qubits":circuit.num_qubits,"representation":"opaque_source"})


def qiskit_result(result,*,src,dst,timestamp_us,experiment=0):
    """Preserve counts and execution provenance from a Qiskit Result; never execute a job."""
    counts=result.get_counts(experiment)
    fields={"counts":{str(k):str(v) for k,v in counts.items()},"backend":str(result.backend_name),"job_id":str(result.job_id),"success":bool(result.success)}
    return record(src,dst,timestamp_us,fields=fields)


def cirq_circuit(client,circuit,*,src,dst,timestamp_us):
    """Retain Cirq JSON as an opaque artifact, avoiding unsafe server-side deserialization."""
    import cirq
    source=cirq.to_json(circuit).encode()
    asset=client.asset(source,kind="opaque",encoding="cirq_json",provenance={"runtime":"cirq","version":cirq.__version__})
    return record(src,dst,timestamp_us,assets={"source":asset},fields={"runtime":"cirq","qubits":len(circuit.all_qubits()),"representation":"opaque_source"})


def cirq_result(client,result,*,src,dst,timestamp_us):
    assets={f"measurement_{i}":tensor(client,value) for i,value in enumerate(result.measurements.values())}
    return record(src,dst,timestamp_us,assets=assets,fields={"measurement_names":list(result.measurements),"parameters":{str(k):_json(v) for k,v in result.params.param_dict.items()}})


def signal_chunk(client, samples, timestamps, *, channels, units, src, dst,
                 clock_domain, layout="samples_channels", provenance=None):
    """Normalize a bounded numeric signal chunk; retain every original timestamp.

    LSL timestamps use lsl_local_us, not Unix time. The caller must explicitly
    transform clocks before selecting another domain. Units are never inferred.
    """
    import numpy as np
    if clock_domain not in ("unix_us", "lsl_local_us", "device_us", "simulation_us"):
        raise ValueError("An explicit supported clock domain is required")
    data, times = np.asarray(samples), np.asarray(timestamps, dtype=np.float64)
    if layout == "samples_channels":
        data = data.T
    elif layout != "channels_samples":
        raise ValueError("Unknown signal layout")
    if (data.ndim != 2 or times.ndim != 1 or data.shape[1] != len(times)
            or not len(times) or data.shape[0] != len(channels)
            or not 1 <= len(channels) <= 512 or len(units) != len(channels)
            or any(not isinstance(v, str) or not v for v in [*channels, *units])
            or not np.isfinite(times).all() or np.any(np.diff(times) < 0)
            or data.nbytes > 16*1024*1024 or times.nbytes > 16*1024*1024):
        raise ValueError("Signal shape, channel units, timestamps or chunk bounds are invalid")
    timestamp_us = round(float(times[0])*1_000_000)
    if not -(2**63) <= timestamp_us < 2**63-1:
        raise ValueError("Signal timestamp exceeds i64 microseconds")
    assets = {"signal":tensor(client,data,provenance=provenance),
              "timestamps":tensor(client,times,provenance={"units":"seconds","clock_domain":clock_domain})}
    return record(src,dst,timestamp_us,assets=assets,
                  fields={"channels":list(channels),"units":list(units),"clock_domain":clock_domain})


def lsl_chunk(client, samples, timestamps, *, channels, units, src, dst, source_id=None):
    """Adapt StreamInlet.pull_chunk() output, without discovering or opening devices."""
    return signal_chunk(client,samples,timestamps,channels=channels,units=units,src=src,dst=dst,
                        clock_domain="lsl_local_us",provenance={"runtime":"pylsl","source_id":source_id or "unspecified"})


def brainflow(client, data, *, board_id, channels, units, src, dst, chunk_samples=1024,
              channel_indices=None):
    """Adapt BoardShim.get_board_data() from an already acquired DEFAULT_PRESET.

    Default row selection is BoardShim.get_eeg_channels(board_id). Provide row
    indices for another signal type. Caller supplies names and original units.
    Acquisition/session ownership remains with the caller. Board timestamps are
    retained as provided; this adapter uses the BrainFlow Unix-seconds convention.
    """
    import numpy as np
    from brainflow.board_shim import BoardShim
    data=np.asarray(data)
    indices=BoardShim.get_eeg_channels(board_id) if channel_indices is None else list(channel_indices)
    if (type(chunk_samples) is not int or chunk_samples < 1 or data.ndim != 2
            or len(indices) != len(channels) or len(units) != len(channels)
            or any(type(i) is not int or i < 0 or i >= data.shape[0] for i in indices)
            or BoardShim.get_timestamp_channel(board_id) >= data.shape[0]):
        raise ValueError("Invalid BrainFlow rows, channels or chunk size")
    times=data[BoardShim.get_timestamp_channel(board_id)]
    for start in range(0,data.shape[1],chunk_samples):
        stop=min(start+chunk_samples,data.shape[1])
        item=signal_chunk(client,data[indices,start:stop],times[start:stop],channels=channels,units=units,
                          src=src,dst=dst,clock_domain="unix_us",layout="channels_samples",
                          provenance={"runtime":"brainflow","board_id":str(board_id)})
        item["fields"].update(board_id=board_id,sample_rate_hz=BoardShim.get_sampling_rate(board_id))
        yield item


def model_outputs(client, outputs, *, model, checkpoint, src, dst, timestamp_us, episode=None):
    """Adapt named NumPy/PyTorch outputs, including caller-run ONNX inference.

    Original names are stored separately so dotted model names remain reversible.
    No architecture, tensor semantics or inference runtime is guessed.
    """
    if not isinstance(model,str) or not model or not isinstance(checkpoint,str) or not checkpoint:
        raise ValueError("Model and checkpoint identifiers are required")
    if not isinstance(outputs,dict) or not 1 <= len(outputs) <= 32:
        raise ValueError("Provide 1–32 named output tensors")
    assets, names = {}, {}
    for index,(name,value) in enumerate(outputs.items()):
        if not isinstance(name,str) or not name:
            raise ValueError("Output names must be nonempty strings")
        key=f"output_{index}"
        assets[key]=tensor(client,value,provenance={"model":model,"checkpoint":checkpoint,"output":name})
        names[key]=name
    return record(src,dst,timestamp_us,assets=assets,fields={"model":model,"checkpoint":checkpoint,"output_names":names},episode=episode)


def quantum_counts(counts, *, basis, runtime, backend, src, dst, timestamp_us, job_id=None):
    """Portable observed counts from Qiskit, PennyLane, Braket or another host.

    Counts must be nonnegative integers, not probabilities/quasi-distributions.
    Outcome order is retained; basis describes the producer's bit ordering.
    """
    if not all(isinstance(v,str) and v for v in (basis,runtime,backend)):
        raise ValueError("Provide basis, runtime and backend provenance")
    if not isinstance(counts,dict) or not 1 <= len(counts) <= 4096:
        raise ValueError("Provide 1–4096 observed outcomes")
    normalized={}
    for key,value in counts.items():
        if hasattr(value,"item"): value=value.item()
        if type(value) is not int or not 0 <= value < 2**64 or not isinstance(key,str) or not 1 <= len(key) <= 256:
            raise ValueError("Counts require outcome strings and u64 integer frequencies")
        normalized[key]=str(value)
    fields={"counts":normalized,"basis":basis,"runtime":runtime,"backend":backend}
    if job_id is not None: fields["job_id"]=str(job_id)
    return record(src,dst,timestamp_us,fields=fields)


def quantum_observables(observables, *, runtime, backend, src, dst, timestamp_us, job_id=None):
    """Named finite expectation values; units/operator definitions belong in names/provenance."""
    import math
    if not isinstance(observables,dict) or not 1 <= len(observables) <= 4096:
        raise ValueError("Provide 1–4096 named observables")
    values={}
    for name,value in observables.items():
        if not isinstance(name,str) or not name or isinstance(value,bool) or not math.isfinite(float(value)):
            raise ValueError("Observables require names and finite numbers")
        values[name]=float(value)
    if not all(isinstance(v,str) and v for v in (runtime,backend)):
        raise ValueError("Runtime and backend are required")
    fields={"observables":values,"runtime":runtime,"backend":backend}
    if job_id is not None: fields["job_id"]=str(job_id)
    return record(src,dst,timestamp_us,fields=fields)


def qsharp_result(shots, *, src, dst, timestamp_us, backend="qdk-local-simulator"):
    """Adapt QDK host results where the Q# entry point returns Int[] bits.

    Result enums are deliberately not guessed; convert them explicitly in Q#.
    This helper never evaluates source or submits a quantum job.
    """
    from collections import Counter
    counts=Counter()
    width=None
    for shot in shots:
        if not isinstance(shot,(list,tuple)) or not 1 <= len(shot) <= 256 or any(type(bit) is not int or bit not in (0,1) for bit in shot):
            raise ValueError("Q# entry point must return a nonempty Int[] of 0/1")
        if width is not None and width != len(shot):
            raise ValueError("Q# shots have inconsistent widths")
        width=len(shot)
        counts["".join(str(bit) for bit in shot)]+=1
    return quantum_counts(dict(counts),basis="Z; entry-point array order left-to-right",runtime="qdk-qsharp",backend=backend,src=src,dst=dst,timestamp_us=timestamp_us)


def quantum_source(client, source, *, encoding, runtime, src, dst, timestamp_us):
    """Store caller-supplied Q#, QIR or other source as an immutable opaque asset."""
    if isinstance(source,str): source=source.encode("utf-8")
    if not isinstance(source,(bytes,bytearray)) or not runtime or not encoding:
        raise ValueError("Provide source bytes, encoding and runtime")
    asset=client.asset(source,kind="opaque",encoding=encoding,provenance={"runtime":runtime})
    return record(src,dst,timestamp_us,assets={"source":asset},fields={"runtime":runtime,"representation":"opaque_source"})


def ros_message(client, message, *, message_type, topic, src, dst, timestamp_us, binary=None):
    """Store an already decoded ROS 2 message dictionary and optional raw media.

    Call your ROS/rosbags decoder locally. No CDR, bag or MCAP decoding is implied
    here. Image width/height/step/endianness and coordinate frames must be retained
    in the message dictionary; binary values need explicit named assets.
    """
    if not isinstance(message,dict) or not message_type or not topic:
        raise ValueError("A decoded message mapping, ROS type and topic are required")
    decoded=_json(message)
    assets={}
    for name,value in (binary or {}).items():
        assets[name]=client.asset(value,kind="opaque",encoding="ros2_message_bytes",provenance={"message_type":message_type,"topic":topic})
    return record(src,dst,timestamp_us,assets=assets,fields={"message_type":message_type,"topic":topic,"message":decoded})
