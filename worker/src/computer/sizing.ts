// Pure: a computer's instance size at each start, and the size budget (design, "Size and
// number"). A running container cannot be resized, so a size chosen on the cloud-computers page
// waits for the next start; the installation's maximum (ControlDO's `limits`) caps it there.

import { DEFAULT_INSTANCE_SIZE, InstanceSize } from "@cfo/contracts";

/** Instance sizes, smallest first (the contract lists them in this order). */
export const SIZE_ORDER: readonly InstanceSize[] = InstanceSize.options;

/** The page warns above this many bytes of declared directories (design, size budget). */
export const WORKSPACE_WARNING_BYTES = 1_500_000_000;

export interface SizeSetting {
  /** The size the current or last container started with. */
  readonly size: InstanceSize;
  /** A size chosen since, applied at the next start. */
  readonly nextSize: InstanceSize | null;
}

export const INITIAL_SIZE: SizeSetting = { size: DEFAULT_INSTANCE_SIZE, nextSize: null };

function rank(size: InstanceSize): number {
  return SIZE_ORDER.indexOf(size);
}

/** The size, or the installation's maximum if it is smaller. */
export function clampSize(size: InstanceSize, max: InstanceSize | null): InstanceSize {
  if (max === null) return size;
  return rank(size) > rank(max) ? max : size;
}

/** Records a size chosen on the page; it applies at the next start. */
export function chooseSize(setting: SizeSetting, size: InstanceSize): SizeSetting {
  return { size: setting.size, nextSize: size === setting.size ? null : size };
}

/**
 * The size a start uses: the chosen size if any, within the installation's maximum, and never
 * left to Cloudflare's default (`lite`, far too small). The setting afterwards has no pending
 * choice.
 */
export function sizeForStart(
  setting: SizeSetting,
  max: InstanceSize | null,
): { readonly instance: InstanceSize; readonly setting: SizeSetting } {
  const instance = clampSize(setting.nextSize ?? setting.size, max);
  return { instance, setting: { size: instance, nextSize: null } };
}

/** Whether the page shows the size warning for this many bytes of declared directories. */
export function workspaceSizeWarning(bytes: number | null): boolean {
  return bytes !== null && bytes > WORKSPACE_WARNING_BYTES;
}
