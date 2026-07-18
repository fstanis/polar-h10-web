/**
 * Typed error hierarchy for `polar-h10-web`. Every error thrown by the library
 * is a {@link PolarError} carrying a stable `code` discriminator.
 *
 * @packageDocumentation
 */

/** Discriminator for {@link PolarError} subclasses. */
export type PolarErrorCode =
  | 'unsupported-browser'
  | 'chooser-cancelled'
  | 'disconnected'
  | 'control-point'
  | 'pftp'
  | 'protocol'
  | 'timeout'
  | 'invalid-state'
  | 'not-supported';

/** Base class for all errors raised by the library. */
export class PolarError extends Error {
  /** Machine-readable discriminator, stable across releases. */
  readonly code: PolarErrorCode;

  constructor(code: PolarErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = new.target.name;
    // Restore prototype chain for transpile targets that break `instanceof`.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Web Bluetooth (or a required sub-feature) is unavailable in this environment,
 * e.g. Safari/Firefox or a non-secure context.
 */
export class UnsupportedBrowserError extends PolarError {
  constructor(message = 'Web Bluetooth is not available in this browser') {
    super('unsupported-browser', message);
  }
}

/** The user dismissed the browser device chooser (`requestDevice()` rejected with `NotFoundError`). */
export class ChooserCancelledError extends PolarError {
  constructor(message = 'Device chooser was cancelled') {
    super('chooser-cancelled', message);
  }
}

/**
 * The GATT link dropped. Raised from pending operations and thrown into active
 * stream iterators when the strap goes out of range or is taken off (the H10
 * drops the link ~45 s after removal).
 */
export class DisconnectedError extends PolarError {
  constructor(message = 'Device disconnected') {
    super('disconnected', message);
  }
}

export class TimeoutError extends PolarError {
  constructor(message = 'Operation timed out') {
    super('timeout', message);
  }
}

/**
 * An operation is not valid in the device's or handle's current state, e.g.
 * starting a stream that is already active.
 */
export class InvalidStateError extends PolarError {
  constructor(message: string) {
    super('invalid-state', message);
  }
}

/** A requested capability or parameter is outside what the H10 supports. */
export class NotSupportedError extends PolarError {
  constructor(message: string) {
    super('not-supported', message);
  }
}

/** The device rejected a PMD control-point command with a numeric status code. */
export class ControlPointError extends PolarError {
  /** Raw PMD control-point status code (see `PmdControlPointStatus`). */
  readonly status: number;
  /** Human-readable status name, or `"UNKNOWN_ERROR"` for codes outside the enum. */
  readonly statusName: string;

  constructor(status: number, statusName: string, message?: string) {
    super('control-point', message ?? `PMD control point rejected the command: ${statusName} (${status})`);
    this.status = status;
    this.statusName = statusName;
  }
}

/** The device returned a non-zero PFTP error id for a file/query operation. */
export class PftpError extends PolarError {
  /** Numeric `PbPFtpError` id (e.g. 103 = NO_SUCH_FILE_OR_DIRECTORY). */
  readonly errorId: number;
  /** Human-readable error name, or `"UNKNOWN"` for ids outside the enum. */
  readonly errorName: string;

  constructor(errorId: number, errorName: string, message?: string) {
    super('pftp', message ?? `PFTP operation failed: ${errorName} (${errorId})`);
    this.errorId = errorId;
    this.errorName = errorName;
  }
}

/**
 * A protocol invariant was violated while decoding data from the device
 * (malformed frame, sequence gap, unexpected length, unsupported frame type).
 */
export class ProtocolError extends PolarError {
  constructor(message: string) {
    super('protocol', message);
  }
}
