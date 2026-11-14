import {ZclFrame} from '../zcl';

enum Events {
    networkAddress = "networkAddress",
    deviceJoined = "deviceJoined",
    zclData = "zclData",
    rawData = "rawData",
    disconnected = "disconnected",
    deviceAnnounce = "deviceAnnounce",
    deviceLeave = "deviceLeave",
    /**
     * The coordinator is up but unusable. Emitted only for states we can
     * positively identify - see AdapterFailurePayload.reason - never as a guess.
     */
    adapterFailure = "adapterFailure"
}

/**
 * What the adapter observed going wrong with the coordinator.
 *
 * All three mean the coordinator itself is at fault, not the mesh or a device:
 *
 * - `ping-failed`   : it stopped answering SYS ping.
 * - `timeout`       : an MT request got no SRSP at all.
 * - `invalid-param` : it rejected an MT request with INVALID_PARAM, which for a
 *                     well-formed request means its endpoints are not
 *                     registered - the state a chip comes back in after
 *                     restarting behind our back.
 *
 * A ping and an SRSP are both answered locally with no radio involved, so their
 * absence points at the chip rather than anything beyond it.
 */
interface AdapterFailurePayload {
    /** Which failure was observed - the host uses this to decide how to recover. */
    reason: 'ping-failed' | 'timeout' | 'invalid-param';
    /** The underlying error, for logs. */
    detail: string;
    /** How many failures were seen before asking. */
    failures: number;
}

interface DeviceJoinedPayload {
    networkAddress: number;
    ieeeAddr: string;
}

interface DeviceAnnouncePayload {
    networkAddress: number;
    ieeeAddr: string;
}

interface NetworkAddressPayload {
    networkAddress: number;
    ieeeAddr: string;
}

interface DeviceLeavePayload {
    networkAddress: number;
    ieeeAddr: string;
    rejoin?: boolean;
}

interface ZclDataPayload {
    address: number | string;
    frame: ZclFrame;
    endpoint: number;
    linkquality: number;
    groupID: number;
    wasBroadcast: boolean;
    destinationEndpoint: number;
}

interface RawDataPayload {
    clusterID: number;
    address: number | string;
    data: Buffer;
    endpoint: number;
    linkquality: number;
    groupID: number;
    wasBroadcast: boolean;
    destinationEndpoint: number;
}

export {
    Events, DeviceJoinedPayload, ZclDataPayload, DeviceAnnouncePayload, NetworkAddressPayload, DeviceLeavePayload,
    RawDataPayload, AdapterFailurePayload,
};