import type { MessageScope } from "../../auth/mailbox-access";
import { messageScopeSql } from "../../auth/mailbox-access";
import { newId, nowIso } from "../../db/client";
import { AppError } from "../../lib/errors";
import type { MessageAction } from "./actions";
import { buildMessageActionPatch } from "./actions";
import { decodeKeysetCursor, encodeKeysetCursor, type KeysetCursor } from "./keyset-cursor";
import type {
  AttachmentRow,
  InsertAttachmentInput,
  InsertMessageInput,
  MessageDetail,
  MessageRow,
  MessageSummary,
  StoredAttachment
} from "./types";

const messageSelect = `SELECT messages.*,
  (SELECT address FROM mailbox_addresses
   WHERE id = messages.delivered_to_address_id) AS delivered_to_address
  FROM messages`;

/** Message cursors are versioned separately from conversation cursors. */
const messageCursorVersion = "m1";
const messageActivityAt = "COALESCE(received_at, sent_at, created_at)";

export const defaultMessageLimit = 100;
export const maxMessageLimit = 100;

export type ListMessageFilters = {
  cursor?: string | undefined;
  folder?: string | undefined;
  limit?: number | undefined;
  mailboxId?: string | undefined;
  search?: string | undefined;
  scope: MessageScope;
};

export type MessagePage = {
  messages: MessageSummary[];
  nextCursor: string | null;
};

export function decodeMessageCursor(value: string): KeysetCursor {
  const cursor = decodeKeysetCursor(messageCursorVersion, value);
  if (!cursor) {
    throw new AppError("INVALID_CURSOR", "Message cursor is invalid.", 400);
  }
  return cursor;
}

export async function insertMessage(
  db: D1Database,
  input: InsertMessageInput
): Promise<MessageSummary> {
  const id = newId("msg");
  const timestamp = nowIso();

  await db
    .prepare(
      `INSERT INTO messages (
        id, thread_id, mailbox_id, is_unassigned, direction, folder,
        from_address, to_json, cc_json, bcc_json,
        subject, snippet, text_body, html_r2_key, raw_r2_key, message_id, dedupe_key,
        in_reply_to, references_json, received_at, sent_at, read_at, has_attachments,
        created_at, updated_at, delivered_to_address_id, sent_from_address_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      input.threadId,
      input.mailboxId,
      input.isUnassigned ? 1 : 0,
      input.direction,
      input.folder,
      input.fromAddress,
      JSON.stringify(input.to),
      JSON.stringify(input.cc),
      JSON.stringify(input.bcc),
      input.subject,
      input.snippet,
      input.textBody,
      input.htmlR2Key,
      input.rawR2Key,
      input.messageId,
      input.dedupeKey,
      input.inReplyTo,
      JSON.stringify(input.references),
      input.receivedAt,
      input.sentAt,
      input.readAt,
      input.hasAttachments ? 1 : 0,
      timestamp,
      timestamp,
      input.deliveredToAddressId ?? null,
      input.sentFromAddressId ?? null
    )
    .run();

  const row = await getMessageRow(db, id);
  if (!row) {
    throw new AppError("MESSAGE_INSERT_FAILED", "Message could not be stored.", 500);
  }
  return mapMessageSummary(row);
}

export async function insertAttachment(
  db: D1Database,
  input: InsertAttachmentInput
): Promise<StoredAttachment> {
  const id = newId("att");
  const timestamp = nowIso();
  await db
    .prepare(
      `INSERT INTO message_attachments
       (id, message_id, filename, content_type, size_bytes, content_id, r2_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      input.messageId,
      input.filename,
      input.contentType,
      input.sizeBytes,
      input.contentId,
      input.r2Key,
      timestamp
    )
    .run();

  return {
    id,
    messageId: input.messageId,
    filename: input.filename,
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    contentId: input.contentId,
    r2Key: input.r2Key,
    createdAt: timestamp
  };
}

export async function listMessages(
  db: D1Database,
  filters: ListMessageFilters
): Promise<MessageSummary[]> {
  return (await listMessagePage(db, filters)).messages;
}

export async function listMessagePage(
  db: D1Database,
  filters: ListMessageFilters
): Promise<MessagePage> {
  const where: string[] = [];
  const params: Array<string | number> = [];

  // The access filter is applied first and is never relaxed by a cursor.
  const scope = messageScopeSql(filters.scope, "mailbox_id", "is_unassigned");
  if (!scope) return { messages: [], nextCursor: null };
  where.push(scope.sql);
  params.push(...scope.params);

  if (filters.folder) {
    where.push("folder = ?");
    params.push(filters.folder);
  }
  if (filters.mailboxId) {
    where.push("mailbox_id = ?");
    params.push(filters.mailboxId);
  }
  if (filters.search) {
    where.push(
      "(subject LIKE ? OR from_address LIKE ? OR to_json LIKE ? OR snippet LIKE ? OR text_body LIKE ?)"
    );
    const like = `%${filters.search}%`;
    params.push(like, like, like, like, like);
  }

  const cursor = filters.cursor ? decodeMessageCursor(filters.cursor) : null;
  if (cursor) {
    where.push(`(${messageActivityAt} < ? OR (${messageActivityAt} = ? AND messages.id < ?))`);
    params.push(cursor.activityAt, cursor.activityAt, cursor.id);
  }

  const limit = Math.min(Math.max(filters.limit ?? defaultMessageLimit, 1), maxMessageLimit);
  // Read one extra row to learn whether another page exists.
  const sql = `${messageSelect} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY ${messageActivityAt} DESC, messages.id DESC LIMIT ?`;
  params.push(limit + 1);

  const result = await db
    .prepare(sql)
    .bind(...params)
    .all<MessageRow>();

  const pageRows = result.results.slice(0, limit);
  const finalRow = pageRows.at(-1);
  return {
    messages: pageRows.map(mapMessageSummary),
    nextCursor:
      result.results.length > limit && finalRow
        ? encodeKeysetCursor(messageCursorVersion, {
            activityAt: messageActivityOf(finalRow),
            id: finalRow.id
          })
        : null
  };
}

function messageActivityOf(row: MessageRow): string {
  return row.received_at ?? row.sent_at ?? row.created_at;
}

export async function getMessageDetail(db: D1Database, id: string): Promise<MessageDetail | null> {
  const row = await getMessageRow(db, id);
  if (!row) {
    return null;
  }

  return mapMessageDetail(db, row);
}

export async function listThreadMessages(
  db: D1Database,
  threadId: string,
  scope: MessageScope
): Promise<MessageDetail[]> {
  const scopeSql = messageScopeSql(scope, "mailbox_id", "is_unassigned");
  if (!scopeSql) return [];
  const result = await db
    .prepare(
      `${messageSelect}
       WHERE thread_id = ? AND ${scopeSql.sql}
       ORDER BY COALESCE(received_at, sent_at, created_at) ASC
       LIMIT 100`
    )
    .bind(threadId, ...scopeSql.params)
    .all<MessageRow>();
  return Promise.all(result.results.map((row) => mapMessageDetail(db, row)));
}

async function mapMessageDetail(db: D1Database, row: MessageRow): Promise<MessageDetail> {
  return {
    ...mapMessageSummary(row),
    cc: parseJsonList(row.cc_json),
    bcc: parseJsonList(row.bcc_json),
    deliveredToAddress: row.delivered_to_address,
    textBody: row.text_body,
    htmlAvailable: row.html_r2_key !== null,
    messageId: row.message_id,
    inReplyTo: row.in_reply_to,
    references: parseJsonList(row.references_json),
    attachments: await listAttachments(db, row.id)
  };
}

export async function updateMessageAction(
  db: D1Database,
  id: string,
  action: MessageAction
): Promise<MessageSummary> {
  const current = await getMessageRow(db, id);
  if (!current) {
    throw new AppError("MESSAGE_NOT_FOUND", "Message not found.", 404);
  }

  const timestamp = nowIso();
  const patch = buildMessageActionPatch(action, timestamp);
  await db
    .prepare(
      `UPDATE messages
       SET folder = ?, read_at = ?, starred_at = ?, archived_at = ?, trashed_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(
      patch.folder ?? current.folder,
      patch.readAt === undefined ? current.read_at : patch.readAt,
      patch.starredAt === undefined ? current.starred_at : patch.starredAt,
      patch.archivedAt === undefined ? current.archived_at : patch.archivedAt,
      patch.trashedAt === undefined ? current.trashed_at : patch.trashedAt,
      timestamp,
      id
    )
    .run();

  const row = await getMessageRow(db, id);
  if (!row) {
    throw new AppError("MESSAGE_NOT_FOUND", "Message not found.", 404);
  }
  return mapMessageSummary(row);
}

export async function findAttachment(db: D1Database, id: string): Promise<StoredAttachment | null> {
  const row = await db
    .prepare("SELECT * FROM message_attachments WHERE id = ?")
    .bind(id)
    .first<AttachmentRow>();

  return row ? mapAttachment(row) : null;
}

export async function getMessageHtmlKey(db: D1Database, id: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT html_r2_key FROM messages WHERE id = ?")
    .bind(id)
    .first<{ html_r2_key: string | null }>();
  return row?.html_r2_key ?? null;
}

async function getMessageRow(db: D1Database, id: string): Promise<MessageRow | null> {
  return db.prepare(`${messageSelect} WHERE messages.id = ?`).bind(id).first<MessageRow>();
}

async function listAttachments(db: D1Database, messageId: string): Promise<StoredAttachment[]> {
  const result = await db
    .prepare("SELECT * FROM message_attachments WHERE message_id = ? ORDER BY filename ASC")
    .bind(messageId)
    .all<AttachmentRow>();

  return result.results.map(mapAttachment);
}

export function mapMessageSummary(row: MessageRow): MessageSummary {
  return {
    id: row.id,
    threadId: row.thread_id,
    mailboxId: row.mailbox_id,
    direction: row.direction,
    folder: row.folder,
    fromAddress: row.from_address,
    to: parseJsonList(row.to_json),
    subject: row.subject,
    snippet: row.snippet,
    receivedAt: row.received_at,
    sentAt: row.sent_at,
    readAt: row.read_at,
    starredAt: row.starred_at,
    hasAttachments: row.has_attachments === 1,
    createdAt: row.created_at
  };
}

function mapAttachment(row: AttachmentRow): StoredAttachment {
  return {
    id: row.id,
    messageId: row.message_id,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    contentId: row.content_id,
    r2Key: row.r2_key,
    createdAt: row.created_at
  };
}

function parseJsonList(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}
