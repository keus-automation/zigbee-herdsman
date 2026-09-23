/**
 * Keus mesh diagnostics - MT command definitions.
 *
 * Exported as an array to be spread into the UTIL subsystem, so the upstream
 * definition table only gains a single `...KzUtilCommands` line.
 *
 * Wire contract: host_integration.md (Plan 06a).
 */

import ParameterType from '../znp/parameterType';
import {MtCmd} from '../znp/tstype';
import {Type as CommandType} from '../unpi/constants';

export const KzCommandIds = {
    /** 0x65 - FULL device purge. Not restorable by assocAdd. */
    kzDeviceRemove: 101,
    /** 0x66 - register a device and return the join bundle. */
    kzDeviceProvision: 102,
    /** 0x67 - append-only block of free-running uint16 counters (23 as of mesh-10). */
    kzGetDiagCounters: 103,
    /** 0x68 - paged neighbour table. */
    kzGetNeighborTable: 104,
    /** 0x69 - paged routing table. */
    kzRtgDump: 105,
    /** 0x6A - paged source-route table. */
    kzSrcRtgDump: 106,
};

/** maxCnt is capped at 10 by the firmware (0 or >10 is treated as 10). */
export const KZ_NEIGHBOR_MAX_PER_PAGE = 10;

/** Backstops against a firmware bug reporting a total it never reaches. */
export const KZ_MAX_PAGES = 100;

export const KZ_RTG_DONE = 0xFF;
export const KZ_SRC_RTG_DONE = 0xFFFF;

/** 0xFFFE asks the coordinator to allocate a short address. */
export const KZ_AUTO_SHORT_ADDR = 0xFFFE;

/**
 * Capability probe timeout. Firmware without these commands may not answer at
 * all, and the default 6s SREQ timeout would then be charged to every boot.
 */
export const KZ_PROBE_TIMEOUT_MS = 1000;

/**
 * 0x67 counter names in wire order (Plan 06a A3). Append-only: add new names at
 * the END. Block 1 = kz_znp_stats (5), block 2 = kzDiagNwk_t (18).
 */
export const KZ_DIAG_COUNTER_FIELDS: readonly string[] = [
    // Block 1 - kz_znp_stats
    'afInDropNoMemHuge', 'afInDropNoMemResp', 'bcastTableFullDrop', 'nwkReplayDrop', 'afGroupFallbackNoEp',
    // Block 2 - kz_diag_nwk
    'annceRxTotal', 'annceAssocPurge', 'annceRtgPurge', 'annceNbrPurge',
    'parentAnnceTx', 'parentAnnceRspRx', 'parentAnnceChildRemoved', 'parentAnnceClaimSent',
    'srcRtFail', 'srcRtFlush', 'nextHopInvalidate', 'zedCleanupByRelay', 'indirectExpired',
    'heapFreeMin', 'heapFragMin', 'nwkDataBufHigh', 'neighborCntHigh',
    // mesh-10 N3 - always 0 on a ZNP, meaningful on routers/ZEDs via 0x27
    'nwkKeyNullLatch',
];

export const KzUtilCommands: MtCmd[] = [
    {
        /**
         * FULL device purge - assoc + addr-mgr user + security-manager APS key +
         * TCLK NV entry + bindings + routing + neighbour + source-route entries.
         * Not restorable by assocAdd; the device must re-provision (0x66) or
         * re-join. This is what forceRemoveDevice should call.
         */
        name: 'kzDeviceRemove',
        ID: KzCommandIds.kzDeviceRemove,
        type: CommandType.SREQ,
        request: [
            {name: 'ieeeadr', parameterType: ParameterType.IEEEADDR},
        ],
        response: [
            {name: 'status', parameterType: ParameterType.UINT8},
        ],
    },
    {
        /**
         * Register a device directly on the coordinator and return the join
         * bundle for out-of-band delivery.
         *
         * reqShortAddr 0xFFFE = let the coordinator allocate.
         * apsLinkKey all-zero = use this network's global default TCLK.
         */
        name: 'kzDeviceProvision',
        ID: KzCommandIds.kzDeviceProvision,
        type: CommandType.SREQ,
        request: [
            {name: 'ieeeadr', parameterType: ParameterType.IEEEADDR},
            {name: 'devType', parameterType: ParameterType.UINT8},
            {name: 'macCapabilities', parameterType: ParameterType.UINT8},
            {name: 'reqShortAddr', parameterType: ParameterType.UINT16},
            {name: 'apsLinkKey', parameterType: ParameterType.BUFFER16},
        ],
        response: [
            {name: 'status', parameterType: ParameterType.UINT8},
            {name: 'nwkAddr', parameterType: ParameterType.UINT16},
            {name: 'nwkKeySeqNum', parameterType: ParameterType.UINT8},
            {name: 'nwkKey', parameterType: ParameterType.BUFFER16},
            {name: 'nwkFrameCounter', parameterType: ParameterType.UINT32},
            {name: 'channel', parameterType: ParameterType.UINT8},
            {name: 'panId', parameterType: ParameterType.UINT16},
            {name: 'extPanId', parameterType: ParameterType.IEEEADDR},
            {name: 'tcIeeeAddr', parameterType: ParameterType.IEEEADDR},
            {name: 'coordShortAddr', parameterType: ParameterType.UINT16},
            {name: 'tclkAttribute', parameterType: ParameterType.UINT8},
            {name: 'apsLinkKeyEcho', parameterType: ParameterType.BUFFER16},
        ],
    },
    {
        /**
         * Append-only block of free-running, wrapping uint16 counters - 23 as of
         * mesh-10 N3. Only the delta between successive reads is meaningful; the
         * heap/buffer/neighbour gauges are min/max-ever watermarks and must be
         * read raw, never diffed.
         *
         * Decoded as "all remaining uint16s" and named by KZ_DIAG_COUNTER_FIELDS
         * rather than as a fixed field list, because the firmware contract is
         * that new counters are APPENDED. A fixed list would throw on an older
         * coordinator (too short) and silently ignore a newer one (too long) -
         * and a throw here fails the capability probe, turning every mesh
         * diagnostic off for that gateway.
         */
        name: 'kzGetDiagCounters',
        ID: KzCommandIds.kzGetDiagCounters,
        type: CommandType.SREQ,
        request: [],
        response: [
            {name: 'counters', parameterType: ParameterType.LIST_KZ_DIAG_COUNTERS},
        ],
    },
    {
        /**
         * Paged neighbour table. Page with startIdx += count until
         * startIdx >= total.
         */
        name: 'kzGetNeighborTable',
        ID: KzCommandIds.kzGetNeighborTable,
        type: CommandType.SREQ,
        request: [
            {name: 'startIdx', parameterType: ParameterType.UINT16},
            {name: 'maxCnt', parameterType: ParameterType.UINT8},
        ],
        response: [
            {name: 'status', parameterType: ParameterType.UINT8},
            {name: 'total', parameterType: ParameterType.UINT16},
            {name: 'count', parameterType: ParameterType.UINT8},
            {name: 'neighbors', parameterType: ParameterType.LIST_KZ_NEIGHBOR},
        ],
    },
    {
        /** Paged routing table. Resume with nextIdx until it reads 0xFF. */
        name: 'kzRtgDump',
        ID: KzCommandIds.kzRtgDump,
        type: CommandType.SREQ,
        request: [
            {name: 'startIdx', parameterType: ParameterType.UINT8},
        ],
        response: [
            {name: 'status', parameterType: ParameterType.UINT8},
            {name: 'nextIdx', parameterType: ParameterType.UINT8},
            {name: 'count', parameterType: ParameterType.UINT8},
            {name: 'entries', parameterType: ParameterType.LIST_KZ_RTG},
        ],
    },
    {
        /**
         * Paged source-route table. Records are variable length. Resume with
         * nextIdx until it reads 0xFFFF.
         */
        name: 'kzSrcRtgDump',
        ID: KzCommandIds.kzSrcRtgDump,
        type: CommandType.SREQ,
        request: [
            {name: 'startIdx', parameterType: ParameterType.UINT16},
        ],
        response: [
            {name: 'status', parameterType: ParameterType.UINT8},
            {name: 'nextIdx', parameterType: ParameterType.UINT16},
            {name: 'count', parameterType: ParameterType.UINT8},
            {name: 'entries', parameterType: ParameterType.LIST_KZ_SRC_RTG},
        ],
    },
];
