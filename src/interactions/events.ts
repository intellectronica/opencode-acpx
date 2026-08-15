type UnknownRecord = Record<string, unknown>;

export interface PermissionAskedEvent {
  type: "permission.asked";
  properties: {
    id: string;
    sessionID: string;
    permission: string;
    patterns: string[];
    always: string[];
    metadata: UnknownRecord;
    tool?: {
      messageID: string;
      callID: string;
    };
  };
}

export interface PermissionRepliedEvent {
  type: "permission.replied";
  properties: {
    sessionID: string;
    requestID: string;
    reply: "once" | "always" | "reject";
  };
}

export interface SessionDeletedEvent {
  type: "session.deleted";
  properties: {
    sessionID?: string;
    info?: {
      id: string;
    };
  };
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function propertiesOf(value: unknown, type: string): UnknownRecord | undefined {
  if (!isRecord(value) || value.type !== type || !isRecord(value.properties))
    return undefined;
  return value.properties;
}

export function isPermissionAskedEvent(
  value: unknown,
): value is PermissionAskedEvent {
  const properties = propertiesOf(value, "permission.asked");
  if (
    properties === undefined ||
    typeof properties.id !== "string" ||
    typeof properties.sessionID !== "string" ||
    typeof properties.permission !== "string" ||
    !isStringArray(properties.patterns) ||
    !isStringArray(properties.always) ||
    !isRecord(properties.metadata)
  ) {
    return false;
  }
  if (properties.tool === undefined) return true;
  return (
    isRecord(properties.tool) &&
    typeof properties.tool.messageID === "string" &&
    typeof properties.tool.callID === "string"
  );
}

export function isPermissionRepliedEvent(
  value: unknown,
): value is PermissionRepliedEvent {
  const properties = propertiesOf(value, "permission.replied");
  return (
    properties !== undefined &&
    typeof properties.sessionID === "string" &&
    typeof properties.requestID === "string" &&
    (properties.reply === "once" ||
      properties.reply === "always" ||
      properties.reply === "reject")
  );
}

export function isSessionDeletedEvent(
  value: unknown,
): value is SessionDeletedEvent {
  const properties = propertiesOf(value, "session.deleted");
  if (properties === undefined) return false;
  if (typeof properties.sessionID === "string") return true;
  return isRecord(properties.info) && typeof properties.info.id === "string";
}

export function sessionDeletedId(event: SessionDeletedEvent): string {
  if (event.properties.sessionID !== undefined)
    return event.properties.sessionID;
  if (event.properties.info !== undefined) return event.properties.info.id;
  throw new Error("Invalid session deletion event");
}
