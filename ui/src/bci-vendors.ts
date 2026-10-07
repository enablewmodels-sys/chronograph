// One derivation for every surface that groups BrainFlow boards.
//
// The catalogue is generated from the acquisition agent's own driver, and every board
// it ships belongs to a vendor. Grouping used to fall back to a placeholder for any
// driver member the documentation map did not name, which hid 28 real boards (Ant Neuro
// EE 2xx, Muse BLED, Explore Plus, Ganglion, AAVAA, NTL, Synchroni, the OYMotion
// OB-series) behind one meaningless group in both surfaces. The generated file now
// attributes every member, and this module keeps a labelled fallback for the day a
// driver upgrade adds a member nobody has attributed yet, so a new board is still
// reachable rather than invisible.
import catalog from "./brainflow-boards.json";

/** Placeholder vendor for a driver member the catalogue has not attributed. */
export const UNDOCUMENTED = "undocumented";

/** Every vendor that has at least one board, sorted, including the placeholder. */
export const BCI_VENDORS: string[] = [
  ...new Set(catalog.boards.map((board) => board.vendor)),
].sort();

/** Vendors that own at least one board. The placeholder is reported separately. */
export const BCI_VENDOR_COUNT = BCI_VENDORS.filter(
  (vendor) => vendor !== UNDOCUMENTED,
).length;

/** Boards the catalogue could not attribute to a vendor. Zero for a current driver. */
export const BCI_UNATTRIBUTED_COUNT = catalog.boards.filter(
  (board) => board.vendor === UNDOCUMENTED,
).length;

export const BCI_BOARD_COUNT = catalog.boards.length;

export const BCI_PRESET_COUNT = catalog.boards.reduce(
  (total, board) => total + board.presets.length,
  0,
);

/** The boards in one group. */
export function boardsOf(vendor: string) {
  return catalog.boards.filter((board) => board.vendor === vendor);
}

/** A group name a person can read. */
export function vendorLabel(vendor: string) {
  return vendor === UNDOCUMENTED ? "Unattributed (BrainFlow)" : vendor;
}

/** The board a group starts on, or -1 when the group is empty. */
export function firstBoardOf(vendor: string) {
  const found = boardsOf(vendor)[0];
  return found ? found.id : -1;
}

export type Board = (typeof catalog.boards)[number];

/** One board by its BrainFlow id, or undefined for an id this driver does not ship. */
export function boardById(id: number): Board | undefined {
  return catalog.boards.find((board) => board.id === id);
}

/** One preset of one board, falling back to the board's default preset. */
export function presetOf(id: number, preset: number) {
  const board = boardById(id);
  if (!board) return undefined;
  return (
    board.presets.find((entry) => entry.preset === preset) ?? board.presets[0]
  );
}

/**
 * The channel names a person gets before they edit anything: the names the driver
 * itself reports when it reports any, and a numbered label in the board's own signal
 * family otherwise. The count always equals the geometry the catalogue carries, so a
 * 16- or 64-channel board arrives with 16 or 64 names rather than eight.
 */
export function defaultChannelNames(id: number, preset = 0): string[] {
  const board = boardById(id);
  if (!board) return [];
  const rows = presetOf(id, preset)?.channels ?? board.channels;
  const count = Math.max(0, rows);
  const reported = board.channel_names.slice(0, count);
  if (reported.length === count && count > 0) return [...reported];
  return numberedChannelNames(id, count);
}

/**
 * Numbered names in the board's own signal family, from its primary modality. This is
 * the pattern the editor offers when a person wants a different prefix, start index,
 * width or separator for the same geometry.
 */
export function numberedChannelNames(
  id: number,
  count: number,
  options: {
    prefix?: string;
    start?: number;
    width?: number;
    separator?: string;
  } = {},
): string[] {
  const board = boardById(id);
  const prefix = options.prefix ?? prefixFor(board?.modality);
  const start = options.start ?? 1;
  const width = options.width ?? Math.max(2, String(start + count - 1).length);
  const separator = options.separator ?? "";
  return Array.from(
    { length: Math.max(0, count) },
    (_, index) =>
      prefix + separator + String(start + index).padStart(width, "0"),
  );
}

const MODALITY_PREFIX: Record<string, string> = {
  eeg: "EEG",
  exg: "EXG",
  emg: "EMG",
  ecg: "ECG",
  eog: "EOG",
  eda: "EDA",
  ppg: "PPG",
  optical: "OPT",
  accel: "ACC",
  gyro: "GYR",
  magnetometer: "MAG",
  rotation: "ROT",
  temperature: "TEMP",
  resistance: "IMP",
  analog: "AIO",
};

/** The label family a board's primary signal uses, e.g. EEG for an EEG board. */
export function prefixFor(modality?: string | null) {
  return (modality && MODALITY_PREFIX[modality]) || "CH";
}

/** The channel type recorded alongside each name, from the board's own signal family. */
export function channelTypeFor(modality?: string | null) {
  return (modality && MODALITY_PREFIX[modality]) || "CH";
}

/**
 * Board ids reachable by walking every group in the picker. Used by the catalogue
 * test: if this is shorter than the catalogue, boards are hidden from the product.
 */
export function reachableBoardIds(): number[] {
  return BCI_VENDORS.flatMap((vendor) =>
    boardsOf(vendor).map((board) => board.id),
  );
}
