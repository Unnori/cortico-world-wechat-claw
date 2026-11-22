const ITEM_FIELDS = [
  'type', 'text_item', 'voice_item', 'image_item', 'file_item', 'video_item',
  'ref_msg', 'tool_call_start_item', 'tool_call_result_item',
] as const;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function valueShape(value: unknown): string {
  return Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
}

function structure(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const fields = record(value);
  const present = keys.filter(key => Object.hasOwn(fields, key));
  return {
    shape: valueShape(value),
    fields: Object.fromEntries(present.map(key => [key, valueShape(fields[key])])),
    otherFieldCount: Object.keys(fields).length - present.length,
  };
}

export function inboundWireType(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^\d{1,9}$/.test(value)) return Number(value);
  return undefined;
}

/** Allowlist structure only. Never emit untrusted field names, values, identifiers or media refs. */
export function inboundItemShape(value: unknown): Record<string, unknown> {
  const item = record(value);
  return {
    ...structure(value, ITEM_FIELDS),
    type: inboundWireType(item.type) ?? valueShape(item.type),
    textItem: structure(item.text_item, ['text']),
    voiceItem: structure(item.voice_item, ['text', 'media', 'playtime', 'encode_type']),
  };
}

export function inboundMessageShape(value: unknown): Record<string, unknown> {
  const message = record(value);
  return {
    ...structure(value, ['from_user_id', 'message_type', 'message_state', 'item_list', 'create_time_ms']),
    type: inboundWireType(message.message_type) ?? valueShape(message.message_type),
    itemCount: Array.isArray(message.item_list) ? message.item_list.length : undefined,
    items: Array.isArray(message.item_list) ? message.item_list.slice(0, 4).map(inboundItemShape) : undefined,
  };
}
