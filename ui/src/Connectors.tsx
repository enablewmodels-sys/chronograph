import { Activity, Bot, Boxes, Atom, ArrowUpRight } from "lucide-react";
import { Link } from "react-router-dom";
import { Code, Head } from "./shared";
import ConnectorConsole from "./ConnectorConsole";
export const connectors = [
  {
    id: "bci",
    name: "BCI & neural signals",
    title: "Keep signal timing intact.",
    icon: Activity,
    state: "Synthetic + optional LSL",
    description:
      "Ingest timestamped channel frames. Preserve acquisition order and export epochs as Arrow.",
    detail:
      "Native LSL loopback verified; physical hardware and cross-host synchronization remain unverified.",
    command:
      "cargo run --locked -p chronograph-conn-bci --example bci_connector",
    mapping: "examples/datasets/bci/mapping.toml",
  },
  {
    id: "robotics",
    name: "Robotics & physical AI",
    title: "Replay the world a robot observed.",
    icon: Bot,
    state: "JointState + video references",
    description:
      "Read rosbag2 and MCAP captures, map joint observations and actions, and export real LeRobot datasets.",
    detail:
      "Bounded JointState schemas and external video references; no automatic video decoding or arbitrary ROS messages.",
    command:
      "cargo run --locked -p chronograph-conn-robotics --example robotics_connector -- ./robotics-demo",
    mapping: "examples/datasets/robotics/mapping.toml",
  },
  {
    id: "worldmodel",
    name: "World models",
    title: "Restore state. Explore the next action.",
    icon: Boxes,
    state: "Complete state + RNG",
    description:
      "Record environment steps, restore full simulator state, fork policy futures, and export Arrow or Minari.",
    detail:
      "Discrete actions and fixed-size observations; bring a versioned complete-state codec for another environment.",
    command:
      "cargo run --locked --release -p chronograph-conn-worldmodel --example fork_demo -- ./fork-demo",
    mapping: "examples/datasets/worldmodel/mapping.toml",
  },
  {
    id: "quantum",
    name: "Quantum experiments",
    title: "Track circuits and calibration drift.",
    icon: Atom,
    state: "Exploratory",
    description:
      "Turn a static OpenQASM 3 unitary program into a circuit DAG. Track directed coupling calibration windows.",
    detail:
      "A strict static subset, with unsupported programs rejected. No QPU or quantum simulator integration.",
    command:
      "cargo run --locked -p chronograph-conn-quantum --example quantum_connector",
    mapping: "examples/datasets/quantum/mapping.toml",
  },
];
export default function Connectors() {
  return (
    <>
      <Head
        title="Bring your world into the graph."
        text="Explicit mappings, preserved clocks, and portable datasets."
      />
      <div className="notice informational">
        Configure normalized record connectors in Schema → Migrations. Native
        Rust adapters and local conversion tools remain available in the guides
        below.
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
              <p className="small muted">{c.detail}</p>
              <p className="connector-mapping">
                <span>Mapping file</span>
                <code>{c.mapping}</code>
              </p>
              <Code text={c.command} />
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
