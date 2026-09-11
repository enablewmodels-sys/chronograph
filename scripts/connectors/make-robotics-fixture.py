#!/usr/bin/env python3
"""Generate small independent rosbags/MCAP fixtures. Refuses to replace existing files."""
import dataclasses
import json
import pathlib
import sys
import hashlib
import numpy as np
from rosbags.rosbag2 import Writer
from rosbags.typesys import get_typestore, Stores
from mcap.writer import Writer as McapWriter
import av

root = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path("examples/datasets/robotics")
root.mkdir(parents=True, exist_ok=True)
for name in ("rosbag2", "joints.mcap", "references.mcap", "messages.json", "joint-le.cdr", "joint-be.cdr", "camera"):
    if (root / name).exists():
        raise SystemExit(f"Refusing to overwrite {root / name}")
types = get_typestore(Stores.ROS2_HUMBLE)
Joint = types.types["sensor_msgs/msg/JointState"]
Header = types.types["std_msgs/msg/Header"]
Stamp = types.types["builtin_interfaces/msg/Time"]

def plain(v):
    if dataclasses.is_dataclass(v):
        return {f.name: plain(getattr(v, f.name)) for f in dataclasses.fields(v) if not f.name.startswith("_")}
    if isinstance(v, np.ndarray):
        return v.tolist()
    return v

messages = []
wire_messages = []
with Writer(root / "rosbag2", version=9) as bag, (root / "joints.mcap").open("xb") as out:
    connections = {topic: bag.add_connection(topic, "sensor_msgs/msg/JointState", typestore=types)
                   for topic in ("/joint_states", "/commands")}
    mc = McapWriter(out, chunk_size=512)
    mc.start(profile="ros2", library="Chronograph independent Python fixture")
    schema = mc.register_schema("sensor_msgs/msg/JointState", "ros2msg", types.generate_msgdef("sensor_msgs/msg/JointState")[0].encode())
    channels = {topic: mc.register_channel(topic, "cdr", schema) for topic in connections}
    sequence = 0
    # Deliberately late arrivals: timestamp order differs from record order.
    for i in (3, 0, 2, 1):
        for topic in connections:
            sequence += 1
            offset = 0.25 if topic == "/commands" else 0.0
            j = Joint(Header(Stamp(1, i * 50_000_000), "base"), ["shoulder", "elbow"],
                      np.array([i + offset, -i - offset], dtype=np.float64),
                      np.array([0.1, 0.2], dtype=np.float64), np.array([], dtype=np.float64))
            timestamp = 1_000_000_000 + i * 50_000_000
            wire = types.serialize_cdr(j, j.__msgtype__)
            bag.write(connections[topic], timestamp, wire)
            mc.add_message(channels[topic], timestamp, bytes(wire), timestamp, sequence)
            messages.append({"topic": topic, "log_time_ns": timestamp, "publish_time_ns": timestamp,
                             "sequence": sequence, "data": {"type": "joint_state", "value": plain(j)}})
            wire_messages.append((topic, timestamp, bytes(wire), sequence))
            if sequence == 1:
                (root / "joint-le.cdr").write_bytes(wire)
                (root / "joint-be.cdr").write_bytes(types.serialize_cdr(j, j.__msgtype__, little_endian=False))
    mc.finish()
(root / "messages.json").write_text(json.dumps(messages, indent=2) + "\n")
(root / "camera").mkdir()
with av.open(str(root / "camera/episode.mp4"), mode="w") as video:
    stream = video.add_stream("libx264", rate=20)
    stream.width, stream.height, stream.pix_fmt = 64, 64, "yuv420p"
    for i in range(4):
        pixels = np.zeros((64, 64, 3), dtype=np.uint8)
        pixels[:, :, 1] = 40 + i * 50
        for packet in stream.encode(av.VideoFrame.from_ndarray(pixels, format="rgb24")):
            video.mux(packet)
    for packet in stream.encode():
        video.mux(packet)
checksum = hashlib.sha256((root / "camera/episode.mp4").read_bytes()).hexdigest()
with (root / "references.mcap").open("xb") as output:
    mc = McapWriter(output, chunk_size=512)
    mc.start(library="Chronograph independent mixed-encoding fixture")
    sid = mc.register_schema("sensor_msgs/msg/JointState", "ros2msg", types.generate_msgdef("sensor_msgs/msg/JointState")[0].encode())
    channels = {topic: mc.register_channel(topic, "cdr", sid) for topic in ("/joint_states", "/commands")}
    schema = {"type": "object", "properties": {"path": {"type": "string"}, "timestamp_ns": {"type": "integer"}, "sha256": {"type": "string"}}, "required": ["path", "timestamp_ns", "sha256"], "additionalProperties": False}
    sid = mc.register_schema("chronograph/VideoReference", "jsonschema", json.dumps(schema).encode())
    channel = mc.register_channel("/camera/reference", "json", sid)
    for topic, timestamp, wire, seq in wire_messages:
        mc.add_message(channels[topic], timestamp, wire, timestamp, seq)
    for i in range(4):
        timestamp = 1_000_000_000 + i * 50_000_000
        ref = {"path": "camera/episode.mp4", "timestamp_ns": i * 50_000_000, "sha256": checksum}
        mc.add_message(channel, timestamp, json.dumps(ref).encode(), timestamp, 9 + i)
    mc.finish()
print(f"Wrote {len(messages)} real CDR messages to rosbag2 SQLite and compressed MCAP under {root}")
