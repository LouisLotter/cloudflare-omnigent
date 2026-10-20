// The DC-36 probe Worker. It only has to deploy with its container application; no request ever
// starts the container.
import { DurableObject } from "cloudflare:workers";

export class Probe extends DurableObject {}

export default {
  async fetch(): Promise<Response> {
    return new Response("DC-36 probe: nothing runs here.\n");
  },
};
