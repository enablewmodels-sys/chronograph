"""Real host/runtime fixtures. No hardware, cloud account or quantum job required."""
import json
from pathlib import Path
import sys
import time
import uuid
import numpy as np
from brainflow.board_shim import BoardShim, BoardIds, BrainFlowInputParams
from chronograph_connectors import Client, ApiError
from chronograph_connectors import adapters as a

client=Client(sys.argv[1],Path(sys.argv[2]).read_text().strip())
next_kind=4500
checks=[]
def binding(name,connector,preset,clock="simulation_us",channels=None,units=None):
    global next_kind
    args=dict(id=name,connector=connector,preset=preset,kind=next_kind,contract_version=1,clock_domain=clock)
    next_kind+=1
    if channels is not None: args.update(channels=channels,units=units)
    source=client.call("connector_template",args)["source"]
    preview=client.call("schema_preview",{"source":source})
    client.call("schema_apply",{"source":source,"checksum":preview["checksum"],"expected_revision":preview["expected_revision"]})

def roundtrip(name,record):
    receipt=client.ingest(name,"fixture","0",[record])["receipt"]
    restored=client.call("connector_record",{"edge":receipt["first_edge"]})["record"]
    for key in ("src","dst","timestamp_us","assets","fields"):
        assert restored[key]==record[key],key
    assert client.checkpoint(name,"fixture")==receipt

def bad(name,record):
    try: client.ingest(name,"negative","0",[record])
    except ApiError as error: assert error.status==400
    else: raise AssertionError("Invalid domain record accepted")

# BrainFlow's real synthetic driver, no physical device.
board_id=BoardIds.SYNTHETIC_BOARD.value
BoardShim.disable_board_logger()
board=BoardShim(board_id,BrainFlowInputParams())
board.prepare_session()
try:
    board.start_stream()
    time.sleep(0.15)
    data=board.get_board_data()
    board.stop_stream()
finally: board.release_session()
del board
indices=BoardShim.get_eeg_channels(board_id)
channels=[f"EEG_{i}" for i in range(len(indices))]
units=["uV"]*len(channels)
records=list(a.brainflow(client,data,board_id=board_id,channels=channels,units=units,src=10,dst=11))
assert records
binding("brainflow_fixture","brainflow","signal-v1","unix_us",channels,units)
roundtrip("brainflow_fixture",records[0])
meta,raw=client.read_asset(records[0]["assets"]["signal"])
assert meta["shape"]==[len(channels),data.shape[1]]
assert raw==data[indices].astype("<f8").tobytes()
bad("brainflow_fixture",a.record(10,11,0))
checks.append("BrainFlow 5.22.2 synthetic board acquisition, exact signal/timestamps and channel validation")

# Local LSL outlet/inlet; no external stream discovery.
from pylsl import StreamInfo,StreamOutlet,StreamInlet,local_clock,resolve_byprop
info=StreamInfo("Chronograph SDK fixture","EEG",2,100,"float32",str(uuid.uuid4()))
outlet=StreamOutlet(info,chunk_size=1)
resolved=resolve_byprop("source_id",info.source_id(),timeout=5)
assert len(resolved)==1
inlet=StreamInlet(resolved[0],max_buflen=1)
try:
    inlet.open_stream(timeout=5)
    assert outlet.wait_for_consumers(5)
    time.sleep(0.1)
    start=local_clock()
    for i in range(8): outlet.push_sample([float(i),-float(i)],timestamp=start+i/100)
    samples,times=inlet.pull_chunk(timeout=5,max_samples=8)
    assert len(samples)==8
finally: inlet.close_stream()
record=a.lsl_chunk(client,samples,times,channels=["C3","C4"],units=["uV","uV"],src=12,dst=13,source_id=info.source_id())
binding("lsl_fixture","lsl","signal-v1","lsl_local_us",["C3","C4"],["uV","uV"])
roundtrip("lsl_fixture",record)
assert record["fields"]["clock_domain"]=="lsl_local_us"
assert client.read_asset(record["assets"]["timestamps"])[1]==np.asarray(times,dtype="<f8").tobytes()
checks.append("pylsl 1.18.2 local outlet/inlet, explicit local clock, exact per-sample timestamps")

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/"sdk/qsharp"))
from host import bell_shots
shots=bell_shots(128)
record=a.qsharp_result(shots,src=14,dst=15,timestamp_us=0)
assert set(record["fields"]["counts"]) <= {"00","11"}
assert sum(int(v) for v in record["fields"]["counts"].values())==128
binding("qsharp_fixture","qsharp","result-v1")
roundtrip("qsharp_fixture",record)
source=Path("sdk/qsharp/Bell.qs").read_text()
record=a.quantum_source(client,source,encoding="qsharp",runtime="qdk",src=15,dst=16,timestamp_us=0)
binding("qsharp_source_fixture","qsharp","source-v1")
roundtrip("qsharp_source_fixture",record)
assert client.read_asset(record["assets"]["source"])[1]==source.encode()
bad("qsharp_source_fixture",a.record(15,16,0))
checks.append("QDK 1.32.3 Bell program, 128 simulated correlated shots, source and result roundtrip")

binding("counts_fixture","quantum-results","counts-v1")
record=a.quantum_counts({"00":2**53+1,"11":3},basis="Z; left-to-right",runtime="external-fixture",backend="fixture",src=16,dst=17,timestamp_us=0)
roundtrip("counts_fixture",record)
bad("counts_fixture",a.record(16,17,0,fields={"basis":"Z","counts":{"00":1}}))
binding("observables_fixture","quantum-results","observables-v1")
roundtrip("observables_fixture",a.quantum_observables({"Z0":0.25},runtime="fixture",backend="fixture",src=17,dst=18,timestamp_us=0))
bad("observables_fixture",a.record(17,18,0))
checks.append("Portable quantum counts preserve u64 frequencies; observables reject malformed records")

binding("model_fixture","model-output","tensors-v1")
outputs={"latent.hidden":np.arange(12,dtype=">f4").reshape(3,4),"mask":np.array([True,False])}
record=a.model_outputs(client,outputs,model="external-test",checkpoint="fixture-v1",src=18,dst=19,timestamp_us=0)
roundtrip("model_fixture",record)
assert client.read_asset(record["assets"]["output_0"])[1]==outputs["latent.hidden"].astype("<f4").tobytes()
bad("model_fixture",a.record(18,19,0,fields={"model":"fixture","checkpoint":"v1"}))
checks.append("Named model tensors, reversible output names, endian conversion and required provenance")

binding("physical_fixture","physical-ai","transition-v1")
record=a.transition(client,np.array([1,2],dtype=np.float32),{"motor":[0.5]},1.0,False,True,src=19,dst=20,timestamp_us=0)
roundtrip("physical_fixture",record)
bad("physical_fixture",a.record(19,20,0))
binding("ros_fixture","ros2","image")
record=a.ros_message(client,{"height":1,"width":2,"step":2,"encoding":"mono8","is_bigendian":False,"header":{"frame_id":"camera"}},message_type="sensor_msgs/msg/Image",topic="/camera",src=20,dst=21,timestamp_us=0,binary={"pixels":b"\x00\xff"})
roundtrip("ros_fixture",record)
assert client.read_asset(record["assets"]["pixels"])[1]==b"\x00\xff"
checks.append("Physical-AI transition contract and decoded ROS image with exact opaque media")
for check in checks: print("PASS",check)
print(json.dumps({"checks":len(checks),"physical_hardware_tested":False,"qpu_tested":False}))
