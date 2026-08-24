/**
 * Keus mesh diagnostics - types.
 *
 * Part of the self-contained kz-mesh module. Everything Keus-specific about the
 * mesh diagnostic commands lives under this directory so that rebasing onto
 * upstream zigbee-herdsman only has to reconcile the handful of hook points
 * listed in ./README.md, not a diff spread across the adapter.
 *
 * Wire contract: host_integration.md (Plan 06a).
 */

export interface KzMeshCapabilities {
    supportsKzMesh: boolean;
    znpVersion: string;
    revision: string;
}

export interface KzDiagCounters {
    // Block 1 - kz_znp_stats
    afInDropNoMemHuge: number;
    afInDropNoMemResp: number;
    bcastTableFullDrop: number;
    nwkReplayDrop: number;
    afGroupFallbackNoEp: number;
    // Block 2 - kz_diag_nwk
    annceRxTotal: number;
    annceAssocPurge: number;
    annceRtgPurge: number;
    annceNbrPurge: number;
    parentAnnceTx: number;
    parentAnnceRspRx: number;
    parentAnnceChildRemoved: number;
    parentAnnceClaimSent: number;
    srcRtFail: number;
    srcRtFlush: number;
    nextHopInvalidate: number;
    zedCleanupByRelay: number;
    indirectExpired: number;
    // watermarks - min/max ever, report raw and never diff
    heapFreeMin: number;
    heapFragMin: number;
    nwkDataBufHigh: number;
    neighborCntHigh: number;
}

/**
 * The 21-byte neighbour record, shared with the router-side Keus ZCL 0x28.
 *
 * Null on any of lastRssi/avgRssi/lastCorr means the link is outside the
 * firmware's 32-entry RF stats cache: there is NO measurement. It is not a weak
 * link and must never be rendered or aggregated as one. rxLqi, txCost and
 * txFailureLo are populated for every entry regardless.
 */
export interface KzNeighbor {
    extAddr: string | null;
    shortAddr: number;
    devType: number;
    relation: number;
    rxLqi: number;
    txCost: number;
    txFailureLo: number;
    age: number | null;
    lastRssi: number | null;
    lastCorr: number | null;
    avgRssi: number | null;
    lastHeardSec: number | null;
}

export interface KzNeighborTable {
    total: number;
    neighbors: KzNeighbor[];
    /** true when paging stopped early (page cap or a mid-walk error) */
    partial: boolean;
}

export interface KzRoutingEntry {
    dst: number;
    nextHop: number;
    expiryTime: number;
    status: number;
    statusName: string | undefined;
    options: number;
}

export interface KzSourceRoute {
    dst: number;
    expiryTime: number;
    relayCount: number;
    relayList: number[];
}

export interface KzProvisionRequest {
    ieeeAddr: string;
    /** 0 = ZED, 1 = router */
    devType: number;
    macCapabilities: number;
    /** 0xFFFE (default) lets the coordinator allocate */
    reqShortAddr?: number;
    /** omitted or all-zero = this network's global default TCLK */
    apsLinkKey?: Buffer;
}

export interface KzProvisionResult {
    status: number;
    success: boolean;
    nwkAddr: number;
    nwkKeySeqNum: number;
    nwkKey: number[];
    nwkFrameCounter: number;
    channel: number;
    panId: number;
    extPanId: string;
    tcIeeeAddr: string;
    coordShortAddr: number;
    tclkAttribute: number;
    apsLinkKeyEcho: number[];
}

/** The join bundle as the host hands it to a device out of band. */
export interface KzDeviceNwkInfo {
    deviceId: string;
    shortaddr: number;
    linkKey: number[];
    panId: number;
    channel: number;
    extPanId: string;
    nwkKey: number[];
    nwkKeySeqNum: number;
    nwkFrameCounter: number;
    tcIeeeAddr: string;
    coordShortAddr: number;
    tclkAttribute: number;
}
