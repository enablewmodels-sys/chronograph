import { useMemo, useState } from "react";
import catalog from "./brainflow-boards.json";
import {
  BCI_UNATTRIBUTED_COUNT,
  BCI_VENDOR_COUNT,
  BCI_VENDORS,
  vendorLabel,
} from "./bci-vendors";
// The catalogue's narrow-screen layout. The table stays the table above 720px; below it the
// same rows become cards, and nothing here is a second rendering of the catalogue.
import "./boards.css";

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
 *
 * WHY this surface hands the chosen board back to the workspace: browsing a catalogue
 * that cannot configure anything made "Use" a button that only highlighted its own row.
 * The board and preset a person picks here become the source the setup form is already
 * on, so the catalogue is a way into a recording rather than a list beside one.
 */
export default function Boards({
  onUse,
}: {
  onUse?: (boardId: number, preset: number) => void;
}) {
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
  const rows = chosen?.channels ?? board?.channels ?? 0;
  const command = board
    ? "chronograph-bci brainflow --board-id " +
      board.id +
      " --preset " +
      (chosen?.preset ?? 0) +
      " --units uV --seconds 60 --spool ./recording --sync"
    : "";

  return (
    <section className="bci-panel bci-boards board-catalogue">
      <div className="board-summary">
        <div>
          <h2>Device catalogue</h2>
          <p className="small muted">
            {catalog.counts.describable} of {catalog.counts.boards} board IDs
            described from the installed BrainFlow {catalog.brainflow_version} ·{" "}
            {BCI_VENDOR_COUNT} vendors ·{" "}
            {catalog.boards.reduce((n, b) => n + b.presets.length, 0)} presets
            {BCI_UNATTRIBUTED_COUNT
              ? " · " + BCI_UNATTRIBUTED_COUNT + " without a vendor"
              : ""}
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
              {/* The rows carry the column names as values as well as the header cells above
                  them: below 720px the table stacks into cards and the header row goes away,
                  so each cell's own label is what a card shows. One row, read two ways. */}
              <td data-label="Vendor">{vendorLabel(entry.vendor)}</td>
              <td className="board-card-head">
                <strong>{entry.device ?? entry.name}</strong>
                <span className="small muted">
                  {" "}
                  {entry.name} · #{entry.id}
                </span>
              </td>
              <td data-label="Signal">{modality(entry)}</td>
              <td data-label="Rate">{entry.rate ? entry.rate + " Hz" : "—"}</td>
              <td data-label="Channels">{entry.channels || "—"}</td>
              <td data-label="Presets">{entry.presets.length}</td>
              <td className="board-card-use">
                <button
                  className="text-link"
                  onClick={() => {
                    setSelected(entry.id);
                    setPreset(entry.presets[0]?.preset ?? 0);
                    onUse?.(entry.id, entry.presets[0]?.preset ?? 0);
                  }}
                >
                  Use
                </button>
              </td>
            </tr>
          ))}
          {!shown.length && (
            <tr className="board-empty-row">
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
            {board.device ?? board.name} <span className="bci-chip">#{board.id}</span>
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
                    {entry.name} · {entry.rate ?? "?"} Hz · {entry.channels} rows
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="small muted board-channels">
            {rows} rows at {chosen?.rate ?? board.rate ?? "unknown"} Hz,{" "}
            {modality(board)}. {board.channel_names.length} channel names:{" "}
            {board.channel_names.length
              ? board.channel_names.slice(0, 12).join(", ")
              : "derived from the descriptor rows"}
            {board.channel_names.length > 12
              ? "… and " + (board.channel_names.length - 12) + " more"
              : ""}
          </p>
          {onUse && (
            <button
              className="button primary"
              onClick={() => onUse(board.id, chosen?.preset ?? 0)}
            >
              Configure a recording on this board
            </button>
          )}
          <p className="small muted">
            This deployment records the board's geometry itself, so nothing has to be
            installed here. On a machine wired to the device, the same board runs as:
          </p>
          {/* The command is the widest unbreakable line in the panel. It scrolls inside this
              container at narrow widths, so the page never does. */}
          <div className="board-command-scroll">
            <pre className="board-command">{command}</pre>
          </div>
        </div>
      )}

      <p className="small muted">
        Physical boards are described, not certified: only the synthetic board and local
        files are exercised by the test suite.{" "}
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
