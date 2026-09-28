import { useCallback, useEffect, useMemo, useState, useRef } from "react";
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
import { Logo, Code } from "./shared";
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
function Setup({ onDone }: { onDone: () => void }) {
  const [source, setSource] = useState("synthetic"),
    [instance, setInstance] = useState("bci_research"),
    [clock, setClock] = useState("unix_us"),
    [channels, setChannels] = useState(
      "EEG01, EEG02, EEG03, EEG04, EEG05, EEG06, EEG07, EEG08",
    ),
    [units, setUnits] = useState("uV"),
    [reference, setReference] = useState("unspecified"),
    [rate, setRate] = useState(250),
    [preview, setPreview] = useState<{
      source: string;
      checksum: string;
      expected_revision: number;
    } | null>(null),
    [applied, setApplied] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
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
        throw Error(
          "Use a valid instance name and sample rate (80–100000 Hz).",
        );
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
  const base = `chronograph-bci ${source === "file" ? "import" : source} --url ${managedSite ? "https://chronodb.co" : "http://127.0.0.1:8080"} \\\n  --instance ${instance} --clock-domain ${clock} --spool ./bci-recording \\\n  --partition recording_01 --sync`;
  const command =
    base +
    (source === "synthetic" ? "" : ` --reference ${shell(reference)}`) +
    (source === "lsl"
      ? ` \\\n  --source-id YOUR_SOURCE_ID --channels ${shell(channels.replaceAll(" ", ""))} --units ${shell(units)}`
      : source === "brainflow"
        ? ` \\\n  --board-id -1 --units ${shell(units)} --seconds 60`
        : source === "file"
          ? " \\\n  --input ./recording.edf --start-us YOUR_ACQUISITION_START_US"
          : ` --rate ${rate} --channels ${shell(channels.replaceAll(" ", ""))} --seconds 30 --realtime`);
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
            disabled={!!preview || applied}
            onChange={(e) => {
              setSource(e.target.value);
              setClock(e.target.value === "lsl" ? "lsl_local_us" : "unix_us");
            }}
          >
            <option value="synthetic">Synthetic EEG · no hardware</option>
            <option value="brainflow">BrainFlow / OpenBCI</option>
            <option value="lsl">Lab Streaming Layer</option>
            <option value="file">Recorded EDF / BDF / FIF</option>
          </select>
        </label>
        <label>
          Instance
          <input
            value={instance}
            disabled={!!preview || applied}
            onChange={(e) => setInstance(e.target.value)}
            pattern="[A-Za-z0-9_]+"
            maxLength={48}
          />
        </label>
        <label>
          Clock
          <select
            value={clock}
            disabled={!!preview || applied}
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
              onChange={(e) => setReference(e.target.value)}
              maxLength={128}
            />
          </label>
        )}
        <label>
          Channel names
          <input
            value={channels}
            onChange={(e) => setChannels(e.target.value)}
          />
        </label>
        <label>
          Original units
          <input value={units} onChange={(e) => setUnits(e.target.value)} />
        </label>
        <label>
          Sample rate
          <input
            type="number"
            min={80}
            max={100000}
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
          />
        </label>
      </div>
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
      {applied && (
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
      )}
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
    [jobBusy, setJobBusy] = useState(false);
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
      {setup && <Setup onDone={() => void refresh()} />}
      <div className="bci-tabs" role="tablist" aria-label="BCI workspace">
        {["Sessions", "Datasets", "Runs", "Live"].map((t) => (
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
      {!sessions.length ? (
        <section className="bci-panel bci-empty">
          <Activity size={34} />
          <h2>Your first recording starts here.</h2>
          <p>
            Configure a source, start the local worker and watch your session
            arrive.
          </p>
          <div className="bci-actions">
            {connection?.credential.scope === "admin" && (
              <button className="button primary" onClick={() => setSetup(true)}>
                Set up a source <ArrowRight size={15} />
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
                  <span className="bci-chip">Local workers available</span>
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
          Independent infrastructure for BCI research. Not affiliated with
          Neuralink. Synthetic and recorded-data tests do not establish
          physical-device compatibility or clinical approval.
        </p>
      </main>
      <SiteFooter />
    </div>
  );
}
