/**
 * `PbPFtpError` id → name mapping, for surfacing PSFTP failures.
 * @packageDocumentation
 */

/** PFTP protocol error ids (from `pftp_error.proto`), plus comms-layer synthetic ids. */
export const PFTP_ERROR_NAMES: Readonly<Record<number, string>> = {
  0: 'OPERATION_SUCCEEDED',
  1: 'REBOOTING',
  2: 'TRY_AGAIN',
  100: 'UNIDENTIFIED_HOST_ERROR',
  101: 'INVALID_COMMAND',
  102: 'INVALID_PARAMETER',
  103: 'NO_SUCH_FILE_OR_DIRECTORY',
  104: 'DIRECTORY_EXISTS',
  105: 'FILE_EXISTS',
  106: 'OPERATION_NOT_PERMITTED',
  107: 'NO_SUCH_USER',
  108: 'TIMEOUT',
  200: 'UNIDENTIFIED_DEVICE_ERROR',
  201: 'NOT_IMPLEMENTED',
  202: 'SYSTEM_BUSY',
  203: 'INVALID_CONTENT',
  204: 'CHECKSUM_FAILURE',
  205: 'DISK_FULL',
  206: 'PREREQUISITE_NOT_MET',
  207: 'INSUFFICIENT_BUFFER',
  208: 'WAIT_FOR_IDLING',
  209: 'BATTERY_TOO_LOW',
  // 300–399 reserved for the communication layer:
  303: 'AIR_PACKET_LOST',
};

/** Human-readable name for a PFTP error id (`"UNKNOWN"` if not in the enum). */
export function pftpErrorName(id: number): string {
  return PFTP_ERROR_NAMES[id] ?? 'UNKNOWN';
}
