/**
 * Keus mesh diagnostics - provisioning helpers.
 *
 * Keeps the Controller.addOfflineDevice hook down to a small branch: everything
 * about interpreting a 0x66 result lives here.
 */

import {KzProvisionResult, KzDeviceNwkInfo} from './tstype';

/** 0x66 devType values. */
export const KZ_DEV_TYPE = {
    END_DEVICE: 0,
    ROUTER: 1,
};

/**
 * MAC capability bitmap (Zigbee spec). The firmware consults RCVR_ON_IDLE to
 * decide the child relation it records for an end device, and starts the ED
 * aging timer at provisioning - so getting these wrong for a sleepy device
 * means it ages out before it is ever powered on.
 */
export const MAC_CAPABILITY = {
    ALT_PAN_COORDINATOR: 0x01,
    FFD: 0x02,
    MAINS_POWERED: 0x04,
    RCVR_ON_IDLE: 0x08,
    SECURITY: 0x40,
    ALLOCATE_ADDRESS: 0x80,
};

/** Mains router: FFD, mains powered, receiver always on, address allocated. */
export const MAC_CAPS_ROUTER =
    MAC_CAPABILITY.FFD | MAC_CAPABILITY.MAINS_POWERED |
    MAC_CAPABILITY.RCVR_ON_IDLE | MAC_CAPABILITY.ALLOCATE_ADDRESS;   // 0x8E

/** Sleepy end device: RFD, battery, receiver off when idle. */
export const MAC_CAPS_SLEEPY_END_DEVICE = MAC_CAPABILITY.ALLOCATE_ADDRESS;   // 0x80

/** Non-sleepy end device: battery/RFD but listening, so it can be reached directly. */
export const MAC_CAPS_RX_ON_END_DEVICE =
    MAC_CAPABILITY.RCVR_ON_IDLE | MAC_CAPABILITY.ALLOCATE_ADDRESS;   // 0x88

/**
 * Sensible MAC capabilities when a caller only knows router vs end device.
 * Callers that know better (a mains-powered but RFD device, say) should pass
 * their own bitmap rather than relying on this.
 */
export function defaultMacCapabilities(devType: number): number {
    return devType === KZ_DEV_TYPE.END_DEVICE ? MAC_CAPS_SLEEPY_END_DEVICE : MAC_CAPS_ROUTER;
}

/**
 * 0x66's devType is the LOGICAL Zigbee type. It is not the endpoint's simple
 * descriptor device id - that stays caller-supplied, because offline
 * provisioning skips the interview and never reads a descriptor.
 */
export function deviceTypeForKzDevType(devType: number): 'Router' | 'EndDevice' {
    return devType === KZ_DEV_TYPE.END_DEVICE ? 'EndDevice' : 'Router';
}

/**
 * The join bundle the host delivers to the device out of band.
 *
 * Every value here is live at the moment of provisioning, which is why a device
 * must be re-provisioned after any NWK key rotation.
 */
export function buildDeviceNwkInfo(ieeeAddr: string, result: KzProvisionResult): KzDeviceNwkInfo {
    return {
        deviceId: ieeeAddr,
        shortaddr: result.nwkAddr,
        linkKey: result.apsLinkKeyEcho,
        panId: result.panId,
        channel: result.channel,
        extPanId: result.extPanId,
        nwkKey: result.nwkKey,
        nwkKeySeqNum: result.nwkKeySeqNum,
        nwkFrameCounter: result.nwkFrameCounter,
        tcIeeeAddr: result.tcIeeeAddr,
        coordShortAddr: result.coordShortAddr,
        tclkAttribute: result.tclkAttribute,
    };
}

/**
 * The most common cause of a non-zero status is asking for a different explicit
 * short address on a re-provision, so the message says how to actually do that.
 */
export function provisionFailureMessage(ieeeAddr: string, status: number): string {
    return `Coordinator rejected provisioning of '${ieeeAddr}' (status ${status}). ` +
        `Re-provisioning keeps the existing short address - purge the device first to move it.`;
}
