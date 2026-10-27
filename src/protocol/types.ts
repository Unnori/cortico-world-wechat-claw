/**
 * iLink HTTP 协议的线上形状。
 *
 * 字段名与枚举取自腾讯官方 `@tencent-weixin/openclaw-weixin` 2.4.10 的
 * `src/api/types.ts`，以及同仓 `docs/protocol_zh_CN.md`。JSON 里的 bytes 字段是
 * base64 字符串；`message_id`、`msg_id`、`svr_id` 在线上是 uint64，解析时必须当字符串读，
 * 否则 19 位 ID 会丢精度（见 `parseILinkJson`）。
 */

/** 每个 CGI 请求都带的公共元数据。 */
export interface BaseInfo {
  channel_version?: string;
  /** 观测标识，UA 形状，不参与鉴权与路由。 */
  bot_agent?: string;
}

/** `getuploadurl` 的 media_type。 */
export const UploadMediaType = {
  IMAGE: 1,
  VIDEO: 2,
  FILE: 3,
  VOICE: 4,
} as const;

export interface GetUploadUrlReq {
  filekey?: string;
  media_type?: number;
  to_user_id?: string;
  /** 原文件明文大小。 */
  rawsize?: number;
  /** 原文件明文 MD5，十六进制小写。 */
  rawfilemd5?: string;
  /** AES-128-ECB + PKCS#7 填充后的密文大小。 */
  filesize?: number;
  thumb_rawsize?: number;
  thumb_rawfilemd5?: string;
  thumb_filesize?: number;
  no_need_thumb?: boolean;
  /** 16 字节密钥的十六进制字符串。 */
  aeskey?: string;
}

export interface GetUploadUrlResp {
  upload_param?: string;
  thumb_upload_param?: string;
  /** 服务端直接给出的完整上传地址，优先于 upload_param。 */
  upload_full_url?: string;
}

/** `WeixinMessage.message_type`。 */
export const MessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const;

/** `MessageItem.type`。 */
export const MessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
  TOOL_CALL_START: 11,
  TOOL_CALL_RESULT: 12,
} as const;

/** `WeixinMessage.message_state`。 */
export const MessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

export interface TextItem {
  text?: string;
}

/** CDN 媒体引用；`aes_key` 是 base64 后的字节。 */
export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  /** 0 = 只加密 fileid；1 = 打包缩略图/中图。 */
  encrypt_type?: number;
  /** 服务端直接给出的完整下载地址。 */
  full_url?: string;
}

export interface ImageItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  /** 32 位十六进制明文密钥，入站解密优先于 `media.aes_key`。 */
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
}

export interface VoiceItem {
  media?: CDNMedia;
  /** 1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex。 */
  encode_type?: number;
  bits_per_sample?: number;
  sample_rate?: number;
  playtime?: number;
  /** 服务端语音转文字结果。 */
  text?: string;
}

export interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  md5?: string;
  /** 明文字节数，十进制字符串。 */
  len?: string;
}

export interface VideoItem {
  media?: CDNMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
  thumb_media?: CDNMedia;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
}

export interface RefMessage {
  message_item?: MessageItem;
  /** 被引用内容的摘要。 */
  title?: string;
  /** 新版客户端只给服务端消息 ID。 */
  svr_id?: string;
  partial_text?: PartialText;
}

export interface PartialText {
  start: string;
  end: string;
  startindex: number;
  endindex: number;
  quotemd5: string;
}

export interface ToolCallStartItem {
  tool_name?: string;
  tool_call_id?: string;
}

export interface ToolCallResultItem {
  tool_name?: string;
  tool_call_id?: string;
  status?: string;
}

export interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  ref_msg?: RefMessage;
  text_item?: TextItem;
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
  tool_call_start_item?: ToolCallStartItem;
  tool_call_result_item?: ToolCallResultItem;
}

/** proto: WeixinMessage。 */
export interface WeixinMessage {
  seq?: number;
  /** 线上 uint64，解析成字符串。 */
  message_id?: string;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  delete_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
  run_id?: string;
}

export interface GetUpdatesResp {
  ret?: number;
  /** 业务错误码；-14 表示会话令牌失效。 */
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  /** 服务端建议的下一次长轮询超时，毫秒。 */
  longpolling_timeout_ms?: number;
}

export interface SendMessageReq {
  msg?: WeixinMessage;
}

export interface SendMessageResp {
  message_id?: string;
  ret?: number;
  errmsg?: string;
}

/** `sendtyping` 的 status。 */
export const TypingStatus = {
  TYPING: 1,
  CANCEL: 2,
} as const;

export interface SendTypingReq {
  ilink_user_id?: string;
  typing_ticket?: string;
  status?: number;
}

export interface GetConfigResp {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

/** 二维码登录的状态机取值。 */
export type QrStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect';

export interface QrStatusResp {
  status?: QrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  /** `scaned_but_redirect` 时要切换到的轮询主机。 */
  redirect_host?: string;
}
