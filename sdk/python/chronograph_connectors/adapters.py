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
