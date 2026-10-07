// Hand a recording back to the person who made it, in the browser.
//
// WHY this exists: the managed console used to answer "how do I get my data out" with a
// `chronograph-bci export` line, which asks a hosted account to install a Python package and run a
// command on a machine that has nothing to do with the recording. The console already holds a read
// credential for the project and the engine already serves the samples it wrote, so the file is
// assembled here instead. The Python exporter remains for people who want MNE, BIDS or very large
// recordings; this is what the product itself can do without help.
import { graph } from "./api";
import type { BciDetail, BciRow } from "./bci-api";

/** One stream's samples, as the recording stores them. */
export interface ExportedStream {
  stream_id: string;
  channels: string[];
  units: string[];
  channel_types: string[];
  sample_rate_hz: number | null;
  reference: string;
  /** One array per channel, in the stream's own units. null marks a sample the engine stored as
   * not-a-number, which is reported rather than silently turned into a zero. */
  samples: (number | null)[][];
  /** Acquisition time of each sample, in microseconds. */
  timestamps_us: number[];
  /** Declared coverage of each chunk that contributed samples. */
  coverage: {
    segment_id: string;
    start_us: string;
    end_us: string;
    samples: number;
  }[];
}

export interface ExportedRecording {
  format: "chronograph-bci-recording-v1";
  exported_at: string;
  instance: string;
  session: string;
  clock_domain: string;
  streams: ExportedStream[];
  events: Record<string, unknown>[];
  gaps: Record<string, unknown>[];
  truncated: boolean;
  note: string;
}

/**
 * How much of one recording the browser will assemble.
 *
 * WHY a ceiling at all: the samples travel through this tab as hex over HTTP, so an hour of 128
 * channels would exhaust the tab rather than produce a file. A recording over the ceiling is
 * exported up to it and marked `truncated`, which the reader can act on, and the documentation
 * points at the Python exporter for anything larger.
 */
const MAX_SAMPLES_PER_CHANNEL = 2_000_000;
const MAX_TOTAL_BYTES = 48 * 1024 * 1024;
const ASSET_PAGE_BYTES = 1024 * 1024;
/**
 * Chunks one export reads, which is also the point the pacing budget runs out: two requests per
 * chunk (signal and timestamps) against a 1400-request budget, so 600 chunks is the largest
 * recording this completes. A longer recording is exported up to it and marked truncated.
 */
const MAX_CHUNKS = 600;
/**
 * How many requests one export may spend, and how fast it may spend them.
 *
 * WHY this exists: a recording is stored as one asset per chunk and the browser has to ask for
 * each one, so a nine-hundred-chunk recording costs about two thousand requests. The console
 * allows a signed-in account 180 requests a minute for project reads, and an export that ignores
 * that limit is refused partway through with "Too many attempts" - which is what a person
 * selecting two recordings actually saw. The export therefore paces itself below the limit and
 * waits out a refusal instead of failing, and stops at a budget it can state.
 */
const REQUEST_INTERVAL_MS = 380;
const MAX_REQUESTS = 1400;
const MAX_RETRIES = 8;

let nextRequestAt = 0;
let requestsSpent = 0;

/** Wait for this export's turn, so a large recording does not trip the deployment's limit. */
async function pace() {
  requestsSpent += 1;
  if (requestsSpent > MAX_REQUESTS)
    throw new Error(
      "This export reached the console's request budget. Use the SDK exporter for a recording this large.",
    );
  const now = Date.now();
  const wait = Math.max(0, nextRequestAt - now);
  nextRequestAt = Math.max(now, nextRequestAt) + REQUEST_INTERVAL_MS;
  if (wait > 0) await new Promise((done) => setTimeout(done, wait));
}

/** One paced project read that waits out a rate-limit refusal instead of reporting it. */
async function limited<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    await pace();
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const refused = /too many attempts|rate limit|429/i.test(message);
      if (!refused || attempt >= MAX_RETRIES) throw error;
      await new Promise((done) => setTimeout(done, 2000 * (attempt + 1)));
    }
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1)
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Read one immutable tensor, following the engine's 1 MiB asset pages. */
async function readAsset(asset: string): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let bytes = 0;
  let offset = 0;
  for (let page = 0; page < 4096; page += 1) {
    const result = await limited(() =>
      graph<{
        bytes: number;
        data_hex?: string;
        next_offset?: number | null;
      }>("asset_get", { asset, content: true, offset, limit: ASSET_PAGE_BYTES }),
    );
    const hex = result.data_hex || "";
    const part = hexToBytes(hex);
    parts.push(part);
    bytes += part.length;
    if (bytes > MAX_TOTAL_BYTES)
      throw new Error(
        "This recording is larger than the console exports; use the SDK exporter.",
      );
    if (result.next_offset === null || result.next_offset === undefined) break;
    if (result.next_offset <= offset)
      throw new Error("The asset page cursor did not advance.");
    offset = result.next_offset;
  }
  const joined = new Uint8Array(bytes);
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}

/** Every record of one type in a session, paged. */
async function recordsOf(
  instance: string,
  session: string,
  type: string,
): Promise<BciRow[]> {
  const all: BciRow[] = [];
  let after: string | undefined;
  for (let page = 0; page < 200; page += 1) {
    const result = await limited(() =>
      graph<{
        records: BciRow[];
        cursor: string | null;
        has_more: boolean;
      }>("bci_records", {
        instance,
        session,
        record_type: type,
        limit: 500,
        ...(after ? { after } : {}),
      }),
    );
    all.push(...result.records);
    if (!result.has_more) return all;
    if (!result.cursor || result.cursor === after)
      throw new Error("Recording cursor did not advance");
    after = result.cursor;
  }
  throw new Error("This recording has more records than the console reads.");
}

const overlay = (row: BciRow) => {
  const fields = row.record.fields;
  return {
    type: fields.type,
    stream_id: fields.stream_id,
    label: fields.label,
    category: fields.category,
    reason: fields.reason,
    lost_samples: fields.lost_samples,
    timestamp_us: row.record.timestamp_us,
    end_us: fields.end_us,
  };
};

/**
 * Assemble one recording.
 *
 * The samples are the stored values: nothing is scaled, filtered or re-referenced here, because a
 * file that has quietly been through somebody's pipeline is worse than no file. Values are rounded
 * to six decimals, which is below the resolution of the f32 the engine stores and keeps the JSON
 * readable.
 */
export async function exportRecording(
  instance: string,
  session: string,
  detail: BciDetail,
  onProgress?: (done: number, total: number) => void,
): Promise<ExportedRecording> {
  requestsSpent = 0;
  const signal = await recordsOf(instance, session, "signal");
  const events = (await recordsOf(instance, session, "event")).map(overlay);
  const gaps = (await recordsOf(instance, session, "gap")).map(overlay);
  const byStream = new Map<string, ExportedStream>();
  for (const meta of detail.streams) {
    const id = String(meta.fields.stream_id || "eeg");
    byStream.set(id, {
      stream_id: id,
      channels: (meta.fields.channels || []).map(String),
      units: (meta.fields.units || []).map(String),
      channel_types: (meta.fields.channel_types || []).map(String),
      sample_rate_hz: meta.fields.sample_rate_hz ?? null,
      reference: String(meta.fields.reference || ""),
      samples: [],
      timestamps_us: [],
      coverage: [],
    });
  }
  let bytes = 0;
  let truncated = false;
  let done = 0;
  for (const row of signal.slice(0, MAX_CHUNKS)) {
    const fields = row.record.fields;
    const stream = byStream.get(String(fields.stream_id));
    if (!stream) continue;
    const count = Number(fields.sample_count || 0);
    if (!count) continue;
    if (stream.samples.length === 0)
      for (const _ of stream.channels) stream.samples.push([]);
    if (
      stream.samples.length &&
      stream.samples[0].length + count > MAX_SAMPLES_PER_CHANNEL
    ) {
      truncated = true;
      break;
    }
    const signalAsset = row.record.assets.signal;
    const timeAsset = row.record.assets.timestamps;
    if (!signalAsset || !timeAsset) continue;
    const signalBytes = await readAsset(signalAsset);
    const timeBytes = await readAsset(timeAsset);
    bytes += signalBytes.length + timeBytes.length;
    if (bytes > MAX_TOTAL_BYTES) {
      truncated = true;
      break;
    }
    const view = new DataView(
      signalBytes.buffer,
      signalBytes.byteOffset,
      signalBytes.byteLength,
    );
    const times = new DataView(
      timeBytes.buffer,
      timeBytes.byteOffset,
      timeBytes.byteLength,
    );
    const correction = Number(fields.correction_seconds || 0);
    for (let sample = 0; sample < count; sample += 1) {
      stream.timestamps_us.push(
        Math.round((times.getFloat64(sample * 8, true) + correction) * 1e6),
      );
      for (let channel = 0; channel < stream.samples.length; channel += 1) {
        const at = (channel * count + sample) * 4;
        if (at + 4 > signalBytes.length) continue;
        const value = view.getFloat32(at, true);
        stream.samples[channel].push(
          Number.isFinite(value) ? Number(value.toFixed(6)) : null,
        );
      }
    }
    stream.coverage.push({
      segment_id: String(fields.segment_id || ""),
      start_us: row.record.timestamp_us,
      end_us: String(fields.end_us || ""),
      samples: count,
    });
    done += 1;
    onProgress?.(done, Math.min(signal.length, MAX_CHUNKS));
    if (signal.length > MAX_CHUNKS) truncated = true;
  }
  return {
    format: "chronograph-bci-recording-v1",
    exported_at: new Date().toISOString(),
    instance,
    session,
    clock_domain: String(detail.metadata?.fields?.clock_domain || ""),
    streams: [...byStream.values()],
    events,
    gaps,
    truncated,
    note:
      "Samples are the values this recording stores, in each stream's own units, with the " +
      "acquisition time of every sample in microseconds. Nothing is filtered, scaled or " +
      "re-referenced by the console." +
      (truncated
        ? " This file stops at the console's own read budget of " +
          MAX_CHUNKS +
          " chunks; the SDK exporter reads the rest."
        : ""),
  };
}

/** One trial of one recording, cut the way the frozen dataset says trials are cut. */
export interface ExportedTrial {
  label: string;
  onset_us: number;
  samples: (number | null)[][];
}

export interface ExportedDatasetSession {
  session: string;
  stream_id: string;
  channels: string[];
  units: string[];
  sample_rate_hz: number | null;
  through_edge: string;
  sha256: string;
  events: Record<string, unknown>[];
  trials: ExportedTrial[];
}

export interface ExportedDataset {
  format: "chronograph-bci-dataset-v1";
  exported_at: string;
  name: string;
  manifest: object;
  sessions: ExportedDatasetSession[];
  note: string;
}

/**
 * Cut the frozen dataset's trials, so the downloaded file holds the epochs a training run would see
 * rather than only the recipe that describes them. WHY the console does this: a manifest with no
 * trials is a file a person cannot use without the SDK, which is the complaint this answers.
 */
export async function exportDataset(
  instance: string,
  manifest: {
    sessions: string[];
    stream: string;
    source_snapshots: {
      session: string;
      through_edge: string;
      sha256: string;
    }[];
    event_category?: string;
    preprocessing?: {
      epoch_start_s?: number;
      epoch_end_s?: number;
      low_hz?: number;
      high_hz?: number;
    };
  },
  name: string,
): Promise<ExportedDataset> {
  const start = manifest.preprocessing?.epoch_start_s ?? 0.5;
  const end = manifest.preprocessing?.epoch_end_s ?? 2.5;
  const sessions: ExportedDatasetSession[] = [];
  for (const snapshot of manifest.source_snapshots) {
    const detail = await limited(() =>
      graph<BciDetail>("bci_session", {
        instance,
        session: snapshot.session,
      }),
    );
    const recording = await exportRecording(instance, snapshot.session, detail);
    const stream =
      recording.streams.find((entry) => entry.stream_id === manifest.stream) ??
      recording.streams[0];
    if (!stream || !stream.samples.length) continue;
    // The manifest names the category its trials are cut from, so a dataset built on a
    // different marker still exports the epochs it was trained on.
    const category = manifest.event_category || "cue";
    const cues = recording.events.filter(
      (event) => event.category === category,
    );
    const trials: ExportedTrial[] = [];
    for (const cue of cues) {
      const onset = Number(cue.timestamp_us);
      const from = onset + start * 1e6;
      const to = onset + end * 1e6;
      const first = stream.timestamps_us.findIndex((time) => time >= from);
      if (first < 0) continue;
      const last = stream.timestamps_us.findIndex((time) => time >= to);
      const stop = last < 0 ? stream.timestamps_us.length : last;
      if (stop - first < 2) continue;
      trials.push({
        label: String(cue.label || ""),
        onset_us: onset,
        samples: stream.samples.map((channel) => channel.slice(first, stop)),
      });
    }
    sessions.push({
      session: snapshot.session,
      stream_id: stream.stream_id,
      channels: stream.channels,
      units: stream.units,
      sample_rate_hz: stream.sample_rate_hz,
      through_edge: snapshot.through_edge,
      sha256: snapshot.sha256,
      events: recording.events,
      trials,
    });
  }
  return {
    format: "chronograph-bci-dataset-v1",
    exported_at: new Date().toISOString(),
    name,
    manifest,
    sessions,
    note:
      "Each trial holds the samples between the manifest's epoch_start_s and epoch_end_s after its " +
      "cue, in the stream's own units. The manifest's source_snapshots are what make this dataset " +
      "reproducible: they name the exact record each recording was frozen at.",
  };
}

/** Write one export to a file the browser downloads. */
export function saveFile(
  value: unknown,
  name: string,
  mime = "application/json",
) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: mime }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
