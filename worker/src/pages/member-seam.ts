// The membership-aware person seam for the platform pages (WP8.3), behind WP8.4's `PersonSeam`
// (`pages/person.ts`, `actorOf(admitted) → PagePerson`): who an admitted Access identity is.
//
//   - In `owner` admission (the default, a team of one) the pinned owner is the installation's
//     owner without asking the server, as before teams, so the pages work while the server is
//     down or starting. Ingress admits nobody else there.
//   - In `members` admission everyone is whoever Omnigent binds their Access identity to
//     (`pagePerson`, a signed platform call), the pinned owner included: a matching address is
//     not membership. An active member gets a person with their role; an unbound, suspended or
//     removed identity, a server without a team model and a server that does not answer get
//     null, which the pages refuse. Nothing is cached, so a suspension applies to the next page.
//     The owner's one way in before a binding is Omnigent's one-time founding binding: they
//     sign in to Omnigent itself, which binds their identity once.
//
// The pages never read the identity themselves. Wired into the router when WP8.4's seam lands
// (it is the `deps.person` the router takes); until then `web.ts` opens the pages in `members`
// admission only to the pinned owner whose seam answer is an active owner.

import type { PagePersonCall, PagePersonResult } from "@cfo/contracts";
import type { Admitted } from "../ingress/index.ts";
import { OMNIGENT_SERVER_INTERFACE_VERSION, OMNIGENT_SERVER_OBJECT_NAME } from "../shared/rpc.ts";

/** The person a page request is for: WP8.4's `PagePerson`, member variant included. */
export type SeamPerson =
  | { readonly kind: "installation_owner" }
  | {
      readonly kind: "member";
      readonly memberId: string;
      readonly userId: string;
      readonly role: "owner" | "admin" | "member";
    };

/** What the seam asks: OmnigentServer's `pagePerson`. */
export interface PagePersonBackend {
  pagePerson(call: PagePersonCall): Promise<PagePersonResult>;
}

/** The web Worker's binding, typed down to the one method the seam calls. */
export function bindingsPagePersonBackend(env: {
  readonly OMNIGENT: { getByName(name: string): unknown };
}): PagePersonBackend {
  return env.OMNIGENT.getByName(OMNIGENT_SERVER_OBJECT_NAME) as PagePersonBackend;
}

/** The seam: the pinned owner, an active member, or null (refused). */
export function memberSeam(
  backend: PagePersonBackend,
  log: (fields: Readonly<Record<string, string>>) => void = () => undefined,
): (admitted: Admitted) => Promise<SeamPerson | null> {
  return async (admitted) => {
    const { identity } = admitted;
    if (admitted.admission !== "members") {
      return identity.pin !== false ? { kind: "installation_owner" } : null;
    }
    if (identity.issuer === undefined || identity.audience === undefined) return null;
    let answer: PagePersonResult;
    try {
      answer = await backend.pagePerson({
        interfaceVersion: OMNIGENT_SERVER_INTERFACE_VERSION,
        issuer: identity.issuer,
        subject: identity.sub,
        audience: identity.audience,
      });
    } catch {
      log({ event: "page_person", outcome: "error" });
      return null;
    }
    if (answer.action !== "member" || answer.state !== "active") {
      log({
        event: "page_person",
        outcome: answer.action === "member" ? answer.state : answer.action,
      });
      return null;
    }
    return { kind: "member", memberId: answer.memberId, userId: answer.userId, role: answer.role };
  };
}
