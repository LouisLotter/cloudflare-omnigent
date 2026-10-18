import { DurableObject } from "cloudflare:workers";
import { migrate } from "../shared/sql.ts";
import { CONTROL_MIGRATIONS } from "./schema.ts";

export interface ControlHealth {
  readonly schemaVersion: number;
  /** How many times this object has been constructed: increases after every eviction. */
  readonly boots: number;
}

/** Installation-wide limits, schedule cache and platform login. Scaffold: schema and health only. */
export class ControlDO extends DurableObject<Env> {
  #schemaVersion = 0;
  #boots = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.#schemaVersion = migrate(ctx.storage, CONTROL_MIGRATIONS);
      const row = ctx.storage.sql
        .exec<{ value: string }>(
          `INSERT INTO control_meta (key, value) VALUES ('boots', '1')
           ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
           RETURNING value`,
        )
        .one();
      this.#boots = Number(row.value);
    });
  }

  async health(): Promise<ControlHealth> {
    return { schemaVersion: this.#schemaVersion, boots: this.#boots };
  }
}
