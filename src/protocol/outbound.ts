/**
 * 出站消息构造。
 *
 * 一个 `MessageItem` 一次请求，`item_list` 只放一项——与官方发送端一致，
 * 这样每种媒体的回执能各自对上服务端返回的 message_id。
 * 说明文字作为独立 TEXT 项先发，不塞进媒体项里。
 */
import { randomUUID } from 'node:crypto';

import { encodeAesKeyHex } from './crypto.ts';
import type { UploadedMedia } from './media.ts';
import {
  MessageItemType,
  MessageState,
  MessageType,
  type MessageItem,
  type WeixinMessage,
} from './types.ts';

export function newClientId(): string {
  return `cortico-claw-${randomUUID()}`;
}

/** 一条待发消息的公共信封。 */
function envelope(params: {
  to: string;
  contextToken?: string;
  item: MessageItem;
  clientId?: string;
}): WeixinMessage {
  return {
    from_user_id: '',
    to_user_id: params.to,
    client_id: params.clientId ?? newClientId(),
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    item_list: [params.item],
    ...(params.contextToken ? { context_token: params.contextToken } : {}),
  };
}

export function textMessage(params: {
  to: string;
  text: string;
  contextToken?: string;
}): WeixinMessage {
  return envelope({
    to: params.to,
    contextToken: params.contextToken,
    item: { type: MessageItemType.TEXT, text_item: { text: params.text } },
  });
}

/** 图片项：`mid_size` 填密文字节数，密钥按十六进制字符串再 base64。 */
export function imageMessage(params: {
  to: string;
  uploaded: UploadedMedia;
  contextToken?: string;
}): WeixinMessage {
  return envelope({
    to: params.to,
    contextToken: params.contextToken,
    item: {
      type: MessageItemType.IMAGE,
      image_item: {
        media: {
          encrypt_query_param: params.uploaded.downloadQueryParam,
          aes_key: encodeAesKeyHex(params.uploaded.aesKeyHex),
          encrypt_type: 1,
        },
        mid_size: params.uploaded.cipherSize,
      },
    },
  });
}

export function videoMessage(params: {
  to: string;
  uploaded: UploadedMedia;
  contextToken?: string;
}): WeixinMessage {
  return envelope({
    to: params.to,
    contextToken: params.contextToken,
    item: {
      type: MessageItemType.VIDEO,
      video_item: {
        media: {
          encrypt_query_param: params.uploaded.downloadQueryParam,
          aes_key: encodeAesKeyHex(params.uploaded.aesKeyHex),
          encrypt_type: 1,
        },
        video_size: params.uploaded.cipherSize,
      },
    },
  });
}

/** 文件项：`len` 是明文字节数的十进制字符串。 */
export function fileMessage(params: {
  to: string;
  fileName: string;
  uploaded: UploadedMedia;
  contextToken?: string;
}): WeixinMessage {
  return envelope({
    to: params.to,
    contextToken: params.contextToken,
    item: {
      type: MessageItemType.FILE,
      file_item: {
        media: {
          encrypt_query_param: params.uploaded.downloadQueryParam,
          aes_key: encodeAesKeyHex(params.uploaded.aesKeyHex),
          encrypt_type: 1,
        },
        file_name: params.fileName,
        len: String(params.uploaded.rawSize),
      },
    },
  });
}
