import { useMemo, useState } from "react";
import catalog from "./brainflow-boards.json";
import { BCI_VENDORS, vendorLabel } from "./bci-vendors";

type Board = (typeof catalog.boards)[number];

const MODALITY_LABEL: Record<string, string> = {
  eeg: "EEG",
  emg: "EMG",
  ecg: "ECG",
  eog: "EOG",
  eda: "EDA",
  ppg: "PPG",
  optical: "optical",
  accel: "accelerometer",
  gyro: "gyroscope",
  rotation: "rotation",
  analog: "analog",
  temperature: "temperature",
  resistance: "resistance",
  magnetometer: "magnetometer",
};

function modality(board: Board) {
  return board.modality
    ? (MODALITY_LABEL[board.modality] ?? board.modality)
    : "no signal rows";
}

/**
 * The board catalogue, generated from the acquisition agent's own driver.
 *
 * Every board the installed BrainFlow defines is listed with the geometry it really
 * reports, so the console cannot promise a device the agent cannot open. Only the
 * synthetic board is exercised by the test suite, and a documented vendor whose board
 * is missing from the installed driver is shown as unavailable rather than invented.
 */
export default function Boards() {
  const [query, setQuery] = useState("");
  const [vendor, setVendor] = useState("all");
  const [selected, setSelected] = useState<number>(-1);
  const [preset, setPreset] = useState(0);

  // Shared with the source picker so both surfaces group boards the same way.
  const vendors = useMemo(() => BCI_VENDORS, []);
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return catalog.boards.filter((board) => {
      if (vendor !== "all" && board.vendor !== vendor) return false;
      if (!needle) return true;
      return (
        board.name.toLowerCase().includes(needle) ||
        String(board.device ?? "")
          .toLowerCase()
          .includes(needle) ||
        board.vendor.toLowerCase().includes(needle) ||
        board.channel_names.some((name) => name.toLowerCase().includes(needle))
      );
    });
  }, [query, vendor]);

  const board = catalog.boards.find((entry) => entry.id === selected);
  const chosen =
    board?.presets.find((entry) => entry.preset === preset) ??
    board?.presets[0];
  const command = board
    ? "chronograph-bci brainflow --board-id " +
      board.id +
      " --preset " +
      (chosen?.preset ?? 0) +
      " --units uV --seconds 60 --spool ./recording --sync"
    : "";

  return (
    <section className="bci-panel bci-boards">
      <div className="board-summary">
        <div>
          <h2>Device catalogue</h2>
          <p className="small muted">
            {catalog.counts.describable} of {catalog.counts.boards} board IDs
            described from the installed BrainFlow {catalog.brainflow_version} ·{" "}
            {vendors.length} documented vendors ·{" "}
            {catalog.boards.reduce((n, b) => n + b.presets.length, 0)} presets
          </p>
        </div>
        <span className="bci-chip">{catalog.counts.transports} transports</span>
      </div>

      <div className="board-filters">
        <label>
          Find a board
          <input
            type="search"
            value={query}
            placeholder="Muse, Cyton, Emotibit, C3…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label>
          Vendor
          <select
            value={vendor}
            onChange={(event) => setVendor(event.target.value)}
          >
            <option value="all">All vendors</option>
            {vendors.map((name) => (
              // The same label the source picker uses, from the same module.
              <option key={name} value={name}>
                {vendorLabel(name)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <table>
        <thead>
          <tr>
            <th>Vendor</th>
            <th>Board</th>
            <th>Signal</th>
            <th>Rate</th>
            <th>Channels</th>
            <th>Presets</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {shown.map((entry) => (
            <tr key={entry.name}>
              <td>{entry.vendor === "undocumented" ? "—" : entry.vendor}</td>
              <td>
                <strong>{entry.device ?? entry.name}</strong>
                <span className="small muted">
                  {" "}
                  {entry.name} · #{entry.id}
                </span>
              </td>
              <td>{modality(entry)}</td>
              <td>{entry.rate ? entry.rate + " Hz" : "—"}</td>
              <td>{entry.channels || "—"}</td>
              <td>{entry.presets.length}</td>
              <td>
                <button
                  className="text-link"
                  onClick={() => {
                    setSelected(entry.id);
                    setPreset(entry.presets[0]?.preset ?? 0);
                  }}
                >
                  Use
                </button>
              </td>
            </tr>
          ))}
          {!shown.length && (
            <tr>
              <td colSpan={7} className="small muted">
                No board matches that search.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {board && (
        <div className="board-detail">
          <h3>
            {board.device ?? board.name}{" "}
            <span className="bci-chip">#{board.id}</span>
          </h3>
          {board.presets.length > 1 && (
            <label>
              Preset
              <select
                value={preset}
                onChange={(event) => setPreset(Number(event.target.value))}
              >
                {board.presets.map((entry) => (
                  <option key={entry.preset} value={entry.preset}>
                    {entry.name} · {entry.rate ?? "?"} Hz · {entry.channels}{" "}
                    rows
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="small muted">
            {chosen?.channels ?? board.channels} rows at{" "}
            {chosen?.rate ?? board.rate ?? "unknown"} Hz, {modality(board)}.
            Channel names:{" "}
            {board.channel_names.length
              ? board.channel_names.slice(0, 12).join(", ")
              : "derived from the descriptor rows"}
            {board.channel_names.length > 12 ? "…" : ""}
          </p>
          <p className="small muted">
            Run this on the machine wired to the device. The console never opens
            hardware, and units are never inferred:
          </p>
          <pre className="board-command">{command}</pre>
        </div>
      )}

      <p className="small muted">
        Physical boards are described, not certified: only the synthetic board
        and local files are exercised by the test suite.{" "}
        {Object.keys(catalog.unavailable_vendors).length > 0 &&
          Object.entries(
            // The generated file holds an empty object when every documented vendor
            // is present, so the entry values need naming rather than inference.
            catalog.unavailable_vendors as Record<string, string[]>,
          )
            .map(
              ([name, members]) =>
                name +
                " (" +
                members.join(", ") +
                ") is documented by BrainFlow but absent from the installed driver",
            )
            .join("; ") + "."}
      </p>
    </section>
  );
}
