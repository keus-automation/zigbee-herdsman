import "regenerator-runtime/runtime";
import * as os from 'os';
import * as path from 'path';
// Default import, like database.ts: spying on a namespace import would patch a copy of the module.
import fs from 'fs';
import Database from '../src/controller/database';
import {Controller} from '../src/controller';
import {Entity, Device} from '../src/controller/model';
import Group from '../src/controller/model/group';

/**
 * The hourly databaseSave() must write the database file once.
 *
 * Database.write() rewrites the whole file synchronously. databaseSave() used to
 * call save() per device and group, and each save wrote the file, so N entities
 * meant N full rewrites. On a large network that froze the event loop for
 * several seconds every hour, long enough for mini gateways to drop their link.
 */

const dbInstKey = 'test-database-save';

const makeDevice = (ieeeAddr: string, nwkAddr: number): Device => Device.create(
    'Router', ieeeAddr, nwkAddr, 43690, undefined, undefined, undefined, true,
    [{ID: 1, profileID: 1, deviceID: 1, inputClusters: [], outputClusters: []}],
    dbInstKey
);

// databaseSave() is private and only reads dbInstKey and database, so run it without a full controller.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const databaseSave = (database: Database): void => (Controller.prototype as any).databaseSave.call({dbInstKey, database});

const rowsOnDisk = (file: string) => Database.open(file);

describe('hourly database save', () => {
    let dbFile: string;
    let database: Database;
    let writeSpy: jest.SpyInstance;

    beforeEach(() => {
        dbFile = path.join(os.tmpdir(), `database-save-${Date.now()}-${Math.random()}.db`);
        database = Database.open(dbFile);
        Entity.injectDatabase(dbInstKey, database);
        Device.initDevicesList(dbInstKey);
        Group.initGroupsList(dbInstKey);
        jest.spyOn(console, 'log').mockImplementation(() => undefined);
        writeSpy = jest.spyOn(fs, 'writeFileSync');
    });

    afterEach(() => {
        jest.restoreAllMocks();
        try { fs.unlinkSync(dbFile); } catch { /* ignore */ }
    });

    it('writes the file once, however many devices and groups there are', () => {
        const devices = Array.from({length: 20}, (_, i) => makeDevice(`0x${(i + 1).toString(16)}`, i + 1));
        const groups = Array.from({length: 5}, (_, i) => Group.create(dbInstKey, i + 1));
        // change everything in memory only, so the file is stale until databaseSave runs
        devices.forEach((d, i) => { d.networkAddress = 1000 + i; });
        groups.forEach((g, i) => { g.meta.mark = i; });
        writeSpy.mockClear();

        databaseSave(database);

        expect(writeSpy).toHaveBeenCalledTimes(1);
        const onDisk = rowsOnDisk(dbFile);
        for (const [i, d] of devices.entries()) {
            expect(onDisk.getEntries(['Router']).find((e) => e.ieeeAddr === d.ieeeAddr).nwkAddr).toBe(1000 + i);
        }
        for (const [i, g] of groups.entries()) {
            expect(onDisk.getEntries(['Group']).find((e) => e.groupID === g.groupID).meta.mark).toBe(i);
        }
    });

    it('does not bring back a removed device', async () => {
        const kept = makeDevice('0x21', 21);
        const removed = makeDevice('0x22', 22);
        await removed.removeFromDatabase();

        databaseSave(database);

        const ieeeAddrs = rowsOnDisk(dbFile).getEntries(['Router']).map((e) => e.ieeeAddr);
        expect(ieeeAddrs).toContain(kept.ieeeAddr);
        expect(ieeeAddrs).not.toContain(removed.ieeeAddr);
    });

    it('save() still writes immediately by default', () => {
        const device = makeDevice('0x31', 31);
        const group = Group.create(dbInstKey, 31);
        device.networkAddress = 3131;
        group.meta.mark = 31;
        writeSpy.mockClear();

        device.save();
        group.save();

        expect(writeSpy).toHaveBeenCalledTimes(2);
        const onDisk = rowsOnDisk(dbFile);
        expect(onDisk.getEntries(['Router']).find((e) => e.ieeeAddr === '0x31').nwkAddr).toBe(3131);
        expect(onDisk.getEntries(['Group']).find((e) => e.groupID === 31).meta.mark).toBe(31);
    });

    it('save(false) changes memory only, until write()', () => {
        const device = makeDevice('0x41', 41);
        device.networkAddress = 4141;
        writeSpy.mockClear();

        device.save(false);

        expect(writeSpy).not.toHaveBeenCalled();
        expect(database.getEntries(['Router']).find((e) => e.ieeeAddr === '0x41').nwkAddr).toBe(4141);
        expect(rowsOnDisk(dbFile).getEntries(['Router']).find((e) => e.ieeeAddr === '0x41').nwkAddr).toBe(41);

        database.write();

        expect(rowsOnDisk(dbFile).getEntries(['Router']).find((e) => e.ieeeAddr === '0x41').nwkAddr).toBe(4141);
    });
});
