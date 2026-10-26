/** Random, valid IDs for ControlDO tests: each test uses its own computers and operations. */
import type { ComputerId, OperationId } from "@cfo/contracts";

const BASE32 = "0123456789abcdefghjkmnpqrstvwxyz";

function digits(): string {
  let text = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(26))) text += BASE32[byte & 31];
  return text;
}

export function newComputerId(): ComputerId {
  return `cmp_${digits()}`;
}

export function newOperationId(): OperationId {
  return `op_${digits()}`;
}
