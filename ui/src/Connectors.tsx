import { Activity, Bot, Boxes, Atom, ArrowUpRight } from "lucide-react";
import { Link } from "react-router-dom";
import { managedSite } from "./site";
import { Code, Head } from "./shared";
import ConnectorConsole from "./ConnectorConsole";
import catalog from "./brainflow-boards.json";
export const connectors = [
  {
    id: "bci",
    name: "BCI & neural signals",
    title: "Record the board you actually own.",
    icon: Activity,
    state:
      catalog.counts.describable +
      " of " +
      catalog.counts.boards +
      " boards · BrainFlow " +
      catalog.brainflow_version,
    description:
      "Open any board the installed BrainFlow driver defines, or any LSL outlet, and keep every original timestamp. Then hand the recording to MNE, train a decoder and branch the result.",
    detail:
      "The console opens no hardware: the agent runs where the device is wired. Only the synthetic board and local files are exercised by the test suite.",
    snippet:
      "pip install './sdk/python[bci]'\n" +
      "chronograph-bci brainflow --board-id -1 --preset 0 --units uV \\\n" +
      "  --seconds 60 --spool ./recording --sync",
    /* WHAT a hosted account is told instead. WHY the SDK line is not shown here: on this
       deployment nothing has to be installed to record, and a connector page that opens with
       "pip install" tells a hosted reader the opposite. The SDK stays available for their own
       hardware, and the guides say so. */
    managedDetail:
      "This deployment records for you: open the BCI workspace, choose a board, and review the " +
      "migration. The deployment then writes a simulated BrainFlow session into the project at " +
      "that board's own geometry. Install nothing — the SDK is for your own hardware, for a " +
      "decoder you run yourself, or for exporting a session.",
    mapping: "BCI workspace → Boards lists every board, preset and channel name",
  },
  {
    id: "robotics",
    name: "Robotics & physical AI",
    title: "Replay the world a robot observed.",
    icon: Bot,
    state: "JointState + video references",
    description:
      "Record decoded joint observations, actions and rewards on the same timeline as the signal that caused them, so a robot run stays explainable afterwards.",
    detail:
      "Bounded JointState schemas and external video references; no automatic video decoding or arbitrary ROS messages.",
    snippet:
      "from chronograph_connectors.adapters import ros_message\n" +
      "client.ingest('robot_observations', 'run_1', '0', [\n" +
      "    ros_message(client, decoded, message_type='sensor_msgs/JointState',\n" +
      "                topic='/joint_states', src='1', dst='2', timestamp_us='0'),\n" +
      "])",
    mapping: "examples/datasets/robotics/mapping.toml",
  },
  {
    id: "worldmodel",
    name: "World models",
    title: "Restore state. Explore the next action.",
    icon: Boxes,
    state: "Complete state + RNG",
    description:
      "Record environment steps, restore full simulator state, fork policy futures and export Arrow or Minari.",
    detail:
      "Discrete actions and fixed-size observations; bring a versioned complete-state codec for another environment.",
    snippet:
      "from chronograph_connectors.adapters import transition\n" +
      "step = transition(client, observation, action, reward,\n" +
      "                  terminated, truncated, src='2', dst='3',\n" +
      "                  timestamp_us='20000', episode='episode_1')\n" +
      "client.ingest('robot_transitions', 'episode_1', '0', [step])",
    mapping: "examples/datasets/worldmodel/mapping.toml",
  },
  {
    id: "quantum",
    name: "Quantum experiments",
    title: "Track circuits and calibration drift.",
    icon: Atom,
    state: "Exploratory",
    description:
      "Store circuit source and measurement results with their provenance. Your runtime executes; the database records.",
    detail:
      "Source is kept as an opaque artifact and is never executed here. No QPU or simulator integration.",
    snippet:
      "from chronograph_connectors.adapters import qiskit_circuit, qiskit_result\n" +
      "client.ingest('quantum_circuits', 'run_1', '0', [\n" +
      "    qiskit_circuit(client, circuit, src='1', dst='2', timestamp_us='0'),\n" +
      "])",
    mapping: "examples/datasets/quantum/mapping.toml",
  },
];
export default function Connectors() {
  return (
    <>
      <Head
        title="Bring your world into the graph."
        text="One encoder, one writer, one decoder interface — whatever produced the samples."
      />
      <div className="notice informational">
        Configure a connector binding in Schema → Migrations.{" "}
        {managedSite
          ? "The BCI workspace records a simulated session for you; the other connectors are written from the SDK, and each guide shows how."
          : "Then record with the SDK below."}{" "}
        <Link to="/app/bci">Open the BCI workspace</Link> to see the device
        catalogue, branch a decode and replay a moment.
      </div>
      <ConnectorConsole />
      <div className="connector-workspace">
        {connectors.map((c) => (
          <section className="panel connector-detail" key={c.id}>
            <div className={`connector-symbol ${c.id}`}>
              <c.icon size={34} strokeWidth={1.3} />
            </div>
            <div>
              <div className="section-head">
                <h2>{c.name}</h2>
                <span className="scope-badge">{c.state}</span>
              </div>
              <p>{c.description}</p>
              <p className="small muted">
                {managedSite && c.managedDetail ? c.managedDetail : c.detail}
              </p>
              {managedSite && c.id === "bci" ? (
                <p className="connector-mapping">
                  <span>Start here</span>
                  <Link to="/app/bci">BCI workspace → Connect recording</Link>
                </p>
              ) : (
                <Code text={c.snippet} />
              )}
              <p className="connector-mapping">
                <span>Details</span>
                <code>{c.mapping}</code>
              </p>
              <Link
                className="text-link"
                to={`/documentation/connectors/${c.id}`}
              >
                Open connector guide <ArrowUpRight size={16} />
              </Link>
            </div>
          </section>
        ))}
      </div>
      <section className="panel form-panel">
        <h2>Keep the source clock explicit.</h2>
        <p>
          Choose a clock domain in the mapping. Original acquisition timestamps
          stay in sidecars where supported. The engine treats microseconds as
          ordered values; it does not synchronize independent devices for you.
        </p>
        <Link className="text-link" to="/documentation/FORMAT">
          Read the storage format <ArrowUpRight size={16} />
        </Link>
      </section>
    </>
  );
}
