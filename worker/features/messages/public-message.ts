import type { MessageDetail } from "./types";

export function publicMessage(message: MessageDetail) {
  return {
    ...message,
    attachments: message.attachments.map(({ r2Key: _r2Key, ...attachment }) => attachment)
  };
}
