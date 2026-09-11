"""Run against an isolated test server. Token path is passed privately, never printed."""
import json
import os
from pathlib import Path
import sys
import tempfile
import numpy as np
from chronograph_connectors import Client, Spool
from chronograph_connectors import adapters

client=Client(sys.argv[1],Path(sys.argv[2]).read_text().strip())
mode=sys.argv[3] if len(sys.argv)>3 else "quantum-eeg"
checks=[]
kind=3100 if mode=="quantum-eeg" else 3200

def configure(connector,preset,**config):
    global kind
    kind+=1
    instance=f"sdk_{kind}"
    template=client.call("connector_template",dict(id=instance,connector=connector,preset=preset,contract_version=1,kind=kind,clock_domain="simulation_us",**config))
    preview=client.call("schema_preview",{"source":template["source"]})
    client.call("schema_apply",{"source":template["source"],"checksum":preview["checksum"],"expected_revision":preview["expected_revision"]})
    return instance

def send(instance,records):
    result=client.call("connector_ingest",dict(instance=instance,partition="test",sequence="0",records=records))
    for index,record in enumerate(records):
        got=client.call("connector_record",{"edge":str(int(result["receipt"]["first_edge"])+index)})["record"]
        assert got==dict(record,valid_to=None)
    return result

instance=configure("custom","record-v1")
with tempfile.TemporaryDirectory() as root:
    data=np.arange(600000,dtype=">f4") # multi-chunk, big-endian source
    asset=client.tensor(data)
    meta,raw=client.read_asset(asset)
    assert meta["shape"]==[600000] and meta["dtype"]=="f32"
    assert raw==data.astype("<f4").tobytes()
    class LoseAck:
        def call(self,op,args):
            client.call(op,args)
            raise OSError("injected lost acknowledgment")
    with Spool(Path(root)/"queue",instance,"spool") as queue:
        queue.enqueue([adapters.record(1,2,0,assets={"data":asset})])
        try: queue.drain(LoseAck())
        except OSError: pass
        assert queue.status()["pending_batches"]==1
    with Spool(Path(root)/"queue",instance,"spool") as queue:
        assert queue.drain(client)==1
        assert queue.status()["pending_batches"]==0
    assert client.checkpoint(instance,"spool")["edge_count"]=="1"
checks.append("multi-chunk tensor, endian conversion, range download, real lost-ack recovery")

if mode=="quantum-eeg":
    import mne
    import qiskit
    import cirq
    with tempfile.TemporaryDirectory() as root:
        values=np.arange(64,dtype=np.float64).reshape(2,32)*1e-6
        raw=mne.io.RawArray(values,mne.create_info(["C3","C4"],128,"eeg"),verbose="ERROR")
        path=Path(root)/"sample_raw.fif"
        raw.save(path,fmt="double",verbose="ERROR")
        rows=list(adapters.eeg_file(client,path,src=10,dst=11,start_us=1000000,chunk_samples=16))
        instance=configure("mne","eeg-v1",channels=["C3","C4"],units=["V","V"])
        send(instance,rows)
        for i,row in enumerate(rows):
            _,content=client.read_asset(row["assets"]["signal"])
            assert content==values[:,i*16:(i+1)*16].astype("<f8").tobytes()
        assert rows[1]["timestamp_us"]=="1125000"
    checks.append(f"MNE {mne.__version__}: real FIF reader, exact channel values and clocks")
    circuit=qiskit.QuantumCircuit(2)
    circuit.h(0);circuit.cx(0,1)
    row=adapters.qiskit_circuit(client,circuit,src=20,dst=21,timestamp_us=0)
    send(configure("qiskit","circuit-v1"),[row])
    _,content=client.read_asset(row["assets"]["source"])
    assert b"OPENQASM 3" in content
    checks.append(f"Qiskit {qiskit.__version__}: official OpenQASM exporter and exact source")
    q=cirq.LineQubit.range(2)
    circuit=cirq.Circuit(cirq.H(q[0]),cirq.CNOT(*q),cirq.measure(*q,key="bits"))
    row=adapters.cirq_circuit(client,circuit,src=30,dst=31,timestamp_us=0)
    send(configure("cirq","circuit-v1"),[row])
    result=cirq.Simulator(seed=42).run(circuit,repetitions=8)
    row=adapters.cirq_result(client,result,src=31,dst=32,timestamp_us=1)
    send(configure("cirq","result-v1"),[row])
    _,content=client.read_asset(row["assets"]["measurement_0"])
    assert content==result.measurements["bits"].tobytes()
    checks.append(f"Cirq {cirq.__version__}: circuit JSON and simulator measurement tensors")
else:
    import torch
    latent=torch.arange(16,dtype=torch.bfloat16).reshape(2,8)
    row=adapters.jepa(client,latent,checkpoint="synthetic-output-contract-v1",src=100,dst=101,timestamp_us=0)
    send(configure("jepa","v-jepa-2.1"),[row])
    meta,content=client.read_asset(row["assets"]["latent"])
    assert meta["dtype"]=="bf16" and content==latent.view(torch.int16).numpy().tobytes()
    levels=list(adapters.hierarchical_jepa(client,[latent,latent+1],checkpoint="synthetic-hierarchy",src=100,first_node=110,timestamp_us=0,horizons_us=[1000000,100000]))
    send(configure("hierarchical-jepa","hierarchical-v1"),levels)
    assert levels[1]["src"]=="110"
    transition=adapters.transition(client,{"camera":np.zeros((3,4,4),dtype=np.uint8)}, {"motor":np.array([0.25,-0.5])}, 1.5,False,True,src=1,dst=2,timestamp_us=0)
    send(configure("gymnasium","transition-v1"),[transition])
    checks.append(f"PyTorch {torch.__version__}: exact BF16 JEPA outputs and parent-linked hierarchy; structured transitions")
    # Official local LeRobot writer and reader, including decoded image pixels.
    os.environ["HF_HUB_OFFLINE"]="1"
    os.environ["HF_DATASETS_OFFLINE"]="1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"]="1"
    from lerobot.datasets.lerobot_dataset import LeRobotDataset
    with tempfile.TemporaryDirectory() as root:
        dataset=LeRobotDataset.create("local/sdk-fixture",fps=10,root=Path(root)/"dataset",use_videos=False,features={
            "observation.state":{"dtype":"float32","shape":(2,),"names":["x","y"]},
            "observation.images.camera":{"dtype":"image","shape":(3,16,16),"names":["channel","height","width"]},
            "action":{"dtype":"float32","shape":(2,),"names":["x","y"]}})
        for i in range(2):
            dataset.add_frame({"observation.state":np.array([i,i+1],dtype=np.float32),"observation.images.camera":np.full((16,16,3),i*100,dtype=np.uint8),"action":np.array([0.1,0.2],dtype=np.float32),"task":"fixture"})
        dataset.save_episode()
        dataset.finalize()
        loaded=LeRobotDataset("local/sdk-fixture",root=Path(root)/"dataset",download_videos=False,token=False)
        rows=list(adapters.lerobot(client,loaded,src=200,first_node=210))
        send(configure("lerobot","v3-records"),rows)
        for i,row in enumerate(rows):
            name=next(k for k,v in row["fields"]["feature_names"].items() if v=="observation.images.camera")
            _,content=client.read_asset(row["assets"][name])
            assert content==loaded[i]["observation.images.camera"].numpy().tobytes()
    checks.append("LeRobot 0.6.1: real v3 dataset including exact decoded image tensors")
print(json.dumps({"status":"passed","mode":mode,"checks":checks},indent=2))
