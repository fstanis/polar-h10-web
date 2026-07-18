/**
 * GATT service and characteristic UUIDs used by the H10.
 * @packageDocumentation
 */

/** Standard Heart Rate Service. */
export const HR_SERVICE = '0000180d-0000-1000-8000-00805f9b34fb';
export const HR_MEASUREMENT_CHAR = '00002a37-0000-1000-8000-00805f9b34fb';

/** Battery Service. */
export const BATTERY_SERVICE = '0000180f-0000-1000-8000-00805f9b34fb';
export const BATTERY_LEVEL_CHAR = '00002a19-0000-1000-8000-00805f9b34fb';

/** Device Information Service. The serial-number characteristic (`0x2A25`) is Web Bluetooth-blocklisted. */
export const DIS_SERVICE = '0000180a-0000-1000-8000-00805f9b34fb';
export const DIS_MODEL_NUMBER_CHAR = '00002a24-0000-1000-8000-00805f9b34fb';
export const DIS_MANUFACTURER_NAME_CHAR = '00002a29-0000-1000-8000-00805f9b34fb';
export const DIS_HARDWARE_REVISION_CHAR = '00002a27-0000-1000-8000-00805f9b34fb';
export const DIS_FIRMWARE_REVISION_CHAR = '00002a26-0000-1000-8000-00805f9b34fb';
export const DIS_SOFTWARE_REVISION_CHAR = '00002a28-0000-1000-8000-00805f9b34fb';
export const DIS_SYSTEM_ID_CHAR = '00002a23-0000-1000-8000-00805f9b34fb';

/** Polar Measurement Data (PMD) custom service. */
export const PMD_SERVICE = 'fb005c80-02e7-f387-1cad-8acd2d8df0c8';
export const PMD_CONTROL_POINT_CHAR = 'fb005c81-02e7-f387-1cad-8acd2d8df0c8';
export const PMD_DATA_CHAR = 'fb005c82-02e7-f387-1cad-8acd2d8df0c8';

/** Polar Simple File Transfer (PSFTP) service; the "MTU" characteristic is its bidirectional request/response pipe. */
export const PSFTP_SERVICE = '0000feee-0000-1000-8000-00805f9b34fb';
export const PSFTP_MTU_CHAR = 'fb005c51-02e7-f387-1cad-8acd2d8df0c8';
