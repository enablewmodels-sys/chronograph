import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import Boards from "./Boards";
import catalog from "./brainflow-boards.json";

// One catalogue, two surfaces: this picker and the Boards tab both read the file
// generated from the acquisition agent's own BrainFlow driver, so the device list
// in the command preview can never drift from the one the SDK reports.
import {
  BCI_BOARD_COUNT,
  BCI_PRESET_COUNT,
  BCI_UNATTRIBUTED_COUNT,
  BCI_VENDORS,
  BCI_VENDOR_COUNT,
  boardById,
  boardsOf,
  channelTypeFor,
  defaultChannelNames,
  firstBoardOf,
  numberedChannelNames,
  presetOf,
  vendorLabel,
} from "./bci-vendors";
import { Link } from "react-router-dom";
import {
  Activity,
  ArrowRight,
  Download,
  Plus,
  RefreshCw,
  Radio,
  Play,
  Pause,
  Check,
  Terminal,
} from "lucide-react";
import { graph } from "./api";
import { useAuth } from "./main";
import { managedSite, publicSite } from "./site";
import { managedApi } from "./managed-api";
import { Logo, Code, useAction } from "./shared";
import {
  loadBrowserDecoder,
  decodeToken,
  type BrowserDecode,
} from "./browser-decoder";
import SiteFooter from "./SiteFooter";
import {
  bciRecord,
  bciRecords,
  publish,
  demoSession,
  demoDetail,
  demoWindow,
  saveJson,
  type BciSession,
  type BciDetail,
  type BciWindow,
  type BciRow,
} from "./bci-api";
import "./bci.css";

const shell = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

interface JobStatus {
  available: boolean;
  reason: string;
  jobs: {
    id: string;
    state: string;
    specification?: { recipe: string };
    result?: object;
  }[];
}

function Waveform({ data }: { data: BciWindow }) {
  const paths = useMemo(
    () =>
      data.channels.map((c) => {
        const values = c.envelope.flatMap((v) =>
          v ? [Math.abs(v[0]), Math.abs(v[1])] : [],
        );
        const peak = Math.max(1e-12, ...values);
        const d = c.envelope
          .map((v, i) =>
            v
              ? `M${((i / (data.points - 1)) * 1000).toFixed(2)},${(35 - (v[0] / peak) * 25).toFixed(2)}v${((-(v[1] - v[0]) / peak) * 25).toFixed(2)}`
              : "",
          )
          .join("");
        return {
          name: c.name,
          unit: c.unit,
          peak:
            c.unit === "V"
              ? `${(peak * 1e6).toFixed(1)} µV`
              : `${peak.toPrecision(3)} ${c.unit}`,
          d,
        };
      }),
    [data],
  );
  return (
    <div
      className="bci-wave"
      role="img"
      aria-label={`${paths.length} EEG channel waveform envelopes. Blank spans indicate missing or nonfinite samples.`}
    >
      <div className="bci-wave-meta">
        <span>CHANNEL</span>
        <span>ACQUISITION TIME · {data.clock_domain}</span>
        <span>SCALE</span>
      </div>
      {paths.map((c) => (
        <div className="bci-wave-row" key={c.name}>
          <span>{c.name}</span>
          <svg
            viewBox="0 0 1000 70"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path className="bci-baseline" d="M0 35H1000" />
            <path d={c.d} />
          </svg>
          <small>±{c.peak}</small>
        </div>
      ))}
      <div className="bci-time-labels">
        <span>{(Number(data.start_us) / 1e6).toFixed(2)} s</span>
        <span>{(Number(data.end_us) / 1e6).toFixed(2)} s</span>
      </div>
      <p className="bci-muted">
        Min/max envelope · Original sample values remain unchanged
        {data.nonfinite_values > 0
          ? ` · ${data.nonfinite_values} nonfinite values hidden`
          : ""}
      </p>
    </div>
  );
}
/**
 * Decode one shipped artifact in this browser.
 *
 * The console already serves a decoder and the module that reads it, so this is the
 * shortest honest answer to "does the browser agree with Python": it fetches both,
 * synthesises a band-coded window and shows the token that comes back.
 */
function BrowserDecodeCheck() {
  const action = useAction();
  const [loaded, setLoaded] = useState<Awaited<
    ReturnType<typeof loadBrowserDecoder>
  > | null>(null);
  const [token, setToken] = useState("");
  const [result, setResult] = useState<BrowserDecode | null>(null);
  const [failure, setFailure] = useState("");
  const vocabulary = loaded?.document.vocabulary ?? [];
  const load = () =>
    action.run(async () => {
      setFailure("");
      try {
        const next = await loadBrowserDecoder();
        setLoaded(next);
        const first = next.document.vocabulary[0] ?? "";
        setToken(first);
        setResult(decodeToken(next, first));
      } catch (error) {
        // useAction keeps a thrown error for its own notice; keep this one here too,
        // because "the module did not load" is the only thing the reader can act on.
        setFailure(error instanceof Error ? error.message : String(error));
      }
    });
  const decode = (next: string) => {
    setToken(next);
    if (!loaded) return;
    try {
      setFailure("");
      setResult(decodeToken(loaded, next));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <section className="bci-panel">
      <div className="bci-section-title">
        <h2>Browser decoder check</h2>
        <span className="bci-chip">Same reader as Python</span>
      </div>
      <p>
        Decode the artifact this deployment serves, in your browser, through the
        module built from the same Rust crate the Python SDK and the CLI use.
        Nothing is uploaded and no weights are downloaded.
      </p>
      {!loaded ? (
        <button onClick={() => void load()} disabled={action.busy}>
          {action.busy ? "Loading the decoder…" : "Run a decode here"}
        </button>
      ) : (
        <>
          <div className="bci-fields">
            <label>
              Expected token
              <select value={token} onChange={(e) => decode(e.target.value)}>
                {vocabulary.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </label>
            <label>
              Adapter
              <input readOnly value={result?.adapter || ""} />
            </label>
            <label>
              Module
              <input
                readOnly
                value={`${(loaded.moduleBytes / 1024).toFixed(1)} kB · WebAssembly`}
              />
            </label>
          </div>
          {result && (
            <p className="bci-muted">
              {result.channels.length} channels · {result.windowSamples} samples ·{" "}
              {result.sampleRateHz} Hz · decoded{" "}
              <strong>{result.token ?? "no token"}</strong>
              {result.abstained ? " (abstained)" : ""} at{" "}
              {(result.probability * 100).toFixed(1)}% for an expected{" "}
              {result.expected}. The window is synthesised in the browser; the
              decoder is not.
            </p>
          )}
        </>
      )}
      {failure && (
        <p className="bci-error" role="alert">
          {failure}
        </p>
      )}
    </section>
  );
}

/**
 * One channel's recorded identity.
 *
 * The name is what an analyst reads on every waveform and export; the unit and the type
 * travel with the stream metadata, so a recording that says "uV EEG" is a claim the
 * engine stores rather than a label this page paints.
 */
interface ChannelSetting {
  name: string;
  unit: string;
  type: string;
}

/** Units a biosignal recording uses. The list is a dropdown so a typo cannot ship. */
const CHANNEL_UNITS = ["uV", "mV", "V", "raw", "%", "g", "deg/s", "C", "Ohm"];
/** Channel families the research contract accepts. */
const CHANNEL_TYPES = [
  "EEG",
  "EXG",
  "EMG",
  "ECG",
  "EOG",
  "EDA",
  "PPG",
  "ACC",
  "GYR",
  "MAG",
  "ROT",
  "TEMP",
  "IMP",
  "AIO",
  "CH",
];

/**
 * The channels a person starts from.
 *
 * A board arrives with the names its own driver reports - 8 on a Cyton, 16 on a Daisy,
 * 64 on an ANT Neuro EE 211 - and falls back to a numbered pattern in the board's signal
 * family when the driver reports none or reports fewer than the geometry declares. That
 * is why a 16- or 64-channel board no longer arrives with eight names and no way to
 * change them.
 */
function initialChannels(
  source: string,
  boardId: number,
  preset: number,
  count?: number,
): ChannelSetting[] {
  if (source === "synthetic") {
    const size = count ?? 8;
    return numberedChannelNames(-1, size, { prefix: "EEG", width: 2 }).map(
      (name) => ({ name, unit: "uV", type: "EEG" }),
    );
  }
  const board = boardById(boardId);
  const size = count ?? presetOf(boardId, preset)?.channels ?? board?.channels ?? 8;
  const reported = defaultChannelNames(boardId, preset).slice(0, size);
  const names =
    reported.length === size
      ? reported
      : numberedChannelNames(boardId, size);
  const type = channelTypeFor(board?.modality);
  return names.map((name) => ({
    name,
    unit: board?.modality === "accel" || board?.modality === "gyro" ? "g" : "uV",
    type: CHANNEL_TYPES.includes(type) ? type : "CH",
  }));
}

/** A name every channel can use at once, from a prefix, a start index and a width. */
function namesFrom(
  count: number,
  prefix: string,
  start: number,
  width: number,
  separator: string,
) {
  return Array.from(
    { length: count },
    (_, index) =>
      prefix + separator + String(start + index).padStart(width, "0"),
  );
}

/**
 * The channel editor.
 *
 * WHY a disclosure with a per-channel table: a 64-channel board needs 64 editable rows,
 * and a person renaming a montage wants one gesture that renames all of them. Both live
 * here: a pattern row that rewrites every name, unit and type at once, and the table that
 * overrides any single channel afterwards. Nothing is inferred from the board once a row
 * has been edited - what the table shows is exactly what the recording will claim.
 */
function ChannelEditor({
  channels,
  onChange,
  disabled,
}: {
  channels: ChannelSetting[];
  onChange: (next: ChannelSetting[]) => void;
  disabled?: boolean;
}) {
  const [prefix, setPrefix] = useState("EEG");
  const [start, setStart] = useState(1);
  const [width, setWidth] = useState(2);
  const [separator, setSeparator] = useState("");
  const [bulkUnit, setBulkUnit] = useState("uV");
  const [bulkType, setBulkType] = useState("EEG");
  const names = channels.map((channel) => channel.name);
  const duplicates = names.length !== new Set(names).size;
  const empty = channels.some((channel) => !channel.name.trim());
  const update = (index: number, patch: Partial<ChannelSetting>) =>
    onChange(
      channels.map((channel, at) =>
        at === index ? { ...channel, ...patch } : channel,
      ),
    );
  return (
    <details className="bci-channel-editor">
      <summary>
        Channels · {channels.length} configured
        {duplicates
          ? " · duplicate names"
          : empty
            ? " · a name is empty"
            : ""}
      </summary>
      <div className="bci-channel-bulk">
        <label>
          Pattern
          <select
            value="custom"
            disabled={disabled}
            onChange={(event) => {
              const value = event.target.value;
              if (value === "custom") return;
              const preset = {
                eeg: { prefix: "EEG", start: 1, width: 2, separator: "" },
                ch: { prefix: "CH", start: 1, width: 2, separator: "" },
                dash: { prefix: "EEG", start: 1, width: 2, separator: "-" },
                ten: { prefix: "EEG", start: 10, width: 2, separator: "" },
              }[value];
              if (!preset) return;
              setPrefix(preset.prefix);
              setStart(preset.start);
              setWidth(preset.width);
              setSeparator(preset.separator);
              onChange(
                namesFrom(
                  channels.length,
                  preset.prefix,
                  preset.start,
                  preset.width,
                  preset.separator,
                ).map((name, index) => ({ ...channels[index], name })),
              );
            }}
          >
            <option value="custom">Custom pattern</option>
            <option value="eeg">EEG01, EEG02, …</option>
            <option value="ch">CH01, CH02, …</option>
            <option value="dash">EEG-01, EEG-02, …</option>
            <option value="ten">EEG10, EEG11, …</option>
          </select>
        </label>
        <label>
          Prefix
          <input
            value={prefix}
            maxLength={24}
            disabled={disabled}
            onChange={(event) => setPrefix(event.target.value)}
          />
        </label>
        <label>
          Start at
          <input
            type="number"
            min={0}
            max={9999}
            value={start}
            disabled={disabled}
            onChange={(event) => setStart(Number(event.target.value))}
          />
        </label>
        <label>
          Digits
          <select
            value={width}
            disabled={disabled}
            onChange={(event) => setWidth(Number(event.target.value))}
          >
            {[1, 2, 3, 4].map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <label>
          Separator
          <select
            value={separator}
            disabled={disabled}
            onChange={(event) => setSeparator(event.target.value)}
          >
            <option value="">none</option>
            <option value="-">dash</option>
            <option value="_">underscore</option>
            <option value=" ">space</option>
          </select>
        </label>
        <button
          type="button"
          disabled={disabled}
          onClick={() =>
            onChange(
              namesFrom(channels.length, prefix, start, width, separator).map(
                (name, index) => ({ ...channels[index], name }),
              ),
            )
          }
        >
          Name all {channels.length} channels
        </button>
        <label>
          Unit for all
          <select
            value={bulkUnit}
            disabled={disabled}
            onChange={(event) => {
              setBulkUnit(event.target.value);
              onChange(
                channels.map((channel) => ({
                  ...channel,
                  unit: event.target.value,
                })),
              );
            }}
          >
            {CHANNEL_UNITS.map((unit) => (
              <option key={unit}>{unit}</option>
            ))}
          </select>
        </label>
        <label>
          Type for all
          <select
            value={bulkType}
            disabled={disabled}
            onChange={(event) => {
              setBulkType(event.target.value);
              onChange(
                channels.map((channel) => ({
                  ...channel,
                  type: event.target.value,
                })),
              );
            }}
          >
            {CHANNEL_TYPES.map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
        </label>
      </div>
      {duplicates && (
        <p role="alert" className="bci-error">
          Two channels share a name. Names identify a channel in every export, so they
          have to be unique.
        </p>
      )}
      <div className="bci-channel-table">
        <div className="bci-channel-head">
          <span>#</span>
          <span>Name</span>
          <span>Unit</span>
          <span>Type</span>
        </div>
        {channels.map((channel, index) => (
          <div className="bci-channel-row" key={index}>
            <span>{index + 1}</span>
            <input
              value={channel.name}
              maxLength={128}
              disabled={disabled}
              aria-label={"Channel " + (index + 1) + " name"}
              onChange={(event) => update(index, { name: event.target.value })}
            />
            <select
              value={channel.unit}
              disabled={disabled}
              aria-label={"Channel " + (index + 1) + " unit"}
              onChange={(event) => update(index, { unit: event.target.value })}
            >
              {CHANNEL_UNITS.map((unit) => (
                <option key={unit}>{unit}</option>
              ))}
            </select>
            <select
              value={channel.type}
              disabled={disabled}
              aria-label={"Channel " + (index + 1) + " type"}
              onChange={(event) => update(index, { type: event.target.value })}
            >
              {CHANNEL_TYPES.map((type) => (
                <option key={type}>{type}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
      <p className="bci-muted">
        These names, units and types are what the recording carries. The waveform and
        every export read them back.
      </p>
    </details>
  );
}

/** What the deployment reports about its own managed producer. */
interface AcquisitionStatus {
  available: boolean;
  runtime: string;
  reason: string;
  seedSeconds: number;
  maxSeconds: number;
  maxLiveSeconds: number;
  gapAtSeconds: number;
  running: {
    id: string;
    instance: string;
    session: string;
    state: string;
    device: string;
    clockDomain: string;
    channels: number;
    rate: number;
    seconds: number;
    writtenSeconds: number;
    chunks: number;
    live: boolean;
    failure: string | null;
  }[];
}

/**
 * The managed producer panel.
 *
 * WHY the workspace shows this instead of a pip line: on a hosted deployment the account
 * has no terminal in the loop, so "install the SDK and run this command" is an unfinished
 * product. This panel asks the deployment for the recording, reports what it wrote, and
 * is the only place a hosted account has to look.
 */
function ManagedRecording({
  instance,
  clockDomain,
  channels,
  rate,
  source,
  boardId,
  boardPreset,
  reference,
  onWrote,
}: {
  instance: string;
  clockDomain: string;
  channels: ChannelSetting[];
  rate: number;
  source: string;
  boardId: number;
  boardPreset: number;
  reference: string;
  onWrote: () => void;
}) {
  const action = useAction();
  const [status, setStatus] = useState<AcquisitionStatus | null>(null);
  const [ready, setReady] = useState<{ created: boolean; sessions: number } | null>(
    null,
  );
  const [failure, setFailure] = useState("");
  const asked = useRef(false);
  const request = () => ({
    instance,
    clockDomain,
    stream: "eeg",
    source,
    boardId,
    preset: boardPreset,
    rate,
    reference,
    channels: channels.map((channel) => ({
      name: channel.name,
      unit: channel.unit,
      type: channel.type,
    })),
  });
  const read = useCallback(async () => {
    setStatus(await managedApi<AcquisitionStatus>("/managed/bci/acquisition"));
  }, []);
  useEffect(() => {
    void read().catch(() => {});
  }, [read]);
  // A hosted workspace should not open empty. This asks the deployment for a recording
  // once, and the deployment answers with the one it already holds rather than a second.
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void (async () => {
      try {
        const result = await managedApi<{ created: boolean; sessions: number }>(
          "/managed/bci/acquisition",
          { action: "ensure", ...request() },
        );
        setReady(result);
        await read();
        if (result.created) onWrote();
      } catch (error) {
        setFailure(error instanceof Error ? error.message : String(error));
      }
    })();
  }, []);
  const runs = status?.running ?? [];
  return (
    <div className="bci-managed">
      <p className="bci-success">
        <Check size={16} /> Database configured. This deployment records it for you.
      </p>
      {failure && (
        <p role="alert" className="bci-error">
          {failure}
        </p>
      )}
      {ready && (
        <p className="bci-muted">
          {ready.created
            ? "A simulated BrainFlow recording is being written now."
            : "This workspace already holds " +
              ready.sessions +
              " recording" +
              (ready.sessions === 1 ? "" : "s") +
              " for " +
              instance +
              "."}
        </p>
      )}
      {!ready && !failure && (
        <p className="bci-muted" role="status">
          Preparing a simulated BrainFlow recording…
        </p>
      )}
      <div className="bci-actions">
        <button
          className="button"
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              await managedApi("/managed/bci/acquisition", {
                action: "start",
                ...request(),
                seconds: 5,
                live: true,
              });
              await read();
              onWrote();
            }, "Live recording started.")
          }
        >
          <Play size={15} /> Start live recording
        </button>
        <button
          className="button outline"
          disabled={action.busy || !runs.length}
          onClick={() =>
            void action.run(async () => {
              for (const run of runs) {
                if (run.state === "running")
                  await managedApi("/managed/bci/acquisition", {
                    action: "stop",
                    id: run.id,
                  });
              }
              await read();
            }, "Recording stopped.")
          }
        >
          <Pause size={15} /> Stop
        </button>
        <button
          className="ghost"
          disabled={action.busy}
          onClick={() => void action.run(read)}
        >
          <RefreshCw size={15} /> Refresh
        </button>
      </div>
      {action.feedback}
      <div className="bci-recording-list">
        {runs.map((run) => (
          <article key={run.id}>
            <div>
              <strong>
                Session {run.session} · {run.device}
              </strong>
              <small>
                {run.state} · {run.writtenSeconds.toFixed(1)} s · {run.chunks}{" "}
                chunks · {run.channels} channels · {run.rate} Hz · {run.clockDomain}
              </small>
            </div>
          </article>
        ))}
      </div>
      {runs.some((run) => run.failure) && (
        <p role="alert" className="bci-error">
          {runs.find((run) => run.failure)?.failure}
        </p>
      )}
      <p className="bci-muted">
        The recording is a BrainFlow synthetic signal at the board's own geometry: alpha,
        theta and beta rhythms, cue-locked trials, one deliberate acquisition pause at{" "}
        {status?.gapAtSeconds ?? 13} s and channel noise. No device is opened and no
        weight is downloaded.
      </p>
      <Link to="/documentation/BCI">
        Recording contract and exports <ArrowRight size={14} />
      </Link>
    </div>
  );
}

/**
 * Configure one recording.
 *
 * The board decides the geometry and the person decides the identity: a board arrives
 * with its own channel count, its driver's channel names and its rate, and every one of
 * those is editable before the migration is reviewed. What is reviewed is what is
 * recorded.
 */
function Setup({
  onDone,
  initialBoard,
  initialPreset,
}: {
  onDone: () => void;
  initialBoard?: number;
  initialPreset?: number;
}) {
  const managed = managedSite;
  const fallbackVendor = BCI_VENDORS[0] || "";
  const defaultBoard = initialBoard ?? (managed ? 0 : firstBoardOf(fallbackVendor));
  const [source, setSource] = useState(managed ? "brainflow" : "synthetic");
  const [instance, setInstance] = useState("bci_research");
  const [clock, setClock] = useState("unix_us");
  const [vendor, setVendor] = useState(
    boardById(defaultBoard)?.vendor ?? fallbackVendor,
  );
  const [board, setBoard] = useState(defaultBoard);
  const [boardPreset, setBoardPreset] = useState(initialPreset ?? 0);
  const [reference, setReference] = useState("unspecified");
  const [rate, setRate] = useState(presetOf(defaultBoard, initialPreset ?? 0)?.rate ?? 250);
  const [channels, setChannels] = useState<ChannelSetting[]>(() =>
    initialChannels(managed ? "brainflow" : "synthetic", defaultBoard, initialPreset ?? 0),
  );
  const [preview, setPreview] = useState<{
    source: string;
    checksum: string;
    expected_revision: number;
  } | null>(null);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /** Adopt a board, its rate and its channel names in one gesture. */
  const adopt = (nextBoard: number, nextPreset: number) => {
    setBoard(nextBoard);
    setBoardPreset(nextPreset);
    const chosen = presetOf(nextBoard, nextPreset);
    if (chosen?.rate) setRate(chosen.rate);
    setChannels(initialChannels("brainflow", nextBoard, nextPreset));
  };
  const adoptSource = (next: string) => {
    setSource(next);
    setClock(next === "lsl" ? "lsl_local_us" : "unix_us");
    if (next === "synthetic") {
      setRate(250);
      setChannels(initialChannels("synthetic", -1, 0, 8));
    } else adopt(board, boardPreset);
  };
  const names = channels.map((channel) => channel.name);
  const unit = channels[0]?.unit || "uV";
  const command = `chronograph-bci ${source === "file" ? "import" : source} --url ${managed ? "https://chronodb.co" : "http://127.0.0.1:8080"} \\\n  --instance ${instance} --clock-domain ${clock} --spool ./bci-recording \\\n  --partition recording_01 --sync` +
    (source === "synthetic"
      ? ` --rate ${rate} --channels ${shell(names.join(","))} --units ${shell(unit)} --seconds 30 --realtime`
      : source === "brainflow"
        ? ` --board-id ${board}${boardPreset ? ` --preset ${boardPreset}` : ""} --units ${shell(unit)} --seconds 60`
        : source === "lsl"
          ? ` --source-id YOUR_SOURCE_ID --channels ${shell(names.join(","))} --units ${shell(unit)}`
          : " \\\n  --input ./recording.edf --start-us YOUR_ACQUISITION_START_US");
  async function prepare() {
    setBusy(true);
    setError("");
    try {
      if (
        !/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(instance) ||
        !Number.isFinite(rate) ||
        rate < 80 ||
        rate > 100000
      )
        throw Error("Use a valid instance name and sample rate (80–100000 Hz).");
      if (!channels.length || channels.length > 512)
        throw Error("Configure between 1 and 512 channels.");
      if (names.some((name) => !name.trim() || name.length > 128))
        throw Error("Every channel needs a name of 1–128 characters.");
      if (new Set(names).size !== names.length)
        throw Error("Channel names have to be unique.");
      const schema = await graph<{
        relations: { kind: number }[];
        connectors: { id: string; connector: string; clock_domain: string }[];
      }>("schema");
      const old = schema.connectors.find((b) => b.id === instance);
      if (old) {
        if (old.connector !== "bci" || old.clock_domain !== clock)
          throw Error(
            "This instance has a different contract. Choose a new name.",
          );
        setApplied(true);
        return;
      }
      const used = new Set(schema.relations.map((r) => r.kind));
      let kind = 430;
      while (used.has(kind) && kind < 65535) kind++;
      const generated = await graph<{ source: string }>("connector_template", {
        id: instance,
        connector: "bci",
        preset: "research-v1",
        contract_version: 1,
        kind,
        clock_domain: clock,
      });
      const result = await graph<{
        checksum: string;
        expected_revision: number;
      }>("schema_preview", { source: generated.source });
      setPreview({
        source: generated.source,
        checksum: result.checksum,
        expected_revision: result.expected_revision,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!preview) return;
    setBusy(true);
    try {
      await graph("schema_apply", preview);
      setApplied(true);
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const locked = !!preview || applied;
  return (
    <section className="bci-panel bci-setup">
      <div className="bci-section-title">
        <h2>Connect a recording</h2>
        <span className="bci-chip">Research contract v1</span>
      </div>
      <div className="bci-fields">
        <label>
          Source
          <select
            value={source}
            disabled={locked}
            onChange={(e) => adoptSource(e.target.value)}
          >
            {managed ? (
              <>
                <option value="brainflow">
                  BrainFlow board · recorded by this deployment
                </option>
                <option value="synthetic">Synthetic EEG · no hardware</option>
              </>
            ) : (
              <>
                <option value="synthetic">Synthetic EEG · no hardware</option>
                <option value="brainflow">
                  BrainFlow · {BCI_BOARD_COUNT} boards, {BCI_VENDOR_COUNT} vendors
                </option>
                <option value="lsl">Lab Streaming Layer</option>
                <option value="file">Recorded EDF / BDF / FIF</option>
              </>
            )}
          </select>
        </label>
        {source === "brainflow" && (
          <>
            <label>
              Vendor
              <select
                value={vendor}
                disabled={locked}
                onChange={(e) => {
                  setVendor(e.target.value);
                  adopt(firstBoardOf(e.target.value), 0);
                }}
              >
                {BCI_VENDORS.map((name) => (
                  <option key={name} value={name}>
                    {vendorLabel(name)} · {boardsOf(name).length} boards
                  </option>
                ))}
              </select>
            </label>
            <label>
              Device
              <select
                value={board}
                disabled={locked}
                onChange={(e) => adopt(Number(e.target.value), 0)}
              >
                {boardsOf(vendor).map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} · {b.channels} ch · {b.rate} Hz
                    {b.describable ? "" : " · not described"}
                  </option>
                ))}
              </select>
            </label>
            {(catalog.boards.find((b) => b.id === board)?.presets.length || 0) >
              1 && (
              <label>
                Preset
                <select
                  value={boardPreset}
                  disabled={locked}
                  onChange={(e) => adopt(board, Number(e.target.value))}
                >
                  {(
                    catalog.boards.find((b) => b.id === board)?.presets || []
                  ).map((p) => (
                    <option key={p.preset} value={p.preset}>
                      {p.name} · {p.channels} ch · {p.rate} Hz
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p className="bci-note">
              {BCI_BOARD_COUNT} boards · {BCI_VENDOR_COUNT} vendors ·{" "}
              {BCI_PRESET_COUNT} presets from BrainFlow{" "}
              {catalog.brainflow_version}
              {BCI_UNATTRIBUTED_COUNT
                ? ` · ${BCI_UNATTRIBUTED_COUNT} without a vendor`
                : ""}
              . This board carries {channels.length} channels; the editor below
              renames them. The Boards tab lists every channel name.
            </p>
          </>
        )}
        <label>
          Instance
          <input
            value={instance}
            disabled={locked}
            onChange={(e) => setInstance(e.target.value)}
            pattern="[A-Za-z0-9_]+"
            maxLength={48}
          />
        </label>
        <label>
          Clock
          <select
            value={clock}
            disabled={locked}
            onChange={(e) => setClock(e.target.value)}
          >
            {["unix_us", "simulation_us", "lsl_local_us", "device_us"].map(
              (v) => (
                <option key={v}>{v}</option>
              ),
            )}
          </select>
        </label>
        {source !== "synthetic" && (
          <label>
            Original reference
            <input
              value={reference}
              disabled={locked}
              onChange={(e) => setReference(e.target.value)}
              maxLength={128}
            />
          </label>
        )}
        <label>
          Sample rate
          <input
            type="number"
            min={80}
            max={100000}
            value={rate}
            disabled={locked}
            onChange={(e) => setRate(Number(e.target.value))}
          />
        </label>
      </div>
      <ChannelEditor
        channels={channels}
        onChange={setChannels}
        disabled={locked}
      />
      {error && (
        <p role="alert" className="bci-error">
          {error}
        </p>
      )}
      {!applied && !preview && (
        <button
          className="button primary"
          onClick={() => void prepare()}
          disabled={busy}
        >
          Preview migration <ArrowRight size={16} />
        </button>
      )}
      {preview && !applied && (
        <>
          <Code text={preview.source} />
          <button
            className="button primary"
            onClick={() => void apply()}
            disabled={busy}
          >
            Apply reviewed migration
          </button>
          <button onClick={() => setPreview(null)}>Edit configuration</button>
        </>
      )}
      {applied &&
        (managed ? (
          <ManagedRecording
            instance={instance}
            clockDomain={clock}
            channels={channels}
            rate={rate}
            source={source}
            boardId={board}
            boardPreset={boardPreset}
            reference={reference}
            onWrote={onDone}
          />
        ) : (
          <>
            <p className="bci-success">
              <Check size={16} /> Database configured. Start your local producer.
            </p>
            <p>
              Install <code>pip install './sdk/python[bci,bci-hardware]'</code>{" "}
              from the Community checkout. Set <code>CHRONOGRAPH_TOKEN</code> to
              an ingest key in your terminal.
            </p>
            <Code text={command} />
            <Link to="/documentation/BCI">
              Acquisition instructions and hardware verification{" "}
              <ArrowRight size={14} />
            </Link>
          </>
        ))}
    </section>
  );
}

export function BCIWorkspace({ demo = false }: { demo?: boolean }) {
  const { connection } = useAuth();
  const synthetic = demo || connection?.edition === "synthetic";
  const write = !synthetic && connection?.credential.scope !== "read";
  const [tab, setTab] = useState("Sessions"),
    [sessions, setSessions] = useState<BciSession[]>(
      synthetic ? [demoSession] : [],
    ),
    [selection, setSelection] = useState(
      synthetic ? `${demoSession.instance}:${demoSession.session}` : "",
    ),
    [detail, setDetail] = useState<BciDetail | null>(
      synthetic ? demoDetail : null,
    ),
    [data, setData] = useState<BciWindow | null>(null),
    [stream, setStream] = useState("eeg"),
    [offset, setOffset] = useState(0),
    [span, setSpan] = useState(10),
    [channelIndices, setChannelIndices] = useState<number[]>([0, 1, 2, 3]),
    [playing, setPlaying] = useState(false),
    [live, setLive] = useState(false),
    [setup, setSetup] = useState(false),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [annotations, setAnnotations] = useState<BciRow[]>([]),
    [label, setLabel] = useState(""),
    [category, setCategory] = useState("cue"),
    [datasets, setDatasets] = useState<BciRow[]>([]),
    [runs, setRuns] = useState<BciRow[]>([]),
    [chosen, setChosen] = useState<string[]>([]),
    [datasetName, setDatasetName] = useState("EEG experiment"),
    [jobs, setJobs] = useState<JobStatus | null>(null),
    [jobDataset, setJobDataset] = useState(""),
    [jobComponents, setJobComponents] = useState(4),
    [jobBusy, setJobBusy] = useState(false),
    // The board a person picked in the catalogue, carried into the setup form so "Use"
    // there configures a recording instead of only highlighting a row.
    [setupBoard, setSetupBoard] = useState<{
      id: number;
      preset: number;
    } | null>(null),
    [managedNote, setManagedNote] = useState("");
  const current = sessions.find(
    (s) => `${s.instance}:${s.session}` === selection,
  );
  const selected = current?.session || "";
  const refresh = useCallback(async () => {
    if (synthetic) return;
    setLoading(true);
    try {
      const r = await graph<{ sessions: BciSession[] }>("bci_sessions", {
        limit: 100,
      });
      setSessions(r.sessions);
      setSelection((old) =>
        r.sessions.some((s) => `${s.instance}:${s.session}` === old)
          ? old
          : r.sessions[0]
            ? `${r.sessions[0].instance}:${r.sessions[0].session}`
            : "",
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [synthetic]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  /**
   * A hosted workspace should never open empty.
   *
   * The account has no terminal, so it cannot start a producer, and an account that has
   * applied a recording contract and then sees "no recordings" has been handed a dead
   * end. This asks the deployment for the recording it produces itself, exactly once,
   * and only when the project holds a contract and no session yet. The deployment answers
   * with the recording it already holds when one exists, so this is safe to ask again.
   */
  const [producers, setProducers] = useState<AcquisitionStatus["running"]>([]);
  const [producerBusy, setProducerBusy] = useState(false);
  const producerAction = useAction();
  const loadProducers = useCallback(async () => {
    if (!managedSite || synthetic) return;
    const status = await managedApi<AcquisitionStatus>("/managed/bci/acquisition");
    setProducers(status.running.filter((run) => run.state === "running"));
  }, [synthetic]);
  useEffect(() => {
    void loadProducers().catch(() => {});
  }, [loadProducers]);
  // A producer writes into this project whether or not this page is open, and one started from
  // another tab or by another member is just as invisible, so the workspace asks on a slow timer
  // for as long as it is open rather than only after it has already seen a run.
  useEffect(() => {
    if (!managedSite || synthetic) return;
    const timer = setInterval(() => {
      if (!document.hidden) void loadProducers().catch(() => {});
    }, 10000);
    return () => clearInterval(timer);
  }, [synthetic, loadProducers]);
  const stopProducers = () =>
    producerAction.run(async () => {
      setProducerBusy(true);
      try {
        for (const run of producers) {
          await managedApi("/managed/bci/acquisition", {
            action: "stop",
            id: run.id,
          });
        }
        await loadProducers();
        await refresh();
      } finally {
        setProducerBusy(false);
      }
    }, "Recording stopped.");
  const askedForRecording = useRef(false);
  useEffect(() => {
    if (!managedSite || synthetic || setup || loading || sessions.length) return;
    if (askedForRecording.current) return;
    askedForRecording.current = true;
    let active = true;
    void (async () => {
      try {
        const schema = await graph<{
          connectors: { id: string; connector: string; clock_domain: string }[];
        }>("schema");
        const binding = schema.connectors.find((c) => c.connector === "bci");
        if (!binding) {
          if (active) setManagedNote("");
          return;
        }
        const defaults = initialChannels("brainflow", 0, 0);
        const result = await managedApi<{ created: boolean; sessions: number }>(
          "/managed/bci/acquisition",
          {
            action: "ensure",
            instance: binding.id,
            clockDomain: binding.clock_domain,
            stream: "eeg",
            source: "brainflow",
            boardId: 0,
            preset: 0,
            rate: 250,
            reference: "unspecified",
            channels: defaults.map((channel) => ({
              name: channel.name,
              unit: channel.unit,
              type: channel.type,
            })),
          },
        );
        if (!active) return;
        setManagedNote(
          result.created
            ? "A simulated BrainFlow recording was written for this workspace."
            : "This workspace already holds " + result.sessions + " recording.",
        );
        if (result.created) await refresh();
      } catch (e) {
        // A missing contract, a project that cannot be reached or a deployment without a
        // producer all mean the same thing here: offer the manual setup instead.
        if (active) setManagedNote("");
      }
    })();
    return () => {
      active = false;
    };
  }, [synthetic, setup, loading, sessions.length, refresh]);
  useEffect(() => {
    let active = true;
    if (synthetic) {
      setDetail(demoDetail);
      return;
    }
    if (!current) return;
    void graph<BciDetail>("bci_session", {
      instance: current.instance,
      session: current.session,
    })
      .then((d) => {
        if (active) {
          setDetail(d);
          setOffset(0);
          setStream(d.streams[0]?.fields.stream_id || "eeg");
          setChannelIndices(
            Array.from(
              {
                length: Math.min(4, d.streams[0]?.fields.channels?.length || 0),
              },
              (_, i) => i,
            ),
          );
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [current?.instance, current?.session, synthetic]);
  useEffect(() => {
    setChosen([]);
    setDatasets([]);
    setRuns([]);
  }, [current?.instance]);
  const streamMeta = detail?.streams.find(
    (s) => s.fields.stream_id === stream,
  )?.fields;
  // Relative controls avoid precision loss when navigating Unix-microsecond clocks.
  const [origin, setOrigin] = useState(0);
  useEffect(() => {
    if (synthetic) {
      setOrigin(0);
      return;
    }
    if (!current) return;
    let active = true;
    void graph<{ records: BciRow[] }>("bci_records", {
      instance: current.instance,
      session: selected,
      stream,
      record_type: "signal",
      limit: 1,
    })
      .then((r) => {
        if (active) setOrigin(Number(r.records[0]?.record.timestamp_us || 0));
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [current?.instance, selected, stream, synthetic]);
  const loadWindow = useCallback(async () => {
    if (!current || !detail) return;
    if (!channelIndices.length) {
      setData(null);
      return;
    }
    const start = Math.round(origin + offset * 1e6),
      end = Math.round(start + span * 1e6);
    if (synthetic) {
      setData(demoWindow(start, end, channelIndices));
      return;
    }
    try {
      const r = await graph<BciWindow>("bci_window", {
        instance: current.instance,
        session: selected,
        stream,
        start: String(start),
        end: String(end),
        channels: channelIndices,
        points: 600,
      });
      setData(r);
      setAnnotations(r.events);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, [
    current?.instance,
    detail,
    selected,
    stream,
    origin,
    offset,
    span,
    channelIndices,
    synthetic,
  ]);
  useEffect(() => {
    void loadWindow();
  }, [loadWindow]);
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(
      () =>
        setOffset((t) =>
          t + 1 + span <
          Math.max(30, (Number(detail?.last_us || 0) - origin) / 1e6)
            ? t + 1
            : 0,
        ),
      1000,
    );
    return () => clearInterval(timer);
  }, [playing, span, detail?.last_us, origin]);
  useEffect(() => {
    if (!live || synthetic || !current) return;
    let active = true;
    const timer = setInterval(() => {
      if (document.hidden) return;
      void graph<BciDetail>("bci_session", {
        instance: current.instance,
        session: selected,
      })
        .then((d) => {
          if (active) {
            setDetail(d);
            setOffset(Math.max(0, (Number(d.last_us) - origin) / 1e6 - span));
            void loadWindow();
          }
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    }, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [live, synthetic, current?.instance, selected, origin, span, loadWindow]);
  useEffect(() => {
    if (!current || synthetic) return;
    let active = true;
    const type = tab === "Datasets" ? "dataset" : tab === "Runs" ? "run" : "";
    if (tab === "Runs")
      void bciRecords(current.instance, selected, "dataset")
        .then((rows) => {
          if (active) {
            setDatasets(rows);
            setJobDataset(rows[0]?.record.dst || "");
          }
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    if (type)
      void bciRecords(current.instance, selected, type)
        .then((rows) => {
          if (active) (type === "dataset" ? setDatasets : setRuns)(rows);
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    if (tab === "Runs" && managedSite)
      void managedApi<JobStatus>("/managed/bci/jobs")
        .then((v) => {
          if (active) setJobs(v);
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    return () => {
      active = false;
    };
  }, [tab, current?.instance, selected, synthetic]);
  useEffect(() => {
    if (tab !== "Runs" || !managedSite || synthetic) return;
    let active = true;
    const timer = setInterval(() => {
      if (!document.hidden)
        void managedApi<JobStatus>("/managed/bci/jobs")
          .then((v) => {
            if (active) setJobs(v);
          })
          .catch((e) => {
            if (active) setError(String(e));
          });
    }, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [tab, synthetic]);
  const submission = useRef<{ id: string; spec: string } | null>(null);
  async function queueJob() {
    if (!current || !jobDataset) return;
    setJobBusy(true);
    setError("");
    try {
      const specification = {
        recipe: "csp-lda-v1",
        instance: current.instance,
        session: selected,
        datasetId: jobDataset,
        components: jobComponents,
      };
      const spec = JSON.stringify(specification);
      if (submission.current?.spec !== spec)
        submission.current = { id: crypto.randomUUID(), spec };
      await managedApi("/managed/bci/jobs", {
        requestId: submission.current.id,
        specification,
      });
      submission.current = null;
      setJobs(await managedApi<JobStatus>("/managed/bci/jobs"));
    } catch (e) {
      setError(String(e));
    } finally {
      setJobBusy(false);
    }
  }
  async function cancelJob(id: string) {
    try {
      await managedApi("/managed/bci/jobs/cancel", { id });
      setJobs(await managedApi<JobStatus>("/managed/bci/jobs"));
    } catch (e) {
      setError(String(e));
    }
  }
  async function annotate() {
    if (!current || !detail || !label.trim()) return;
    try {
      const r = bciRecord(
        selected,
        "event",
        detail.metadata.fields.clock_domain,
        {
          stream_id: stream,
          label: label.trim(),
          category,
          end_us: String(Math.round(origin + (offset + span) * 1e6)),
        },
        String(Math.round(origin + offset * 1e6)),
      );
      await publish(current.instance, [r]);
      setLabel("");
      await loadWindow();
    } catch (e) {
      setError(String(e));
    }
  }
  async function makeDataset() {
    if (!current || !detail) return;
    setLoading(true);
    try {
      const selection = chosen.length ? chosen : [selected];
      const result = await graph<{ manifest: object }>("bci_manifest", {
        instance: current.instance,
        sessions: selection,
        stream,
      });
      const r = bciRecord(
        selected,
        "dataset",
        detail.metadata.fields.clock_domain,
        { name: datasetName, manifest: result.manifest },
      );
      await publish(current.instance, [r]);
      setDatasets(await bciRecords(current.instance, selected, "dataset"));
      saveJson(result.manifest, `bci-dataset-${r.dst}.json`);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="bci-workspace">
      <header className="bci-heading">
        <div>
          <p className="bci-eyebrow">
            {synthetic ? "INTERACTIVE RESEARCH DEMO" : "NEURAL DATA WORKSPACE"}
          </p>
          <h1>
            {synthetic ? "Follow a signal. Find its story." : "BCI workspace"}
          </h1>
          <p>
            {synthetic
              ? "Explore generated EEG, experimental cues and a visible recording gap. No hardware or account needed."
              : "Recordings, experiments and decoder history."}
          </p>
        </div>
        <div className="bci-actions">
          {synthetic ? (
            <span className="bci-chip">Synthetic data</span>
          ) : (
            <>
              <button
                onClick={() => void refresh()}
                disabled={loading}
                aria-label="Refresh sessions"
              >
                <RefreshCw size={17} />
              </button>
              {connection?.credential.scope === "admin" && (
                <button
                  className="button primary"
                  onClick={() => setSetup(!setup)}
                >
                  <Plus size={16} /> Connect recording
                </button>
              )}
            </>
          )}
        </div>
      </header>
      {setup && (
          <Setup
            key={setupBoard ? "board-" + setupBoard.id + "-" + setupBoard.preset : "default"}
            initialBoard={setupBoard?.id}
            initialPreset={setupBoard?.preset}
            onDone={() => void refresh()}
          />
        )}
        {managedNote && !setup && (
          <p className="bci-muted" role="status">
            {managedNote}
          </p>
        )}
        {/* A managed producer writes into this project whether or not this page is open, so the
            workspace says so wherever the reader is, with the way to stop it. */}
        {producers.length > 0 && (
          <section className="bci-panel bci-live-banner" role="status">
            <div>
              <strong>
                {producers.length === 1
                  ? "A recording is being written now."
                  : producers.length + " recordings are being written now."}
              </strong>
              <p className="bci-muted">
                {producers
                  .map(
                    (run) =>
                      run.device +
                      " · session " +
                      run.session +
                      " · " +
                      run.writtenSeconds.toFixed(0) +
                      " s · " +
                      run.clockDomain,
                  )
                  .join(" · ")}
              </p>
            </div>
            <button
              className="button outline"
              disabled={producerAction.busy || producerBusy}
              onClick={() => void stopProducers()}
            >
              <Pause size={15} /> Stop recording
            </button>
            {producerAction.feedback}
          </section>
        )}
      <BrowserDecodeCheck />
      <div className="bci-tabs" role="tablist" aria-label="BCI workspace">
        {["Sessions", "Datasets", "Runs", "Live", "Boards"].map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => {
              setTab(t);
              setLive(t === "Live");
              setPlaying(false);
            }}
          >
            {t === "Live" && <Radio size={14} />} {t}
          </button>
        ))}
      </div>
      {error && (
        <p className="bci-error" role="alert">
          {error}
        </p>
      )}
      {tab === "Boards" ? (
        <Boards
          onUse={(id, preset) => {
            setSetupBoard({ id, preset });
            setSetup(true);
            setTab("Sessions");
          }}
        />
      ) : !sessions.length ? (
        <section className="bci-panel bci-empty">
          <Activity size={34} />
          <h2>Your first recording starts here.</h2>
          <p>
            {managedSite
              ? "This deployment records a BrainFlow board for you, so nothing has to be installed or run on your machine. Pick a board, review its channels, and the recording arrives."
              : "Configure a source, start the local worker and watch your session arrive."}
          </p>
          <div className="bci-actions">
            {connection?.credential.scope === "admin" && (
              <button className="button primary" onClick={() => setSetup(true)}>
                Set up a recording <ArrowRight size={15} />
              </button>
            )}
            <Link to="/bci">Explore the sample session</Link>
          </div>
        </section>
      ) : (
        <>
          <div className="bci-sessionbar">
            <label>
              Recording
              <select
                value={selection}
                onChange={(e) => {
                  setSelection(e.target.value);
                  setData(null);
                }}
              >
                {sessions.map((s) => (
                  <option
                    value={`${s.instance}:${s.session}`}
                    key={s.instance + s.session}
                  >
                    {s.metadata.name || s.session}
                  </option>
                ))}
              </select>
            </label>
            <span className="bci-chip">
              {streamMeta?.channels?.length || 8} channels
            </span>
            <span className="bci-chip">
              {streamMeta?.sample_rate_hz || 250} Hz
            </span>
            <span className="bci-chip">{detail?.chunks || 0} chunks</span>
          </div>
          {(tab === "Sessions" || tab === "Live") && (
            <>
              <div className="bci-controls">
                <label>
                  Stream
                  <select
                    value={stream}
                    onChange={(e) => {
                      setStream(e.target.value);
                      setData(null);
                      const count =
                        detail?.streams.find(
                          (s) => s.fields.stream_id === e.target.value,
                        )?.fields.channels?.length || 0;
                      setChannelIndices(
                        Array.from({ length: Math.min(4, count) }, (_, i) => i),
                      );
                    }}
                  >
                    {detail?.streams.map((s) => (
                      <option key={s.dst} value={s.fields.stream_id}>
                        {s.fields.stream_id}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Offset (seconds)
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={offset}
                    disabled={live}
                    onChange={(e) =>
                      setOffset(Math.max(0, Number(e.target.value)))
                    }
                  />
                </label>
                <label>
                  Window
                  <select
                    value={span}
                    onChange={(e) => setSpan(Number(e.target.value))}
                  >
                    {[2, 5, 10, 30, 60].map((s) => (
                      <option key={s} value={s}>
                        {s} seconds
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  onClick={() => {
                    setPlaying(!playing);
                    setLive(false);
                  }}
                >
                  {playing ? <Pause size={16} /> : <Play size={16} />}{" "}
                  {playing ? "Pause" : "Replay"}
                </button>
                <button onClick={() => void loadWindow()}>
                  <RefreshCw size={16} /> Refresh
                </button>
              </div>
              <details className="bci-channel-picker">
                <summary>Channels · {channelIndices.length} selected</summary>
                <div>
                  {streamMeta?.channels?.map((name, i) => (
                    <label key={name}>
                      <input
                        type="checkbox"
                        checked={channelIndices.includes(i)}
                        onChange={(e) =>
                          setChannelIndices((old) =>
                            e.target.checked
                              ? [...old, i].slice(0, 16)
                              : old.filter((n) => n !== i),
                          )
                        }
                      />
                      {name}
                    </label>
                  ))}
                </div>
              </details>
              <section className="bci-panel bci-signal-panel">
                {data ? (
                  <Waveform data={data} />
                ) : (
                  <p role="status">
                    {channelIndices.length
                      ? "Loading signal window…"
                      : "Select a channel to view its signal."}
                  </p>
                )}
              </section>
              <div className="bci-lower-grid">
                <section className="bci-panel">
                  <div className="bci-section-title">
                    <h2>Events & quality</h2>
                    <span className="bci-chip">Current window</span>
                  </div>
                  {(synthetic ? data?.events : annotations)?.map((e) => (
                    <article className="bci-event" key={e.edge}>
                      <span
                        className={`bci-event-dot ${e.record.fields.type}`}
                      />
                      <div>
                        <strong>
                          {e.record.fields.label ||
                            e.record.fields.reason ||
                            e.record.fields.type}
                        </strong>
                        <small>
                          {e.record.fields.category || e.record.fields.type}
                        </small>
                      </div>
                      <time>
                        {(
                          (Number(e.record.timestamp_us) - origin) /
                          1e6
                        ).toFixed(2)}{" "}
                        s
                      </time>
                    </article>
                  ))}
                  {synthetic && (
                    <p className="bci-muted">
                      At 13–14 s the demo contains a recording gap. Move the
                      window to inspect it.
                    </p>
                  )}
                  {write && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void annotate();
                      }}
                      className="bci-annotation"
                    >
                      <label>
                        Annotation
                        <input
                          value={label}
                          onChange={(e) => setLabel(e.target.value)}
                          maxLength={128}
                          placeholder="Trial label or quality note"
                          required
                        />
                      </label>
                      <label>
                        Type
                        <select
                          value={category}
                          onChange={(e) => setCategory(e.target.value)}
                        >
                          {[
                            "cue",
                            "artifact",
                            "bad_channel",
                            "feedback",
                            "note",
                          ].map((c) => (
                            <option key={c}>{c}</option>
                          ))}
                        </select>
                      </label>
                      <button className="button" type="submit">
                        Annotate window
                      </button>
                    </form>
                  )}
                </section>
                <section className="bci-panel">
                  <h2>
                    {tab === "Live"
                      ? "From signal to response"
                      : "Keep the original. Trace the change."}
                  </h2>
                  <p>
                    {tab === "Live"
                      ? "Live updates refresh every two seconds. Predictions and application feedback appear alongside acquisition events; hardware control stays in your application."
                      : "Raw samples, source timestamps and clock corrections remain available through the SDK. Annotations create new records."}
                  </p>
                  <Code
                    text={`chronograph-bci export --instance ${current?.instance || "bci_research"} \\\n  --url ${managedSite ? "https://chronodb.co" : "http://127.0.0.1:8080"} \\\n  --session ${selected} --stream ${shell(stream)} --output ./recording-export`}
                  />
                  <Link to="/documentation/BCI">
                    Export to NumPy, MNE and BIDS <ArrowRight size={14} />
                  </Link>
                </section>
              </div>
            </>
          )}
          {tab === "Datasets" && (
            <section className="bci-panel">
              <h2>Reproducible datasets</h2>
              <p>
                Freeze source records and hashes before training. Trials
                crossing marked gaps or artifacts are excluded by the baseline
                worker.
              </p>
              {synthetic ? (
                <div className="bci-empty">
                  <h3>Build a dataset from your own sessions.</h3>
                  <p>
                    The built-in decoder needs at least three independent
                    recordings, with both cue classes in training and
                    evaluation.
                  </p>
                  <Link
                    className="button primary"
                    to={managedSite ? "/login" : "/documentation/BCI"}
                  >
                    Start a workspace <ArrowRight size={16} />
                  </Link>
                </div>
              ) : (
                <>
                  <div className="bci-fields">
                    <label>
                      Dataset name
                      <input
                        value={datasetName}
                        onChange={(e) => setDatasetName(e.target.value)}
                        maxLength={128}
                      />
                    </label>
                  </div>
                  <div className="bci-recording-list">
                    {sessions
                      .filter((s) => s.instance === current?.instance)
                      .map((s) => (
                        <label key={s.session}>
                          <input
                            type="checkbox"
                            checked={chosen.includes(s.session)}
                            onChange={(e) =>
                              setChosen((v) =>
                                e.target.checked
                                  ? [...v, s.session]
                                  : v.filter((id) => id !== s.session),
                              )
                            }
                          />
                          {s.metadata.name} <small>{s.chunks} chunks</small>
                        </label>
                      ))}
                  </div>
                  <button
                    className="button primary"
                    disabled={!write || loading || !datasetName.trim()}
                    onClick={() => void makeDataset()}
                  >
                    Save & download manifest <Download size={16} />
                  </button>
                  <div className="bci-recording-list">
                    {datasets.map((d) => (
                      <article key={d.edge}>
                        <strong>{d.record.fields.name}</strong>
                        <code>{d.record.dst}</code>
                        <button
                          onClick={() =>
                            saveJson(
                              d.record.fields.manifest,
                              `dataset-${d.record.dst}.json`,
                            )
                          }
                        >
                          Download manifest
                        </button>
                      </article>
                    ))}
                  </div>
                </>
              )}
            </section>
          )}
          {tab === "Runs" && (
            <>
              <section className="bci-panel">
                <div className="bci-section-title">
                  <h2>Decoder experiments</h2>
                  {/* The chip describes this deployment, not a capability: claiming workers are
                      available beside a status that says hosted training is off told the reader
                      two opposite things about the same page. */}
                  <span className="bci-chip">
                    {jobs?.available
                      ? "Hosted training enabled"
                      : managedSite
                        ? "Run the worker on your own machine"
                        : "Local workers"}
                  </span>
                </div>
                <p>
                  Run a CPU baseline or publish results from your own decoder.
                  Compare each result against its frozen source dataset.
                </p>
                <Code
                  text={`chronograph-bci train --input ./dataset.json --output ./decoder-run \\\n  --instance ${current?.instance || "bci_research"} --components 4 \\\n  --dataset-id DATASET_ID --spool ./bci-recording --partition recording_01 --sync \\\n  --clock-domain ${shell(current?.metadata.clock_domain || "unix_us")} --url ${managedSite ? "https://chronodb.co" : "http://127.0.0.1:8080"}`}
                />
                <p className="bci-muted">
                  CSP + shrinkage LDA · Independent recording splits · Raw data
                  unchanged
                </p>
                {runs.length ? (
                  <div className="bci-table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Run</th>
                          <th>Recipe</th>
                          <th>Balanced accuracy</th>
                          <th>Evaluation epochs</th>
                          <th>Details</th>
                        </tr>
                      </thead>
                      <tbody>
                        {runs.map((r) => (
                          <tr key={r.edge}>
                            <td>{r.record.fields.name}</td>
                            <td>{String(r.record.fields.recipe)}</td>
                            <td>
                              {typeof r.record.fields.result
                                ?.balanced_accuracy === "number"
                                ? `${(r.record.fields.result.balanced_accuracy * 100).toFixed(1)}%`
                                : "—"}
                            </td>
                            <td>
                              {String(
                                r.record.fields.result?.test_epochs ?? "—",
                              )}
                            </td>
                            <td>
                              <button
                                onClick={() =>
                                  saveJson(r.record, `run-${r.record.dst}.json`)
                                }
                              >
                                Download
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="bci-muted">
                    No decoder results published in this recording yet.
                  </p>
                )}
              </section>
              <section className="bci-panel">
                <h2>Managed training</h2>
                <p>
                  {jobs?.reason ||
                    "Hosted training is not enabled. Run a worker on your laptop or server and publish its results here."}
                </p>
                {jobs?.available ? (
                  <div className="bci-fields">
                    <label>
                      Dataset
                      <select
                        value={jobDataset}
                        onChange={(e) => setJobDataset(e.target.value)}
                      >
                        <option value="">Select a saved dataset</option>
                        {datasets.map((d) => (
                          <option key={d.record.dst} value={d.record.dst}>
                            {d.record.fields.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      CSP components
                      <select
                        value={jobComponents}
                        onChange={(e) =>
                          setJobComponents(Number(e.target.value))
                        }
                      >
                        {[2, 4, 6, 8].map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      className="button primary"
                      disabled={!write || !jobDataset || jobBusy}
                      onClick={() => void queueJob()}
                    >
                      <Play size={16} /> Queue CPU run
                    </button>
                  </div>
                ) : (
                  <button disabled>
                    <Terminal size={16} /> Separate compute required
                  </button>
                )}
                <div className="bci-recording-list">
                  {jobs?.jobs.map((j) => (
                    <article key={j.id}>
                      <div>
                        <strong>
                          {j.specification?.recipe || "CPU run"} · {j.state}
                        </strong>
                        <small>{j.id}</small>
                      </div>
                      {write && ["queued", "running"].includes(j.state) && (
                        <button onClick={() => void cancelJob(j.id)}>
                          Cancel
                        </button>
                      )}
                      {j.result && (
                        <button
                          onClick={() => saveJson(j.result, `${j.id}.json`)}
                        >
                          Download result & model
                        </button>
                      )}
                    </article>
                  ))}
                </div>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
export default BCIWorkspace;
export function BCIPage() {
  return (
    <div className="bci-public">
      <nav className="bci-public-nav">
        <Logo />
        <div>
          <Link to="/documentation/BCI">Developer guide</Link>
          <a href="/downloads/chronodb-bci-examples.zip" download>
            Get examples
          </a>
          <Link
            className="button primary"
            to={managedSite ? "/login" : publicSite ? "/app" : "/login"}
          >
            Create a workspace <ArrowRight size={15} />
          </Link>
        </div>
      </nav>
      <main>
        <BCIWorkspace demo />
        <section className="bci-proof-grid">
          {[
            [
              "01",
              "Capture",
              "BrainFlow, LSL and recorded EEG. Private offline buffering with resumable uploads.",
            ],
            [
              "02",
              "Understand",
              "Review waveforms, align events and keep clock corrections visible.",
            ],
            [
              "03",
              "Build",
              "Export datasets, compare decoder runs and trace application feedback.",
            ],
          ].map(([n, t, p]) => (
            <article key={n}>
              <span>{n}</span>
              <h2>{t}</h2>
              <p>{p}</p>
            </article>
          ))}
        </section>
        <p className="bci-independence">
          Independent infrastructure for BCI research. Synthetic and
          recorded-data tests do not establish physical-device compatibility or
          clinical approval.
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
