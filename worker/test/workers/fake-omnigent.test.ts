import { describe, expect, it } from "vitest";
import {
  FakeOmnigent,
  FakeOmnigentDroppedError,
  type ScheduledTaskListJson,
} from "../support/fake-omnigent.ts";

// The fake's behaviour is covered in test/unit; this checks that it also works inside workerd.
describe("FakeOmnigent in workerd", () => {
  it("serves requests through its fetch handler", async () => {
    const fake = new FakeOmnigent();
    const task = fake.addTask({ host_id: "host-1" });
    const fetcher: (request: Request) => Promise<Response> = fake.fetch;

    const list = await fetcher(new Request("https://omnigent.test/v1/scheduled-tasks"));
    const put = await fetcher(
      new Request("https://omnigent.test/v1/sharing", {
        method: "PUT",
        body: JSON.stringify({ sharing_mode: "off" }),
      }),
    );

    expect(((await list.json()) as ScheduledTaskListJson).scheduled_tasks).toMatchObject([
      { id: task.id, host_id: "host-1" },
    ]);
    expect(put.status).toBe(200);
    expect(fake.sharing.sharing_mode).toBe("off");
  });

  it("delays with real timers and drops responses", async () => {
    const fake = new FakeOmnigent();
    const task = fake.addTask();
    fake.inject("POST /v1/scheduled-tasks/{id}/run", { delayMs: 5, drop: "response" });

    const result = fake.fetch(
      new Request(`https://omnigent.test/v1/scheduled-tasks/${task.id}/run`, { method: "POST" }),
    );

    await expect(result).rejects.toBeInstanceOf(FakeOmnigentDroppedError);
    expect(fake.runs(task.id)).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ outcome: "dropped", status: 202 });
  });
});
