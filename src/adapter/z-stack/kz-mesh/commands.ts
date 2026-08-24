/**
 * Keus mesh diagnostics - command implementations.
 *
 * All the paging, probing and provisioning logic, as free functions taking the
 * Znp instance and the adapter's queue. ZStackAdapter is then just thin
 * delegation, which keeps the upstream diff small.
 */

import {Znp} from '../znp';
import {Queue} from '../../../utils';
import {Constants as UnpiConstants} from '../unpi';
import Debug from 'debug';
import {
    KzDiagCounters,
    KzNeighbor,
    KzNeighborTable,
    KzRoutingEntry,
    KzSourceRoute,
    KzProvisionRequest,
    KzProvisionResult,
} from './tstype';
import {
    KZ_NEIGHBOR_MAX_PER_PAGE,
    KZ_MAX_PAGES,
    KZ_RTG_DONE,
    KZ_SRC_RTG_DONE,
    KZ_AUTO_SHORT_ADDR,
    KZ_PROBE_TIMEOUT_MS,
} from './definition';

const debug = Debug('zigbee-herdsman:adapter:zStack:kzMesh');
const Subsystem = UnpiConstants.Subsystem;

/** Accept any status - the payload carries the real outcome. */
const ANY_STATUS: number[] = [];

/**
 * One empty SREQ is enough to know whether the firmware has the extensions.
 * Probing beats thresholding on version.revision: this is our own firmware and
 * the revision string is not a reliable contract for which commands were built in.
 */
export async function probeKzMeshSupport(znp: Znp, timeoutMs = KZ_PROBE_TIMEOUT_MS): Promise<boolean> {
    try {
        // Short timeout on purpose: firmware without these commands may simply
        // not answer, and the default 6s SREQ timeout would be added to every boot.
        await znp.request(Subsystem.UTIL, 'kzGetDiagCounters', {}, undefined, timeoutMs);
        debug('Keus mesh diagnostics supported');
        return true;
    } catch (error) {
        debug(`Keus mesh diagnostics not supported: ${error}`);
        return false;
    }
}

export async function getDiagCounters(znp: Znp, queue: Queue): Promise<KzDiagCounters> {
    return queue.execute<KzDiagCounters>(async () => {
        const result = await znp.request(Subsystem.UTIL, 'kzGetDiagCounters', {});
        return result.payload as unknown as KzDiagCounters;
    });
}

/**
 * Pages 0x68 until the whole table has been read. The page cap is a backstop
 * against a firmware bug reporting a total it never reaches - better a flagged
 * partial table than a wedged queue.
 */
export async function getNeighborTable(znp: Znp, queue: Queue): Promise<KzNeighborTable> {
    return queue.execute<KzNeighborTable>(async () => {
        const neighbors: KzNeighbor[] = [];
        let startIdx = 0;
        let total = 0;
        let partial = false;

        for (let page = 0; page < KZ_MAX_PAGES; page++) {
            const result = await znp.request(
                Subsystem.UTIL, 'kzGetNeighborTable', {startIdx, maxCnt: KZ_NEIGHBOR_MAX_PER_PAGE}
            );

            total = result.payload.total;
            neighbors.push(...(result.payload.neighbors as unknown as KzNeighbor[]));

            // A zero-length page with more claimed would loop forever.
            if (result.payload.count === 0) {
                partial = neighbors.length < total;
                break;
            }

            startIdx += result.payload.count;

            if (startIdx >= total) {
                break;
            }

            if (page === KZ_MAX_PAGES - 1) {
                partial = true;
                debug('getNeighborTable: hit page cap with %d/%d entries', neighbors.length, total);
            }
        }

        return {total, neighbors, partial};
    });
}

export async function getRoutingTable(znp: Znp, queue: Queue): Promise<KzRoutingEntry[]> {
    return queue.execute<KzRoutingEntry[]>(async () => {
        const entries: KzRoutingEntry[] = [];
        let startIdx = 0;

        for (let page = 0; page < KZ_MAX_PAGES; page++) {
            const result = await znp.request(Subsystem.UTIL, 'kzRtgDump', {startIdx});
            entries.push(...(result.payload.entries as unknown as KzRoutingEntry[]));

            if (result.payload.nextIdx === KZ_RTG_DONE || result.payload.count === 0) {
                break;
            }

            startIdx = result.payload.nextIdx;
        }

        return entries;
    });
}

export async function getSourceRoutes(znp: Znp, queue: Queue): Promise<KzSourceRoute[]> {
    return queue.execute<KzSourceRoute[]>(async () => {
        const entries: KzSourceRoute[] = [];
        let startIdx = 0;

        for (let page = 0; page < KZ_MAX_PAGES; page++) {
            const result = await znp.request(Subsystem.UTIL, 'kzSrcRtgDump', {startIdx});
            entries.push(...(result.payload.entries as unknown as KzSourceRoute[]));

            if (result.payload.nextIdx === KZ_SRC_RTG_DONE || result.payload.count === 0) {
                break;
            }

            startIdx = result.payload.nextIdx;
        }

        return entries;
    });
}

/**
 * 0x66. A non-zero status is a normal outcome (e.g. re-provisioning with a
 * different explicit short address), so it is returned rather than thrown - only
 * transport failures throw.
 */
export async function provisionDevice(
    znp: Znp, queue: Queue, request: KzProvisionRequest
): Promise<KzProvisionResult> {
    return queue.execute<KzProvisionResult>(async () => {
        const result = await znp.request(
            Subsystem.UTIL,
            'kzDeviceProvision',
            {
                ieeeadr: request.ieeeAddr,
                devType: request.devType,
                macCapabilities: request.macCapabilities,
                reqShortAddr: request.reqShortAddr === undefined ? KZ_AUTO_SHORT_ADDR : request.reqShortAddr,
                // all-zero = this network's global default TCLK
                apsLinkKey: request.apsLinkKey ? request.apsLinkKey : Buffer.alloc(16, 0),
            },
            undefined,
            undefined,
            ANY_STATUS
        );

        const payload = result.payload;

        return {
            status: payload.status,
            success: payload.status === 0,
            nwkAddr: payload.nwkAddr,
            nwkKeySeqNum: payload.nwkKeySeqNum,
            nwkKey: Array.from(payload.nwkKey as Buffer),
            nwkFrameCounter: payload.nwkFrameCounter,
            channel: payload.channel,
            panId: payload.panId,
            extPanId: payload.extPanId as string,
            tcIeeeAddr: payload.tcIeeeAddr as string,
            coordShortAddr: payload.coordShortAddr,
            tclkAttribute: payload.tclkAttribute,
            apsLinkKeyEcho: Array.from(payload.apsLinkKeyEcho as Buffer),
        };
    });
}

/**
 * 0x65 - full purge. Not restorable by assocAdd; never wire this into a
 * send-recovery path, that is what the non-destructive 0x63 assocRemove is for.
 */
export async function purgeDevice(znp: Znp, queue: Queue, ieeeAddr: string): Promise<number> {
    return queue.execute<number>(async () => {
        const result = await znp.request(
            Subsystem.UTIL, 'kzDeviceRemove', {ieeeadr: ieeeAddr}, undefined, undefined, ANY_STATUS
        );
        return result.payload.status;
    });
}
