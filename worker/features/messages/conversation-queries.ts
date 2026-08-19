import type { MessageScope } from "../../auth/mailbox-access";
import { messageScopeSql } from "../../auth/mailbox-access";
import { nowIso } from "../../db/client";
import { AppError } from "../../lib/errors";

import type { MessageAction } from "./actions";
import { decodeKeysetCursor, encodeKeysetCursor, type KeysetCursor } from "./keyset-cursor";
import type {
  ConversationFolder,
  ConversationPage,
  ConversationRow,
  ConversationSummary
} from "./types";

/** Conversation cursors keep version 1. Message cursors use a different version tag. */
const conversationCursorVersion = 1;

export type ListConversationFilters = {
  cursor?: string | undefined;
  folder?: ConversationFolder | undefined;
  limit?: number | undefined;
  mailboxId?: string | undefined;
  scope: MessageScope;
  search?: string | undefined;
};

export async function listConversations(
  db: D1Database,
  filters: ListConversationFilters
): Promise<ConversationSummary[]> {
  const page = await listConversationPage(db, {
    ...filters,
    limit: filters.limit ?? 100
  });
  return page.conversations;
}

export async function listConversationPage(
  db: D1Database,
  filters: ListConversationFilters
): Promise<ConversationPage> {
  const scope = messageScopeSql(filters.scope, "messages.mailbox_id", "messages.is_unassigned");
  if (!scope) {
    return {
      conversations: [],
      nextCursor: null,
      totalCount: filters.cursor ? null : 0
    };
  }

  const accessibleWhere = scope.sql;
  const params: Array<string | number> = [...scope.params];

  const eligibilityWhere: string[] = [];
  if (filters.mailboxId) {
    eligibilityWhere.push("accessible.mailbox_id = ?");
    params.push(filters.mailboxId);
  }
  if (filters.folder === "starred") {
    eligibilityWhere.push("accessible.starred_at IS NOT NULL");
  } else if (filters.folder) {
    eligibilityWhere.push("accessible.folder = ?");
    params.push(filters.folder);
  }
  if (filters.search) {
    eligibilityWhere.push(
      `(accessible.subject LIKE ? OR accessible.from_address LIKE ?
        OR accessible.to_json LIKE ? OR accessible.snippet LIKE ? OR accessible.text_body LIKE ?)`
    );
    const like = `%${filters.search}%`;
    params.push(like, like, like, like, like);
  }

  const cursor = filters.cursor ? decodeConversationCursor(filters.cursor) : null;
  if (cursor) {
    params.push(cursor.activityAt, cursor.activityAt, cursor.id);
  }
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
  params.push(limit + 1);
  const result = await db
    .prepare(
      `WITH accessible AS (
         SELECT messages.*,
           COALESCE(messages.received_at, messages.sent_at, messages.created_at) AS activity_at
         FROM messages
         WHERE ${accessibleWhere}
       ),
       eligible_threads AS (
         SELECT DISTINCT accessible.thread_id
         FROM accessible
         ${eligibilityWhere.length ? `WHERE ${eligibilityWhere.join(" AND ")}` : ""}
       ),
       ranked AS (
         SELECT accessible.*,
           ROW_NUMBER() OVER (
             PARTITION BY accessible.thread_id
             ORDER BY accessible.activity_at DESC, accessible.id DESC
           ) AS thread_position
         FROM accessible
         JOIN eligible_threads ON eligible_threads.thread_id = accessible.thread_id
       ),
       aggregates AS (
         SELECT accessible.thread_id,
           COUNT(*) AS message_count,
           SUM(
             CASE WHEN accessible.direction = 'inbound' AND accessible.read_at IS NULL
               THEN 1 ELSE 0 END
           ) AS unread_count,
           MAX(CASE WHEN accessible.starred_at IS NOT NULL THEN 1 ELSE 0 END) AS is_starred,
           MAX(accessible.has_attachments) AS has_thread_attachments
         FROM accessible
         JOIN eligible_threads ON eligible_threads.thread_id = accessible.thread_id
         GROUP BY accessible.thread_id
       )
       SELECT ranked.*, aggregates.message_count, aggregates.unread_count,
         aggregates.is_starred, aggregates.has_thread_attachments,
         ${cursor ? "NULL" : "COUNT(*) OVER ()"} AS total_count
       FROM ranked
       JOIN aggregates ON aggregates.thread_id = ranked.thread_id
       WHERE ranked.thread_position = 1
       ${
         cursor
           ? `AND (
             ranked.activity_at < ?
             OR (ranked.activity_at = ? AND ranked.id < ?)
           )`
           : ""
}
       ORDER BY ranked.activity_at DESC, ranked.id DESC
       LIMIT ?`
    )
    .bind(...params)
    .all<ConversationRow>();

  const pageRows = result.results.slice(0, limit);
  const finalRow = pageRows.at(-1);
  return {
    conversations: pageRows.map(mapConversationSummary),
    nextCursor:
      result.results.length > limit && finalRow
        ? encodeConversationCursor({ activityAt: finalRow.activity_at, id: finalRow.id })
        : null,
    totalCount: cursor ? null : (pageRows[0]?.total_count ?? 0)
  };
}

export async function updateConversationAction(
  db: D1Database,
  input: {
    action: MessageAction;
    activeFolder: ConversationFolder;
    messageId: string;
    scope: MessageScope;
  }
): Promise<{ affected: number; threadId: string }> {
  const selected = await db
    .prepare("SELECT thread_id FROM messages WHERE id = ?")
    .bind(input.messageId)
    .first<{ thread_id: string }>();
  if (!selected) {
    throw new AppError("MESSAGE_NOT_FOUND", "Message not found.", 404);
  }
  const scope = messageScopeSql(input.scope, "mailbox_id", "is_unassigned");
  if (!scope) {
    throw new AppError("MAILBOX_FORBIDDEN", "You do not have access to this mailbox.", 403);
  }

  const timestamp = nowIso();
  const where = [`thread_id = ?`, scope.sql];
  const bindings: Array<string | null> = [selected.thread_id, ...scope.params];
  let set: string;

  switch (input.action) {
    case "read":
      set = "read_at = ?, updated_at = ?";
      bindings.unshift(timestamp, timestamp);
      where.push("direction = 'inbound'");
      break;
    case "unread":
      set = "read_at = NULL, updated_at = ?";
      bindings.unshift(timestamp);
      where.push("direction = 'inbound'");
      break;
    case "star":
      set = "starred_at = ?, updated_at = ?";
      bindings.unshift(timestamp, timestamp);
      break;
    case "unstar":
      set = "starred_at = NULL, updated_at = ?";
      bindings.unshift(timestamp);
      break;
    case "archive":
      set = "folder = 'archived', archived_at = ?, updated_at = ?";
      bindings.unshift(timestamp, timestamp);
      where.push("folder IN ('inbox', 'catchall')");
      break;
    case "trash":
      set = "folder = 'trash', trashed_at = ?, updated_at = ?";
      bindings.unshift(timestamp, timestamp);
      if (input.activeFolder === "starred") {
        where.push("starred_at IS NOT NULL");
      } else {
        where.push("folder = ?");
        bindings.push(input.activeFolder);
      }
      break;
  }

  const result = await db
    .prepare(`UPDATE messages SET ${set} WHERE ${where.join(" AND ")} RETURNING id`)
    .bind(...bindings)
    .all<{ id: string }>();
  return { affected: result.results.length, threadId: selected.thread_id };
}

function mapConversationSummary(row: ConversationRow): ConversationSummary {
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
    hasAttachments: row.has_thread_attachments === 1,
    createdAt: row.created_at,
    isStarred: row.is_starred === 1,
    messageCount: row.message_count,
    unreadCount: row.unread_count
  };
}

function encodeConversationCursor(cursor: KeysetCursor): string {
  return encodeKeysetCursor(conversationCursorVersion, cursor);
}

function decodeConversationCursor(value: string): KeysetCursor {
  const cursor = decodeKeysetCursor(conversationCursorVersion, value);
  if (!cursor) {
    throw new AppError("INVALID_CONVERSATION_CURSOR", "Conversation cursor is invalid.", 400);
  }
  return cursor;
}

function parseJsonList(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}
