import "regenerator-runtime/runtime";
import {ZpiObject} from '../src/adapter/z-stack/znp';
import {Frame as UnpiFrame} from '../src/adapter/z-stack/unpi';
import {Type, Subsystem} from '../src/adapter/z-stack/unpi/constants';

/**
 * Wire-level checks for the Keus mesh diagnostic commands (host_integration.md,
 * Plan 06a). These assert byte offsets and sentinel decoding, which is where a
 * silent misparse would otherwise produce plausible-looking wrong numbers.
 */

const srsp = (commandID: number, data: Buffer): ZpiObject =>
    ZpiObject.fromUnpiFrame(new UnpiFrame(Type.SRSP, Subsystem.UTIL, commandID, data));

describe('Keus mesh diagnostics', () => {
    describe('0x67 kzGetDiagCounters', () => {
        it('decodes all 22 counters in struct order', () => {
            // 22 uint16 LE, value == index so any offset slip is obvious
            const data = Buffer.alloc(44);
            for (let i = 0; i < 22; i++) {
                data.writeUInt16LE(i, i * 2);
            }

            const payload = srsp(103, data).payload;

            expect(payload.afInDropNoMemHuge).toBe(0);
            expect(payload.afInDropNoMemResp).toBe(1);
            expect(payload.bcastTableFullDrop).toBe(2);
            expect(payload.nwkReplayDrop).toBe(3);
            expect(payload.afGroupFallbackNoEp).toBe(4);
            expect(payload.annceRxTotal).toBe(5);
            expect(payload.annceAssocPurge).toBe(6);
            expect(payload.srcRtFail).toBe(13);
            expect(payload.srcRtFlush).toBe(14);
            expect(payload.nextHopInvalidate).toBe(15);
            // the four trailing watermarks
            expect(payload.heapFreeMin).toBe(18);
            expect(payload.heapFragMin).toBe(19);
            expect(payload.nwkDataBufHigh).toBe(20);
            expect(payload.neighborCntHigh).toBe(21);
        });
    });

    describe('0x68 kzGetNeighborTable', () => {
        const neighborRecord = (overrides: Partial<{
            extAddr: Buffer; shortAddr: number; devType: number; relation: number; rxLqi: number;
            txCost: number; txFailureLo: number; age: number; lastRssi: number; lastCorr: number;
            avgRssi: number; lastHeardSec: number;
        }> = {}): Buffer => {
            const record = Buffer.alloc(21);
            (overrides.extAddr ?? Buffer.from('bb8e812200004b12', 'hex')).copy(record, 0);
            record.writeUInt16LE(overrides.shortAddr ?? 0x1A2B, 8);
            record.writeUInt8(overrides.devType ?? 1, 10);
            record.writeUInt8(overrides.relation ?? 3, 11);
            record.writeUInt8(overrides.rxLqi ?? 240, 12);
            record.writeUInt8(overrides.txCost ?? 1, 13);
            record.writeUInt8(overrides.txFailureLo ?? 7, 14);
            record.writeUInt8(overrides.age ?? 2, 15);
            record.writeInt8(overrides.lastRssi ?? -48, 16);
            record.writeUInt8(overrides.lastCorr ?? 61, 17);
            record.writeInt8(overrides.avgRssi ?? -50, 18);
            record.writeUInt16LE(overrides.lastHeardSec ?? 12, 19);
            return record;
        };

        const response = (records: Buffer[], total: number): Buffer => Buffer.concat([
            Buffer.from([0x00]),                                     // status
            Buffer.from([total & 0xFF, (total >> 8) & 0xFF]),        // total LE
            Buffer.from([records.length]),                           // count
            ...records,
        ]);

        it('decodes a 21-byte record at the documented offsets', () => {
            const payload = srsp(104, response([neighborRecord()], 1)).payload;

            expect(payload.status).toBe(0);
            expect(payload.total).toBe(1);
            expect(payload.count).toBe(1);

            const neighbor = payload.neighbors[0];
            // IEEE is little-endian on the wire, rendered big-endian
            expect(neighbor.extAddr).toBe('0x124b000022818ebb');
            expect(neighbor.shortAddr).toBe(0x1A2B);
            expect(neighbor.devType).toBe(1);
            expect(neighbor.relation).toBe(3);
            expect(neighbor.rxLqi).toBe(240);
            expect(neighbor.txCost).toBe(1);
            expect(neighbor.txFailureLo).toBe(7);
            expect(neighbor.age).toBe(2);
            expect(neighbor.lastRssi).toBe(-48);
            expect(neighbor.lastCorr).toBe(61);
            expect(neighbor.avgRssi).toBe(-50);
            expect(neighbor.lastHeardSec).toBe(12);
        });

        it('decodes signed RSSI rather than wrapping it to a large positive', () => {
            const payload = srsp(104, response([neighborRecord({lastRssi: -84, avgRssi: -90})], 1)).payload;
            expect(payload.neighbors[0].lastRssi).toBe(-84);
            expect(payload.neighbors[0].avgRssi).toBe(-90);
        });

        it('maps every sentinel to null so untracked never reads as a measurement', () => {
            const record = neighborRecord({
                extAddr: Buffer.from('ffffffffffffffff', 'hex'),
                age: 0xFF,
                lastRssi: 0x7F,
                lastCorr: 0,
                avgRssi: 0x7F,
                lastHeardSec: 0xFFFF,
            });

            const neighbor = srsp(104, response([record], 1)).payload.neighbors[0];

            expect(neighbor.extAddr).toBeNull();
            expect(neighbor.age).toBeNull();
            expect(neighbor.lastRssi).toBeNull();
            expect(neighbor.lastCorr).toBeNull();
            expect(neighbor.avgRssi).toBeNull();
            expect(neighbor.lastHeardSec).toBeNull();
            // rxLqi / txCost are populated for every entry and must survive
            expect(neighbor.rxLqi).toBe(240);
            expect(neighbor.txCost).toBe(1);
        });

        it('decodes multiple records without drifting', () => {
            const records = [
                neighborRecord({shortAddr: 0x1111, avgRssi: -40}),
                neighborRecord({shortAddr: 0x2222, avgRssi: -60}),
                neighborRecord({shortAddr: 0x3333, avgRssi: -80}),
            ];

            const neighbors = srsp(104, response(records, 3)).payload.neighbors;

            expect(neighbors.map((n: {shortAddr: number}) => n.shortAddr)).toEqual([0x1111, 0x2222, 0x3333]);
            expect(neighbors.map((n: {avgRssi: number}) => n.avgRssi)).toEqual([-40, -60, -80]);
        });
    });

    describe('0x69 kzRtgDump', () => {
        it('decodes route entries and names the Keus LINK_FAIL status', () => {
            const entry = (dst: number, nextHop: number, expiry: number, status: number): Buffer => {
                const buffer = Buffer.alloc(7);
                buffer.writeUInt16LE(dst, 0);
                buffer.writeUInt16LE(nextHop, 2);
                buffer.writeUInt8(expiry, 4);
                buffer.writeUInt8(status, 5);
                buffer.writeUInt8(1, 6);
                return buffer;
            };

            const data = Buffer.concat([
                Buffer.from([0x00, 0xFF, 0x03]),   // status, nextIdx (done), count
                entry(0x1A2B, 0x1A2B, 60, 0),
                entry(0x44F0, 0x1A2B, 30, 5),
                entry(0x7C10, 0x44F0, 0, 4),
            ]);

            const payload = srsp(105, data).payload;

            expect(payload.nextIdx).toBe(0xFF);
            expect(payload.entries[0].statusName).toBe('ACTIVE');
            // 4 and 5 are the Keus additions; the stock lookup stopped at 3
            expect(payload.entries[1].status).toBe(5);
            expect(payload.entries[1].statusName).toBe('LINK_FAIL');
            expect(payload.entries[2].statusName).toBe('REPAIR');
        });
    });

    describe('0x6A kzSrcRtgDump', () => {
        it('decodes variable-length relay lists', () => {
            const data = Buffer.concat([
                Buffer.from([0x00, 0xFF, 0xFF, 0x03]),               // status, nextIdx 0xFFFF, count
                Buffer.from([0x2B, 0x1A, 60, 0]),                    // dst 0x1A2B, expiry, 0 relays
                Buffer.from([0xF0, 0x44, 58, 1, 0x2B, 0x1A]),        // 1 relay
                Buffer.from([0x10, 0x7C, 30, 2, 0x2B, 0x1A, 0xF0, 0x44]), // 2 relays
            ]);

            const payload = srsp(106, data).payload;

            expect(payload.nextIdx).toBe(0xFFFF);
            expect(payload.count).toBe(3);
            expect(payload.entries[0].relayList).toEqual([]);
            expect(payload.entries[1].relayList).toEqual([0x1A2B]);
            expect(payload.entries[2].relayList).toEqual([0x1A2B, 0x44F0]);
            expect(payload.entries[2].dst).toBe(0x7C10);
        });
    });

    describe('0x66 kzDeviceProvision', () => {
        it('decodes the 62-byte join bundle at the documented offsets', () => {
            const data = Buffer.alloc(62);
            data.writeUInt8(0, 0);                                    // status
            data.writeUInt16LE(0x1A2B, 1);                            // assigned short addr
            data.writeUInt8(7, 3);                                    // nwk key seq num
            Buffer.alloc(16, 0xAB).copy(data, 4);                     // nwk key
            data.writeUInt32LE(123456, 20);                           // frame counter
            data.writeUInt8(15, 24);                                  // channel
            data.writeUInt16LE(0x1A63, 25);                           // pan id
            Buffer.from('0102030405060708', 'hex').copy(data, 27);    // ext pan id
            Buffer.from('bb8e812200004b12', 'hex').copy(data, 35);    // tc ieee
            data.writeUInt16LE(0x0000, 43);                           // coord short addr
            data.writeUInt8(0xFF, 45);                                // tclk attribute
            Buffer.alloc(16, 0xCD).copy(data, 46);                    // aps link key echo

            const payload = srsp(102, data).payload;

            expect(payload.status).toBe(0);
            expect(payload.nwkAddr).toBe(0x1A2B);
            expect(payload.nwkKeySeqNum).toBe(7);
            expect(Buffer.from(payload.nwkKey).equals(Buffer.alloc(16, 0xAB))).toBe(true);
            expect(payload.nwkFrameCounter).toBe(123456);
            expect(payload.channel).toBe(15);
            expect(payload.panId).toBe(0x1A63);
            expect(payload.coordShortAddr).toBe(0);
            expect(payload.tclkAttribute).toBe(0xFF);
            expect(Buffer.from(payload.apsLinkKeyEcho).equals(Buffer.alloc(16, 0xCD))).toBe(true);
        });
    });

    describe('0x65 kzDeviceRemove', () => {
        it('is a distinct command from the non-destructive assocRemove', () => {
            const purge = srsp(101, Buffer.from([0x00]));
            expect(purge.command).toBe('kzDeviceRemove');

            const assocRemove = srsp(99, Buffer.from([0x00]));
            expect(assocRemove.command).toBe('assocRemove');
        });
    });
});
