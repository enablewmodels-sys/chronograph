// One derivation for every surface that groups BrainFlow boards.
//
// The vendor map in the generated catalogue lists the vendors BrainFlow documents,
// not the vendors its boards carry: 64 boards ship and 28 of them use the placeholder
// vendor "undocumented". Grouping by the map made those boards unreachable in the
// source picker and invisible behind the device-catalogue filter, so the groups are
// derived from the boards themselves and this module is the only place that decides.
import catalog from "./brainflow-boards.json";

/** Placeholder vendor used by BrainFlow for boards it ships but does not document. */
export const UNDOCUMENTED = "undocumented";

/** Every vendor that has at least one board, sorted, including the placeholder. */
export const BCI_VENDORS: string[] = [
  ...new Set(catalog.boards.map((board) => board.vendor)),
].sort();

/** Vendors BrainFlow documents. The placeholder group is reported separately. */
export const BCI_VENDOR_COUNT = BCI_VENDORS.filter(
  (vendor) => vendor !== UNDOCUMENTED,
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
  return vendor === UNDOCUMENTED ? "Undocumented (BrainFlow)" : vendor;
}

/** The board a group starts on, or -1 when the group is empty. */
export function firstBoardOf(vendor: string) {
  const found = boardsOf(vendor)[0];
  return found ? found.id : -1;
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
