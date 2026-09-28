import { graph } from "./api";
export interface BciRecord {
  src: string;
  dst: string;
  timestamp_us: string;
  assets: Record<string, string>;
  fields: {
    type: string;
    session_id: string;
    clock_domain: string;
    name?: string;
    stream_id?: string;
    label?: string;
    category?: string;
    end_us?: string;
    reason?: string;
    participant?: string;
    channels?: string[];
    units?: string[];
    channel_types?: string[];
    sample_rate_hz?: number;
    reference?: string;
    manifest?: object;
    result?: Record<string, unknown>;
    [key: string]: unknown;
  };
}
export interface BciRow {
  edge: string;
  record: BciRecord;
}
export interface BciSession {
  instance: string;
  session: string;
  metadata: BciRecord["fields"];
  streams: number;
  chunks: number;
  records: number;
  last_us: string;
}
export interface BciDetail {
  instance: string;
  session: string;
  metadata: BciRecord;
  streams: BciRecord[];
  chunks: number;
  records: number;
  last_us: string;
}
export interface BciWindow {
  start_us: string;
  end_us: string;
  clock_domain: string;
  points: number;
  channels: {
    name: string;
    unit: string;
    index: number;
    envelope: ([number, number, number] | null)[];
  }[];
  coverage: { start_us: string; end_us: string; segment_id: string }[];
  events: BciRow[];
  nonfinite_values: number;
  display_only: boolean;
}
export const bciId = () => {
  const a = new BigUint64Array(1);
  crypto.getRandomValues(a);
  return (a[0] >> 1n || 1n).toString();
};
export function bciRecord(
  session: string,
  type: string,
  clock: string,
  fields: Record<string, unknown>,
  t = "0",
): BciRecord {
  return {
    src: session,
    dst: type === "session" ? session : bciId(),
    timestamp_us: t,
    assets: {},
    fields: { type, session_id: session, clock_domain: clock, ...fields },
  };
}
export async function publish(instance: string, records: BciRecord[]) {
  return graph("connector_ingest", {
    instance,
    partition: `ui_${bciId()}`,
    sequence: "0",
    records,
  });
}
export async function bciRecords(
  instance: string,
  session: string,
  type = "",
): Promise<BciRow[]> {
  const rows: BciRow[] = [];
  let after: string | undefined;
  for (let page = 0; page < 200; page++) {
    const r = await graph<{
      records: BciRow[];
      cursor: string | null;
      has_more: boolean;
    }>("bci_records", {
      instance,
      session,
      record_type: type,
      limit: 500,
      ...(after ? { after } : {}),
    });
    rows.push(...r.records);
    if (!r.has_more) return rows;
    if (!r.cursor || r.cursor === after)
      throw Error("Recording cursor did not advance");
    after = r.cursor;
  }
  throw Error(
    "Recording exceeds browser page budget; use the Python exporter.",
  );
}
const names = Array.from(
  { length: 8 },
  (_, i) => `EEG${String(i + 1).padStart(2, "0")}`,
);
export const demoSession: BciSession = {
  instance: "synthetic",
  session: "1001",
  metadata: {
    type: "session",
    session_id: "1001",
    clock_domain: "simulation_us",
    name: "Motor imagery · research demo",
    participant: "synthetic",
    source: "synthetic",
    device: "Generated EEG fixture",
    study: "BCI onboarding",
  },
  streams: 1,
  chunks: 30,
  records: 40,
  last_us: "30000000",
};
export const demoDetail: BciDetail = {
  ...demoSession,
  metadata: bciRecord("1001", "session", "simulation_us", demoSession.metadata),
  streams: [
    bciRecord("1001", "stream", "simulation_us", {
      stream_id: "eeg",
      channels: names,
      units: names.map(() => "V"),
      channel_types: names.map(() => "EEG"),
      sample_rate_hz: 250,
      reference: "Synthetic reference",
    }),
  ],
};
export function demoWindow(
  start: number,
  end: number,
  selected: number[],
): BciWindow {
  const points = 600;
  return {
    start_us: String(start),
    end_us: String(end),
    clock_domain: "simulation_us",
    points,
    channels: selected.map((c) => ({
      name: names[c],
      unit: "V",
      index: c,
      envelope: Array.from({ length: points }, (_, i) => {
        const t = (start + ((end - start) * i) / points) / 1e6;
        if (t >= 13 && t < 14) return null;
        const amplitude = (Math.floor(t / 4) % 2 === c % 2 ? 12 : 3) * 1e-6;
        const v =
          amplitude * Math.sin(t * 2 * Math.PI * (10 + Math.floor(c / 2))) +
          2e-6 * Math.sin(t * 173 + c * 3);
        return [v - 1e-6, v + 1e-6, 4] as [number, number, number];
      }),
    })),
    coverage: [],
    events: Array.from({ length: 8 }, (_, i) => ({
      edge: String(i),
      record: bciRecord(
        "1001",
        "event",
        "simulation_us",
        {
          stream_id: "eeg",
          label: i % 2 ? "right" : "left",
          category: "cue",
          end_us: String(i * 4e6),
        },
        String(i * 4e6),
      ),
    }))
      .concat([
        {
          edge: "gap-13",
          record: bciRecord(
            "1001",
            "gap",
            "simulation_us",
            {
              stream_id: "eeg",
              reason: "Simulated acquisition pause",
              end_us: "14000000",
            },
            "13000000",
          ),
        },
      ])
      .filter(
        (e) =>
          Number(e.record.timestamp_us) >= start &&
          Number(e.record.timestamp_us) < end,
      ),
    nonfinite_values: 0,
    display_only: true,
  };
}
export function saveJson(value: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
