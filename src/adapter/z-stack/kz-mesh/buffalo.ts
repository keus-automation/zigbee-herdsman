/**
 * Keus mesh diagnostics - wire decoders.
 *
 * Free functions taking a Buffalo so BuffaloZnp only needs three dispatch lines
 * rather than carrying the implementations. See ./README.md for the hook points.
 */

import {Buffalo} from '../../../buffalo';
import {KzNeighbor, KzRoutingEntry, KzSourceRoute} from './tstype';

/**
 * Sentinels meaning "not tracked". Decoded to null so callers can never mistake
 * a missing measurement for a real (and in the RSSI case, alarmingly bad) one.
 */
const RSSI_UNTRACKED = 0x7F;
const AGE_UNKNOWN = 0xFF;
const LAST_HEARD_UNKNOWN = 0xFFFF;
const CORR_UNTRACKED = 0;
const EXT_ADDR_UNKNOWN = '0xffffffffffffffff';

/**
 * Route status names, including the two the stock table does not have.
 *
 * REPAIR(4) and LINK_FAIL(5) are reachable on Keus mesh firmware. LINK_FAIL is
 * latched by the MTO mitigation and only cleared by the next MTORR, so a
 * destination sitting in it is unreachable until then.
 */
export const KZ_ROUTE_STATUS: Record<number, string> = {
    0: 'ACTIVE',
    1: 'DISCOVERY_UNDERWAY',
    2: 'DISCOVERY_FAILED',
    3: 'INACTIVE',
    4: 'REPAIR',
    5: 'LINK_FAIL',
};

/** The two statuses upstream's routingTableStatusLookup is missing. */
export const KZ_EXTRA_ROUTE_STATUS: Record<number, string> = {
    4: KZ_ROUTE_STATUS[4],
    5: KZ_ROUTE_STATUS[5],
};

/** MT_UTIL 0x68 - count x 21-byte neighbour record. */
export function readListKzNeighbor(buffalo: Buffalo, length: number): KzNeighbor[] {
    const value: KzNeighbor[] = [];

    for (let i = 0; i < length; i++) {
        const extAddr = buffalo.readIeeeAddr();
        const shortAddr = buffalo.readUInt16();
        const devType = buffalo.readUInt8();
        const relation = buffalo.readUInt8();
        const rxLqi = buffalo.readUInt8();
        const txCost = buffalo.readUInt8();
        const txFailureLo = buffalo.readUInt8();
        const age = buffalo.readUInt8();
        const lastRssi = buffalo.readInt8();
        const lastCorr = buffalo.readUInt8();
        const avgRssi = buffalo.readInt8();
        const lastHeardSec = buffalo.readUInt16();

        value.push({
            extAddr: extAddr.toLowerCase() === EXT_ADDR_UNKNOWN ? null : extAddr,
            shortAddr,
            devType,
            relation,
            rxLqi,
            txCost,
            txFailureLo,
            age: age === AGE_UNKNOWN ? null : age,
            lastRssi: lastRssi === RSSI_UNTRACKED ? null : lastRssi,
            lastCorr: lastCorr === CORR_UNTRACKED ? null : lastCorr,
            avgRssi: avgRssi === RSSI_UNTRACKED ? null : avgRssi,
            lastHeardSec: lastHeardSec === LAST_HEARD_UNKNOWN ? null : lastHeardSec,
        });
    }

    return value;
}

/** MT_UTIL 0x69 - count x {dst(2) nextHop(2) expiryTime(1) status(1) options(1)}. */
export function readListKzRtg(buffalo: Buffalo, length: number): KzRoutingEntry[] {
    const value: KzRoutingEntry[] = [];

    for (let i = 0; i < length; i++) {
        const dst = buffalo.readUInt16();
        const nextHop = buffalo.readUInt16();
        const expiryTime = buffalo.readUInt8();
        const status = buffalo.readUInt8();
        const options = buffalo.readUInt8();

        value.push({
            dst,
            nextHop,
            expiryTime,
            status,
            statusName: KZ_ROUTE_STATUS[status],
            options,
        });
    }

    return value;
}

/**
 * MT_UTIL 0x6A - count x {dst(2) expiryTime(1) relayCount(1) relayList(relayCount x 2)}.
 * Variable size per record, so the relay list has to be read inline.
 */
export function readListKzSrcRtg(buffalo: Buffalo, length: number): KzSourceRoute[] {
    const value: KzSourceRoute[] = [];

    for (let i = 0; i < length; i++) {
        const dst = buffalo.readUInt16();
        const expiryTime = buffalo.readUInt8();
        const relayCount = buffalo.readUInt8();
        const relayList: number[] = [];

        for (let relay = 0; relay < relayCount; relay++) {
            relayList.push(buffalo.readUInt16());
        }

        value.push({dst, expiryTime, relayCount, relayList});
    }

    return value;
}

/**
 * The single hook BuffaloZnp needs: returns undefined for anything that is not
 * a kz-mesh type, so the caller falls through to its own handling.
 */
export function readKzListType(
    type: string, buffalo: Buffalo, length: number
): KzNeighbor[] | KzRoutingEntry[] | KzSourceRoute[] | undefined {
    switch (type) {
        case 'LIST_KZ_NEIGHBOR':
            return readListKzNeighbor(buffalo, length);
        case 'LIST_KZ_RTG':
            return readListKzRtg(buffalo, length);
        case 'LIST_KZ_SRC_RTG':
            return readListKzSrcRtg(buffalo, length);
        default:
            return undefined;
    }
}
