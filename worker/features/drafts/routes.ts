import { Hono } from "hono";
import { requireMailApiContext } from "../../auth/mail-api";
import type { HonoApp } from "../../lib/env";
import { AppError } from "../../lib/errors";
import { readJson } from "../../lib/json";
import { parseWith } from "../../lib/validation";
import { getAccessibleDraft, listAccessibleDrafts, requireDraftAccess } from "./access";
import { addDraftAttachment, deleteDraft, removeDraftAttachment, saveDraft } from "./queries";
import { draftSchema } from "./validation";

export const draftRoutes = new Hono<HonoApp>();
draftRoutes.get("/", async (c) => {
  const auth = await requireMailApiContext(c.env, c.req.raw, "mail:send");
  return c.json(await listAccessibleDrafts(c.env, principal(auth)));
});
draftRoutes.get("/:id", async (c) => {
  const auth = await requireMailApiContext(c.env, c.req.raw, "mail:send");
  return c.json(await getAccessibleDraft(c.env, principal(auth), c.req.param("id")));
});
draftRoutes.post("/", async (c) => {
  const auth = await requireMailApiContext(c.env, c.req.raw, "mail:send");
  const input = parseWith(draftSchema, await readJson(c.req.raw));
  await requireDraftAccess(c.env, principal(auth), input);
  return c.json(await saveDraft(c.env.DB, auth.user.id, input), 201);
});
draftRoutes.patch("/:id", async (c) => {
  const auth = await requireMailApiContext(c.env, c.req.raw, "mail:send");
  await getAccessibleDraft(c.env, principal(auth), c.req.param("id"));
  const input = parseWith(draftSchema, await readJson(c.req.raw));
  await requireDraftAccess(c.env, principal(auth), input);
  return c.json(await saveDraft(c.env.DB, auth.user.id, { ...input, id: c.req.param("id") }));
});
draftRoutes.delete("/:id", async (c) => {
  const auth = await requireMailApiContext(c.env, c.req.raw, "mail:send");
  await getAccessibleDraft(c.env, principal(auth), c.req.param("id"));
  if (!(await deleteDraft(c.env.DB, c.env.MAIL_OBJECTS, auth.user.id, c.req.param("id"))))
    throw new AppError("DRAFT_NOT_FOUND", "Draft not found.", 404);
  return c.body(null, 204);
});
draftRoutes.post("/:id/attachments", async (c) => {
  const auth = await requireMailApiContext(c.env, c.req.raw, "mail:send");
  await getAccessibleDraft(c.env, principal(auth), c.req.param("id"));
  const body = await c.req.raw.formData();
  const file = body.get("file");
  if (!(file instanceof File)) throw new AppError("FILE_REQUIRED", "Choose a file.", 400);
  const added = await addDraftAttachment(c.env.DB, auth.user.id, c.req.param("id"), file);
  await c.env.MAIL_OBJECTS.put(added.r2Key, file.stream(), {
    httpMetadata: { contentType: added.attachment.contentType }
  });
  return c.json(added.attachment, 201);
});
draftRoutes.delete("/:draftId/attachments/:id", async (c) => {
  const auth = await requireMailApiContext(c.env, c.req.raw, "mail:send");
  await getAccessibleDraft(c.env, principal(auth), c.req.param("draftId"));
  if (
    !(await removeDraftAttachment(
      c.env.DB,
      c.env.MAIL_OBJECTS,
      auth.user.id,
      c.req.param("draftId"),
      c.req.param("id")
    ))
  )
    throw new AppError("ATTACHMENT_NOT_FOUND", "Attachment not found.", 404);
  return c.body(null, 204);
});

function principal(auth: Awaited<ReturnType<typeof requireMailApiContext>>) {
  return { role: auth.user.role, userId: auth.user.id };
}
