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
    /** 0x67 - 22 free-running uint16 counters. */
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
         * 22 free-running, wrapping uint16 counters. Only the delta between
         * successive reads is meaningful; the four trailing gauges are
         * min/max-ever watermarks and must be read raw, never diffed.
         */
        name: 'kzGetDiagCounters',
        ID: KzCommandIds.kzGetDiagCounters,
        type: CommandType.SREQ,
        request: [],
        response: [
            // Block 1 - kz_znp_stats
            {name: 'afInDropNoMemHuge', parameterType: ParameterType.UINT16},
            {name: 'afInDropNoMemResp', parameterType: ParameterType.UINT16},
            {name: 'bcastTableFullDrop', parameterType: ParameterType.UINT16},
            {name: 'nwkReplayDrop', parameterType: ParameterType.UINT16},
            {name: 'afGroupFallbackNoEp', parameterType: ParameterType.UINT16},
            // Block 2 - kz_diag_nwk
            {name: 'annceRxTotal', parameterType: ParameterType.UINT16},
            {name: 'annceAssocPurge', parameterType: ParameterType.UINT16},
            {name: 'annceRtgPurge', parameterType: ParameterType.UINT16},
            {name: 'annceNbrPurge', parameterType: ParameterType.UINT16},
            {name: 'parentAnnceTx', parameterType: ParameterType.UINT16},
            {name: 'parentAnnceRspRx', parameterType: ParameterType.UINT16},
            {name: 'parentAnnceChildRemoved', parameterType: ParameterType.UINT16},
            {name: 'parentAnnceClaimSent', parameterType: ParameterType.UINT16},
            {name: 'srcRtFail', parameterType: ParameterType.UINT16},
            {name: 'srcRtFlush', parameterType: ParameterType.UINT16},
            {name: 'nextHopInvalidate', parameterType: ParameterType.UINT16},
            {name: 'zedCleanupByRelay', parameterType: ParameterType.UINT16},
            {name: 'indirectExpired', parameterType: ParameterType.UINT16},
            {name: 'heapFreeMin', parameterType: ParameterType.UINT16},
            {name: 'heapFragMin', parameterType: ParameterType.UINT16},
            {name: 'nwkDataBufHigh', parameterType: ParameterType.UINT16},
            {name: 'neighborCntHigh', parameterType: ParameterType.UINT16},
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
