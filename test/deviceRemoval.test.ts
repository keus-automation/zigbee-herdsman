import "regenerator-runtime/runtime";
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import Database from '../src/controller/database';
import {Entity, Device} from '../src/controller/model';
import Group from '../src/controller/model/group';

/**
 * Removal has to be terminal.
 *
 * Database.update() defaults to forceInsert, so anything that saved a device
 * after its row had been deleted RE-CREATED it. That is how a device which left
 * mid-interview came back from the dead: the interview's finally-block saved it
 * after onDeviceLeave had removed it, leaving the in-memory map and the database
 * out of step and a later re-join creating a second row for one address.
 */

const dbInstKey = 'test-removal';

const makeDevice = (ieeeAddr: string, nwkAddr: number): Device => Device.create(
    'Router', ieeeAddr, nwkAddr, 43690, undefined, undefined, undefined, true,
    [{ID: 1, profileID: 1, deviceID: 1, inputClusters: [], outputClusters: []}],
    dbInstKey
);

describe('device removal is terminal', () => {
    let dbFile: string;
    let database: Database;

    beforeEach(() => {
        dbFile = path.join(os.tmpdir(), `removal-${Date.now()}-${Math.random()}.db`);
        database = Database.open(dbFile);
        Entity.injectDatabase(dbInstKey, database);
        Device.initDevicesList(dbInstKey);
        Group.initGroupsList(dbInstKey);
    });

    afterEach(() => {
        try { fs.unlinkSync(dbFile); } catch { /* ignore */ }
    });

    it('marks the device removed and drops the row', async () => {
        const device = makeDevice('0x01', 1);
        expect(device.removed).toBe(false);
        expect(database.has(device.ID)).toBe(true);

        await device.removeFromDatabase();

        expect(device.removed).toBe(true);
        expect(database.has(device.ID)).toBe(false);
        expect(Device.byIeeeAddr(dbInstKey, '0x01')).toBeUndefined();
    });

    it('does NOT resurrect the row when something saves after removal', async () => {
        const device = makeDevice('0x02', 2);
        const id = device.ID;

        await device.removeFromDatabase();
        expect(database.has(id)).toBe(false);

        // this is exactly what the interview's finally-block used to do
        device.save();

        expect(database.has(id)).toBe(false);
    });

    it('keeps the in-memory map and the database in step after a late save', async () => {
        const device = makeDevice('0x03', 3);
        await device.removeFromDatabase();
        device.save();

        // both views must agree that the device is gone
        expect(Device.byIeeeAddr(dbInstKey, '0x03')).toBeUndefined();
        expect(database.getEntries(['Router']).find((e) => e.ieeeAddr === '0x03')).toBeUndefined();
    });

    it('lets a re-join create exactly one row, not a duplicate', async () => {
        const first = makeDevice('0x04', 4);

        await first.removeFromDatabase();
        first.save();                      // the late save that used to leave a ghost

        // Device.create() throws on a duplicate address, so this only succeeds
        // because the late save did not leave a ghost behind.
        const rejoined = makeDevice('0x04', 4);

        const rows = database.getEntries(['Router']).filter((e) => e.ieeeAddr === '0x04');
        expect(rows.length).toBe(1);
        // the freed id being reused is fine - what matters is that there is one row
        expect(rows[0].id).toBe(rejoined.ID);
    });

    it('still saves normally before removal', () => {
        const device = makeDevice('0x05', 5);
        device.networkAddress = 55;
        device.save();

        const row = database.getEntries(['Router']).find((e) => e.ieeeAddr === '0x05');
        expect(row.nwkAddr).toBe(55);
    });
});
