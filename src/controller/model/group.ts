import {DatabaseEntry, KeyValue} from '../tstype';
import Entity from './entity';
import ZclTransactionSequenceNumber from '../helpers/zclTransactionSequenceNumber';
import * as Zcl from '../../zcl';
import Endpoint from './endpoint';
import Device from './device';
import assert from 'assert';
import Debug from "debug";

const debug = {
    info: Debug('zigbee-herdsman:controller:group'),
    error: Debug('zigbee-herdsman:controller:group'),
};

export interface Options {
    manufacturerCode?: number;
    direction?: Zcl.Direction;
    srcEndpoint?: number;
    reservedBits?: number;
    transactionSequenceNumber?: number;
}

class Group extends Entity {
    private databaseID: number;
    public readonly groupID: number;
    private readonly _members: Set<Endpoint>;
    get members(): Endpoint[] {return Array.from(this._members);}
    // Can be used by applications to store data.
    public readonly meta: KeyValue;
    private _dbInstKey: string;

    // This lookup contains all groups that are queried from the database, this is to ensure that always
    // the same instance is returned.
    private static groups: {[dbInstKey: string]: {[groupID: number]: Group}} = null;

    public static initGroupsList(dbInstKey: string) {
        if (!Group.groups) {
            Group.groups = {};
        }
    }

    private constructor(databaseID: number, groupID: number, members: Set<Endpoint>, meta: KeyValue, dbInstKey: string) {
        super();
        this.databaseID = databaseID;
        this.groupID = groupID;
        this._members = members;
        this.meta = meta;
        this._dbInstKey = dbInstKey;
    }

    /*
     * CRUD
     */

    private static fromDatabaseEntry(dbInstKey: string, entry: DatabaseEntry): Group {
        const members = new Set<Endpoint>();
        for (const member of entry.members) {
            const device = Device.byIeeeAddr(dbInstKey, member.deviceIeeeAddr);
            if (device) {
                const endpoint = device.getEndpoint(member.endpointID);
                members.add(endpoint);
            }
        }

        return new Group(entry.id, entry.groupID, members, entry.meta, dbInstKey);
    }

    private toDatabaseRecord(): DatabaseEntry {
        const members = Array.from(this.members).map((member) => {
            return {deviceIeeeAddr: member.getDevice().ieeeAddr, endpointID: member.ID};
        });

        return {id: this.databaseID, type: 'Group', groupID: this.groupID, members, meta: this.meta};
    }

    private static loadFromDatabaseIfNecessary(dbInstKey: string): void {
        if (!Group.groups[dbInstKey]) {
            Group.groups[dbInstKey] = {};
            const entries = Entity.databases[dbInstKey].getEntries(['Group']);
            for (const entry of entries) {
                const group = Group.fromDatabaseEntry(dbInstKey, entry);
                Group.groups[dbInstKey][group.groupID] = group;
            }
        }
    }

    public static byGroupID(dbInstKey: string, groupID: number): Group {
        Group.loadFromDatabaseIfNecessary(dbInstKey);
        return Group.groups[dbInstKey][groupID];
    }

    public static all(dbInstKey: string): Group[] {
        Group.loadFromDatabaseIfNecessary(dbInstKey);
        return Object.values(Group.groups[dbInstKey]);
    }

    public static create(dbInstKey: string, groupID: number): Group {
        assert(typeof groupID === 'number', 'GroupID must be a number');
        Group.loadFromDatabaseIfNecessary(dbInstKey);
        if (Group.groups[groupID]) {
            throw new Error(`Group with groupID '${groupID}' already exists`);
        }

        const databaseID = Entity.databases[dbInstKey].newID();
        const group = new Group(databaseID, groupID, new Set(), {}, dbInstKey);
        Entity.databases[dbInstKey].insert(group.toDatabaseRecord());

        Group.groups[dbInstKey][group.groupID] = group;
        return group;
    }

    public async removeFromNetwork(): Promise<void> {
        for (const endpoint of this._members) {
            await endpoint.removeFromGroup(this);
        }

        this.removeFromDatabase();
    }

    public removeFromDatabase(): void {
        Group.loadFromDatabaseIfNecessary(this._dbInstKey);

        if (Entity.databases[this._dbInstKey].has(this.databaseID)) {
            Entity.databases[this._dbInstKey].remove(this.databaseID);
        }

        delete Group.groups[this.groupID];
    }

    public save(): void {
        Entity.databases[this._dbInstKey].update(this.toDatabaseRecord());
    }

    public addMember(endpoint: Endpoint): void {
        this._members.add(endpoint);
        this.save();
    }

    public removeMember(endpoint: Endpoint): void {
        this._members.delete(endpoint);
        this.save();
    }

    public hasMember(endpoint: Endpoint): boolean {
        return this._members.has(endpoint);
    }

    /*
     * Zigbee functions
     */

    public async write(
        clusterKey: number | string, attributes: KeyValue, options?: Options
    ): Promise<void> {
        options = this.getOptionsWithDefaults(options, Zcl.Direction.CLIENT_TO_SERVER);
        const cluster = Zcl.Utils.getCluster(clusterKey);
        const payload: {attrId: number; dataType: number; attrData: number| string | boolean}[] = [];
        for (const [nameOrID, value] of Object.entries(attributes)) {
            if (cluster.hasAttribute(nameOrID)) {
                const attribute = cluster.getAttribute(nameOrID);
                payload.push({attrId: attribute.ID, attrData: value, dataType: attribute.type});
            } else if (!isNaN(Number(nameOrID))){
                payload.push({attrId: Number(nameOrID), attrData: value.value, dataType: value.type});
            } else {
                throw new Error(`Unknown attribute '${nameOrID}', specify either an existing attribute or a number`);
            }
        }

        const log = `Write ${this.groupID} ${cluster.name}(${JSON.stringify(attributes)}, ${JSON.stringify(options)})`;
        debug.info(log);

        try {
            const frame = Zcl.ZclFrame.create(
                Zcl.FrameType.GLOBAL, options.direction, true,
                options.manufacturerCode, options.transactionSequenceNumber ?? ZclTransactionSequenceNumber.next(),
                'write', cluster.ID, payload, options.reservedBits
            );
            await Entity.adapters[this._dbInstKey].sendZclFrameToGroup(this.groupID, frame, options.srcEndpoint);
        } catch (error) {
            error.message = `${log} failed (${error.message})`;
            debug.error(error.message);
            throw error;
        }
    }

    public async read(
        clusterKey: number | string, attributes: string[] | number [], options?: Options
    ): Promise<void> {
        options = this.getOptionsWithDefaults(options, Zcl.Direction.CLIENT_TO_SERVER);
        const cluster = Zcl.Utils.getCluster(clusterKey);
        const payload: {attrId: number}[] = [];
        for (const attribute of attributes) {
            payload.push({attrId: typeof attribute === 'number' ? attribute : cluster.getAttribute(attribute).ID});
        }

        const frame = Zcl.ZclFrame.create(
            Zcl.FrameType.GLOBAL, options.direction, true,
            options.manufacturerCode, options.transactionSequenceNumber ?? ZclTransactionSequenceNumber.next(), 'read',
            cluster.ID, payload, options.reservedBits
        );

        const log = `Read ${this.groupID} ${cluster.name}(${JSON.stringify(attributes)}, ${JSON.stringify(options)})`;
        debug.info(log);

        try {
            await Entity.adapters[this._dbInstKey].sendZclFrameToGroup(this.groupID, frame, options.srcEndpoint);
        } catch (error) {
            error.message = `${log} failed (${error.message})`;
            debug.error(error.message);
            throw error;
        }
    }

    public async command(
        clusterKey: number | string, commandKey: number | string, payload: KeyValue, options?: Options
    ): Promise<void> {
        options = this.getOptionsWithDefaults(options, Zcl.Direction.CLIENT_TO_SERVER);
        const cluster = Zcl.Utils.getCluster(clusterKey);
        const command = cluster.getCommand(commandKey);

        const log = `Command ${this.groupID} ${cluster.name}.${command.name}(${JSON.stringify(payload)})`;
        debug.info(log);

        try {
            const frame = Zcl.ZclFrame.create(
                Zcl.FrameType.SPECIFIC, options.direction, true, options.manufacturerCode,
                options.transactionSequenceNumber || ZclTransactionSequenceNumber.next(),
                command.ID, cluster.ID, payload, options.reservedBits
            );
            await Entity.adapters[this._dbInstKey].sendZclFrameToGroup(this.groupID, frame, options.srcEndpoint);
        } catch (error) {
            error.message = `${log} failed (${error.message})`;
            debug.error(error.message);
            throw error;
        }
    }

    public static async commandStandalone(
        clusterKey: number | string, commandKey: number | string, payload: KeyValue, groupId: number,
        dbInstKey: string, inputOptions?: Options
    ): Promise<void> {
        let options: Options = {
            direction: Zcl.Direction.CLIENT_TO_SERVER,
            srcEndpoint: null,
            reservedBits: 0,
            manufacturerCode: null,
            transactionSequenceNumber: null,
            ...inputOptions
        };

        const cluster = Zcl.Utils.getCluster(clusterKey);
        const command = cluster.getCommand(commandKey);

        const log = `Command ${groupId} ${cluster.name}.${command.name}(${JSON.stringify(payload)})`;
        debug.info(log);

        try {
            const frame = Zcl.ZclFrame.create(
                Zcl.FrameType.SPECIFIC, options.direction, true, options.manufacturerCode,
                options.transactionSequenceNumber || ZclTransactionSequenceNumber.next(),
                command.ID, cluster.ID, payload, options.reservedBits
            );
            await Entity.adapters[dbInstKey].sendZclFrameToGroup(groupId, frame, options.srcEndpoint);
        } catch (error) {
            const message = `${log} failed (${error})`;
            debug.error(message);
            throw Error(message);
        }
    }

    private getOptionsWithDefaults(
        options: Options, direction: Zcl.Direction
    ): Options {
        const providedOptions = options || {};
        return {
            direction,
            srcEndpoint: null,
            reservedBits: 0,
            manufacturerCode: null,
            transactionSequenceNumber: null,
            ...providedOptions
        };
    }
}

export default Group;