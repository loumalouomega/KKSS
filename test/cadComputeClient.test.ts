import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { cancelOwnedJob, jobStatus, runOwnedJob } from "../app/main/cadComputeClient";

describe("CAD compute owner-scoped jobs", () => {
  it("keeps cancellation bound to the original document and request", async () => {
    const ownerId = `document-${randomUUID()}`;
    const requestId = `mesh-${randomUUID()}`;
    let finish!: () => void;
    const job = runOwnedJob({ ownerId, requestId }, () => new Promise<void>(resolve => { finish = resolve; }));
    expect(jobStatus(ownerId, requestId)?.state).toBe("queued");
    expect(cancelOwnedJob("another-document", requestId)).toBeUndefined();
    expect(jobStatus(ownerId, requestId)?.state).toBe("queued");
    expect(cancelOwnedJob(ownerId, requestId)?.state).toBe("cancelled");
    finish();
    await expect(job).rejects.toThrow(/cancelled by owner/);
    expect(jobStatus(ownerId, requestId)?.state).toBe("cancelled");
  });
});
