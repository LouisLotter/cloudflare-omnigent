// What the platform pages read and change, behind one interface (WP3.5): the computers ControlDO
// records, each computer's WorkspaceDO through its narrow pages interface and the terminal's
// upgrade, and OmnigentServer's outage records and replication health. The pages never call the
// launcher's or the computer's operations. Pure: the bindings are passed in, so tests use fakes.

import {
  CONTROL_INTERFACE_VERSION,
  type ComputerId,
  type OutageRecord,
  type PageFrontCall,
  type PageFrontResult,
  type PageOwner,
  type PagesCall,
  type PagesResult,
  type ReplicationHealth,
  WORKSPACE_INTERFACE_VERSION,
} from "@cfo/contracts";
import type { WebEnv } from "../env.ts";
import { errorCodeOf } from "../shared/errors.ts";
import {
  CONTROL_OBJECT_NAME,
  type ControlPagesStub,
  OMNIGENT_SERVER_INTERFACE_VERSION,
  OMNIGENT_SERVER_OBJECT_NAME,
  type OmnigentServerRpc,
  type WorkspacePagesStub,
  workspaceObjectName,
} from "../shared/rpc.ts";

export type StateResult = Extract<PagesResult, { action: "state" }>;

export interface PagesBackend {
  /** Every computer ControlDO records, by name. */
  computers(): Promise<readonly { readonly computerId: ComputerId; readonly name: string }[]>;
  /** One computer's page state with the session's intent token; null if it does not exist. */
  state(computerId: ComputerId, owner: PageOwner): Promise<StateResult | null>;
  /** A page action: the front's calls, or the controller's mutating `PagesCall`. */
  act(
    computerId: ComputerId,
    call: PagesCall | PageFrontCall,
  ): Promise<PagesResult | PageFrontResult>;
  /** The terminal's upgrade, as the web Worker built it, to the computer's WorkspaceDO. */
  upgrade(computerId: ComputerId, request: Request): Promise<Response>;
  /** The server's outages overlapping [from, to); empty if they cannot be read. */
  outages(fromIso: string, toIso: string): Promise<readonly OutageRecord[] | null>;
  /** The replication health; null if it cannot be read. */
  replication(): Promise<ReplicationHealth | null>;
}

/** The pages' bindings: WebEnv's, typed down to what the pages may call. */
export interface PagesBindings {
  readonly WORKSPACE: { getByName(name: string): unknown };
  readonly CONTROL: { getByName(name: string): unknown };
  readonly OMNIGENT: { getByName(name: string): unknown };
}

export function bindingsBackend(env: WebEnv | PagesBindings): PagesBackend {
  const workspace = (id: ComputerId) =>
    (env as PagesBindings).WORKSPACE.getByName(workspaceObjectName(id)) as WorkspacePagesStub;
  const control = () =>
    (env as PagesBindings).CONTROL.getByName(CONTROL_OBJECT_NAME) as ControlPagesStub;
  const server = () =>
    (env as PagesBindings).OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME) as Pick<
      OmnigentServerRpc,
      "outages" | "replication"
    >;
  return {
    async computers() {
      const result = await control().control({
        method: "list_computers",
        interfaceVersion: CONTROL_INTERFACE_VERSION,
      });
      return result.method === "list_computers" ? result.computers : [];
    },
    async state(computerId, owner) {
      try {
        const result = await workspace(computerId).pages({
          action: "state",
          interfaceVersion: WORKSPACE_INTERFACE_VERSION,
          owner,
        });
        return result.action === "state" ? (result as StateResult) : null;
      } catch (error) {
        if (errorCodeOf(error) === "not_found") return null;
        throw error;
      }
    },
    act(computerId, call) {
      return workspace(computerId).pages(call);
    },
    upgrade(computerId, request) {
      return workspace(computerId).fetch(request);
    },
    async outages(from, to) {
      try {
        return await server().outages({
          interfaceVersion: OMNIGENT_SERVER_INTERFACE_VERSION,
          from,
          to,
        });
      } catch {
        return null;
      }
    },
    async replication() {
      try {
        return await server().replication({ interfaceVersion: OMNIGENT_SERVER_INTERFACE_VERSION });
      } catch {
        return null;
      }
    },
  };
}
