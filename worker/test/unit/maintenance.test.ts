// The read-only window's pure pieces (WP3.41): the window and the rollback order a version holds,
// and the restore point the server image reports.
import { describe, expect, it } from "vitest";
import {
  EXIT_ROLLED_BACK,
  MAINTENANCE_WINDOW_SECRET,
  maintenanceWindowOf,
  RESTORE_POINT_ID,
  ROLLBACK_SECRET,
  restorePointOf,
  rollbackOrderOf,
} from "../../src/server/maintenance.ts";
import { EXIT_ROLLED_BACK as WATCHDOG_EXIT_ROLLED_BACK } from "../../src/server/watchdog.ts";

const ID = "rp-20261030T120000Z-0a1b2c3d";

describe("the update's window and rollback order (WP3.41)", () => {
  it("holds the window for any value, and names it only when it is an ID", () => {
    expect(maintenanceWindowOf({})).toBeNull();
    expect(maintenanceWindowOf({ [MAINTENANCE_WINDOW_SECRET]: "" })).toBeNull();
    expect(maintenanceWindowOf({ [MAINTENANCE_WINDOW_SECRET]: "  " })).toBeNull();
    expect(maintenanceWindowOf({ [MAINTENANCE_WINDOW_SECRET]: 7 })).toBeNull();
    expect(maintenanceWindowOf({ [MAINTENANCE_WINDOW_SECRET]: ` ${ID}\n` })).toBe(ID);
    expect(maintenanceWindowOf({ [MAINTENANCE_WINDOW_SECRET]: "yes" })).toBe("malformed");
  });

  it("orders a rollback only to a restore point's ID", () => {
    expect(rollbackOrderOf({ [ROLLBACK_SECRET]: ID })).toBe(ID);
    expect(rollbackOrderOf({ [ROLLBACK_SECRET]: "rp-1" })).toBeNull();
    expect(rollbackOrderOf({ [ROLLBACK_SECRET]: 1 })).toBeNull();
    expect(rollbackOrderOf({})).toBeNull();
  });

  it("reads the restore point the server reports, and nothing else", () => {
    const point = { id: ID, takenAt: "2026-10-30T12:06:00.000Z", objects: 5, bytes: 9 };
    expect(restorePointOf({ restorePoint: point })).toEqual({ id: ID, takenAt: point.takenAt });
    for (const status of [
      null,
      "x",
      {},
      { restorePoint: null },
      { restorePoint: "x" },
      { restorePoint: { ...point, id: "rp-1" } },
      { restorePoint: { ...point, takenAt: "soon" } },
      { restorePoint: { ...point, takenAt: 5 } },
      { restorePoint: { ...point, takenAt: `${"2".repeat(41)}` } },
    ]) {
      expect(restorePointOf(status)).toBeNull();
    }
  });

  it("agrees with the image and the watchdog on names and codes", () => {
    expect(RESTORE_POINT_ID.test(ID)).toBe(true);
    expect(EXIT_ROLLED_BACK).toBe(79);
    expect(WATCHDOG_EXIT_ROLLED_BACK).toBe(EXIT_ROLLED_BACK);
  });
});
