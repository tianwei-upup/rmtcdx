import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { findLatestUserMessagePreview, mapThreadItemToMessage } from "../../src/codex/parsers/thread-items";
import { ImageUploadService } from "../../src/uploads/image-upload-service";
import type { CodexThread } from "../../src/codex/types";

test("desktop images outside bridge uploads do not break history or expose files", () => {
  const root = path.resolve("test-fixture", "uploads");
  const uploads = new ImageUploadService(root, "/api/uploads/", 5, 1024);
  const outside = path.resolve(root, "..", "clipboard.png");
  const item = { type: "userMessage" as const, id: "user_desktop", content: [
    { type: "text" as const, text: "Explain this screenshot" },
    { type: "localImage" as const, path: outside }
  ] };
  const message = mapThreadItemToMessage("desktop", item, "2026-10-14T00:00:00Z", { uploads });
  assert.ok(message);
  assert.equal(message.attachments?.length, 0);
  assert.ok(message.text.includes("Explain this screenshot"));
  assert.ok(message.text.includes("[local image]"));
  const thread = { turns: [{ items: [item] }] } as CodexThread;
  assert.ok(findLatestUserMessagePreview(thread, uploads)?.includes("Explain this screenshot"));
  assert.equal(uploads.publicUrlForPath(outside), null);
  assert.equal(uploads.publicUrlForPath(root), null);
  assert.equal(uploads.publicUrlForPath(path.resolve(root, "..", "uploads-other", "secret.png")), null);
  assert.equal(uploads.publicUrlForPath(path.join(root, "batch", "01-image space.png")),
    "/api/uploads/batch/01-image%20space.png");
});
