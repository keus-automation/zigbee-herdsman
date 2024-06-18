import events from 'events';
import Database from './database';
import { TsType as AdapterTsType, Adapter, Events as AdapterEvents } from '../adapter';
import { Entity, Device } from './model';
import { ZclFrameConverter } from './helpers';
import * as Events from './events';
import { KeyValue, DeviceType, GreenPowerEvents, GreenPowerDeviceJoinedPayload } from './tstype';
import Debug from "debug";
import fs from 'fs';
import ZclTransactionSequenceNumber from './helpers/zclTransactionSequenceNumber';
import {
    Utils as ZclUtils,
    FrameControl,
    ZclFrame,
    FrameType as ZclFrameType,
    Direction as ZclDirection
} from '../zcl';
import Touchlink from './touchlink';
import GreenPower from './greenPower';
import {BackupUtils} from "../utils";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import mixin from 'mixin-deep';
import Group, { Options as BroadcastOptions } from './model/group';
import {LoggerStub} from "./logger-stub";

interface Options {
    network: AdapterTsType.NetworkOptions;
    serialPort: AdapterTsType.SerialPortOptions;
    databasePath: string;
    databaseBackupPath: string;
    backupPath: string;
    adapter: AdapterTsType.AdapterOptions;
    /**
     * This lambda can be used by an application to explictly reject or accept an incoming device.
     * When false is returned zigbee-herdsman will not start the interview process and immidiately
     * try to remove the device from the network.
     */
    acceptJoiningDeviceHandler: (ieeeAddr: string) => Promise<boolean>;
    instanceUniqueKey?: string;
}

const DefaultOptions: Options = {
    network: {
        networkKeyDistribute: false,
        networkKey: [0x01, 0x03, 0x05, 0x07, 0x09, 0x0B, 0x0D, 0x0F, 0x00, 0x02, 0x04, 0x06, 0x08, 0x0A, 0x0C, 0x0D],
        panID: 0x1a62,
        extendedPanID: [0xDD, 0xDD, 0xDD, 0xDD, 0xDD, 0xDD, 0xDD, 0xDD],
        channelList: [11],
    },
    serialPort: {},
    databasePath: null,
    databaseBackupPath: null,
    backupPath: null,
    adapter: {disableLED: false},
    acceptJoiningDeviceHandler: null,
    instanceUniqueKey: 'ZC'
};

const debug = {
    error: Debug('zigbee-herdsman:controller:error'),
    log: Debug('zigbee-herdsman:controller:log'),
};

/**
 * @noInheritDoc
 */
class Controller extends events.EventEmitter {
    private options: Options;
    private database: Database;
    private adapter: Adapter;
    private greenPower: GreenPower;
    // eslint-disable-next-line
    private permitJoinNetworkClosedTimer: any;
    // eslint-disable-next-line
    private permitJoinTimeoutTimer: any;
    private permitJoinTimeout: number;
    // eslint-disable-next-line
    private backupTimer: any;
    // eslint-disable-next-line
    private databaseSaveTimer: any;
    private touchlink: Touchlink;
    private stopping: boolean;
    private networkParametersCached: AdapterTsType.NetworkParameters;
    private logger?: LoggerStub;
    private dbInstKey?: string;

    public getDbInstKey():string {
        return this.dbInstKey;
    }

    /**
     * Create a controller
     *
     * To auto detect the port provide `null` for `options.serialPort.path`
     */
    public constructor(options: Options, logger?: LoggerStub) {
        super();
        this.stopping = false;
        this.options = mixin(JSON.parse(JSON.stringify(DefaultOptions)), options);
        this.logger = logger;
        this.dbInstKey = this.options.instanceUniqueKey;

        Device.initDevicesList(this.dbInstKey);
        Group.initGroupsList(this.dbInstKey);

        // Validate options
        for (const channel of this.options.network.channelList) {
            if (channel < 11 || channel > 26) {
                throw new Error(`'${channel}' is an invalid channel, use a channel between 11 - 26.`);
            }
        }

        if (!Array.isArray(this.options.network.networkKey) || this.options.network.networkKey.length !== 16) {
            throw new Error(`Network key must be 16 digits long, got ${this.options.network.networkKey.length}.`);
        }

        if (!Array.isArray(this.options.network.extendedPanID) || this.options.network.extendedPanID.length !== 8) {
            throw new Error(`ExtendedPanID must be 8 digits long, got ${this.options.network.extendedPanID.length}.`);
        }

        if (this.options.network.panID >= 0xFFFF || this.options.network.panID < 0) {
            throw new Error(`PanID must have a value of 0x0000 (0) - 0xFFFE (65534), ` +
                `got ${this.options.network.panID}.`);
        }
    }

    public getZstackAdapter(): Adapter {
        return this.adapter;
    }

    /**
     * Start the Herdsman controller
     */
    public async start(): Promise<AdapterTsType.StartResult> {
        // Database (create end inject)
        this.database = Database.open(this.options.databasePath);
        Entity.injectDatabase(this.dbInstKey, this.database);

        // Adapter (create and inject)
        this.adapter = await Adapter.create(this.options.network,
            this.options.serialPort, this.options.backupPath, this.options.adapter, this.logger);
        debug.log(`Starting with options '${JSON.stringify(this.options)}'`);
        const startResult = await this.adapter.start();
        debug.log(`Started with result '${startResult}'`);
        Entity.injectAdapter(this.dbInstKey, this.adapter);

        // log injection
        debug.log(`Injected database: ${this.database != null}, adapter: ${this.adapter != null}`);

        this.greenPower = new GreenPower(this.adapter);
        this.greenPower.on(GreenPowerEvents.deviceJoined, this.onDeviceJoinedGreenPower.bind(this));

        // Register adapter events
        this.adapter.on(AdapterEvents.Events.deviceJoined, this.onDeviceJoined.bind(this));
        this.adapter.on(AdapterEvents.Events.zclData, (data) => this.onZclOrRawData('zcl', data));
        this.adapter.on(AdapterEvents.Events.rawData, (data) => this.onZclOrRawData('raw', data));
        this.adapter.on(AdapterEvents.Events.disconnected, this.onAdapterDisconnected.bind(this));
        this.adapter.on(AdapterEvents.Events.deviceAnnounce, this.onDeviceAnnounce.bind(this));
        this.adapter.on(AdapterEvents.Events.deviceLeave, this.onDeviceLeave.bind(this));
        this.adapter.on(AdapterEvents.Events.networkAddress, this.onNetworkAddress.bind(this));

        if (startResult === 'reset') {
            if (this.options.databaseBackupPath && fs.existsSync(this.options.databasePath)) {
                fs.copyFileSync(this.options.databasePath, this.options.databaseBackupPath);
            }

            debug.log('Clearing database...');
            for (const group of Group.all(this.dbInstKey)) {
                group.removeFromDatabase();
            }

            for (const device of Device.all(this.dbInstKey)) {
                device.removeFromDatabase();
            }
        }

        if (startResult === 'reset' || (this.options.backupPath && !fs.existsSync(this.options.backupPath))) {
            await this.backup();
        }

        // Add coordinator to the database if it is not there yet.
        const coordinator = await this.adapter.getCoordinator();
        if (Device.byType(this.dbInstKey, 'Coordinator').length === 0) {
            debug.log('No coordinator in database, querying...');
            Device.create(
                'Coordinator', coordinator.ieeeAddr, coordinator.networkAddress, coordinator.manufacturerID,
                undefined, undefined, undefined, true, coordinator.endpoints, this.dbInstKey
            );
        }

        // Update coordinator ieeeAddr if changed, can happen due to e.g. reflashing
        const databaseCoordinator = Device.byType(this.dbInstKey, 'Coordinator')[0];
        if (databaseCoordinator.ieeeAddr !== coordinator.ieeeAddr) {
            debug.log(`Coordinator address changed, updating to '${coordinator.ieeeAddr}'`);
            databaseCoordinator.ieeeAddr = coordinator.ieeeAddr;
            databaseCoordinator.save();
        }

        // Set backup timer to 1 day.
        this.backupTimer = setInterval(() => this.backup(), 21600000);
        // this.backupTimer = setInterval(() => this.backup(), 60000);

        // Set database save timer to 1 hour.
        this.databaseSaveTimer = setInterval(() => this.databaseSave(), 3600000);
        // this.databaseSaveTimer = setInterval(() => this.databaseSave(), 50000);

        this.touchlink = new Touchlink(this.adapter);

        return startResult;
    }

    public async touchlinkIdentify(ieeeAddr: string, channel: number): Promise<void> {
        await this.touchlink.identify(ieeeAddr, channel);
    }

    public async touchlinkScan(): Promise<{ieeeAddr: string; channel: number}[]> {
        return this.touchlink.scan();
    }

    public async touchlinkFactoryReset(ieeeAddr: string, channel: number): Promise<boolean> {
        return this.touchlink.factoryReset(ieeeAddr, channel);
    }

    public async touchlinkFactoryResetFirst(): Promise<boolean> {
        return this.touchlink.factoryResetFirst();
    }

    public async permitJoinTimed(duration: number, device?: Device): Promise<void> {
        if (duration && !this.getPermitJoin()) {
            debug.log('Permit joining');
            await this.adapter.permitJoin(duration, !device ? null : device.networkAddress);
        }
    }

    public async permitJoin(permit: boolean, device?: Device, time?: number): Promise<void> {
        await this.permitJoinInternal(permit, 'manual', device, time);
    }

    public async permitJoinInternal(
        permit: boolean, reason: 'manual' | 'timer_expired', device?: Device, time?: number): Promise<void> {
        clearInterval(this.permitJoinNetworkClosedTimer);
        clearInterval(this.permitJoinTimeoutTimer);
        this.permitJoinNetworkClosedTimer = null;
        this.permitJoinTimeoutTimer = null;
        this.permitJoinTimeout = undefined;

        if (permit) {
            await this.adapter.permitJoin(254, !device ? null : device.networkAddress);
            await this.greenPower.permitJoin(254);
            if ((await this.adapter.supportsLED()) && !this.options.adapter.disableLED) {
                await this.adapter.setLED(true);
            }

            // Zigbee 3 networks automatically close after max 255 seconds, keep network open.
            this.permitJoinNetworkClosedTimer = setInterval(async (): Promise<void> => {
                await this.adapter.permitJoin(254, !device ? null : device.networkAddress);
                await this.greenPower.permitJoin(254);
            }, 200 * 1000);

            if (typeof time === 'number') {
                this.permitJoinTimeout = time;
                this.permitJoinTimeoutTimer = setInterval(async (): Promise<void> => {
                    this.permitJoinTimeout--;
                    if (this.permitJoinTimeout <= 0) {
                        await this.permitJoinInternal(false, 'timer_expired');
                    } else {
                        const data: Events.PermitJoinChangedPayload =
                            {permitted: true, timeout: this.permitJoinTimeout, reason};
                        this.emit(Events.Events.permitJoinChanged, data);
                    }
                }, 1000);
            }

            const data: Events.PermitJoinChangedPayload = {permitted: true, reason, timeout: this.permitJoinTimeout};
            this.emit(Events.Events.permitJoinChanged, data);
        } else {
            debug.log('Disable joining');
            if ((await this.adapter.supportsLED()) && !this.options.adapter.disableLED) {
                await this.adapter.setLED(false);
            }
            await this.greenPower.permitJoin(0);
            await this.adapter.permitJoin(0, null);
            const data: Events.PermitJoinChangedPayload = {permitted: false, reason, timeout: this.permitJoinTimeout};
            this.emit(Events.Events.permitJoinChanged, data);
        }
    }

    public getPermitJoin(): boolean {
        return this.permitJoinNetworkClosedTimer != null;
    }

    public getPermitJoinTimeout(): number {
        return this.permitJoinTimeout;
    }

    public isStopping(): boolean {
        return this.stopping;
    }

    public async stop(): Promise<void> {
        this.stopping = true;
        this.databaseSave();

        // Unregister adapter events
        this.adapter.removeAllListeners(AdapterEvents.Events.deviceJoined);
        this.adapter.removeAllListeners(AdapterEvents.Events.zclData);
        this.adapter.removeAllListeners(AdapterEvents.Events.rawData);
        this.adapter.removeAllListeners(AdapterEvents.Events.disconnected);
        this.adapter.removeAllListeners(AdapterEvents.Events.deviceAnnounce);
        this.adapter.removeAllListeners(AdapterEvents.Events.deviceLeave);

        try {
            await this.permitJoinInternal(false, 'manual');
        } catch (e) {}

        clearInterval(this.backupTimer);
        clearInterval(this.databaseSaveTimer);
        await this.backup();
        await this.adapter.stop();
    }

    public async forceStop(): Promise<void> {
        this.stopping = true;

        // Unregister adapter events
        this.adapter.removeAllListeners(AdapterEvents.Events.deviceJoined);
        this.adapter.removeAllListeners(AdapterEvents.Events.zclData);
        this.adapter.removeAllListeners(AdapterEvents.Events.rawData);
        this.adapter.removeAllListeners(AdapterEvents.Events.disconnected);
        this.adapter.removeAllListeners(AdapterEvents.Events.deviceAnnounce);
        this.adapter.removeAllListeners(AdapterEvents.Events.deviceLeave);

        clearInterval(this.backupTimer);
        clearInterval(this.databaseSaveTimer);

        await this.adapter.stop();
    }

    private databaseSave(): void {
        console.log('Saving all databases ', this.dbInstKey);
        for (const device of Device.all(this.dbInstKey)) {
            device.save();
        }

        for (const group of Group.all(this.dbInstKey)) {
            group.save();
        }
    }

    private async backup(): Promise<void> {
        if (this.options.backupPath && await this.adapter.supportsBackup()) {
            debug.log('Creating coordinator backup');
            const backup = await this.adapter.backup();
            const unifiedBackup = await BackupUtils.toUnifiedBackup(backup);
            fs.writeFileSync(this.options.backupPath, JSON.stringify(unifiedBackup, null, 2));
            debug.log(`Wrote coordinator backup to '${this.options.backupPath}'`);
        }
    }

    public async checkHostHealth(): Promise<boolean> {
        return this.adapter.pingZNPHost();
    }

    public async reset(type: 'soft' | 'hard'): Promise<void> {
        await this.adapter.reset(type);
    }

    public async getCoordinatorVersion(): Promise<AdapterTsType.CoordinatorVersion> {
        return this.adapter.getCoordinatorVersion();
    }

    public async getNetworkParameters(forceFetch?: boolean): Promise<AdapterTsType.NetworkParameters> {
        if (forceFetch) {
            this.networkParametersCached = await this.adapter.getNetworkParameters();
        } else {
            // Cache network parameters as they don't change anymore after start.
            if (!this.networkParametersCached) {
                this.networkParametersCached = await this.adapter.getNetworkParameters();
            }
        }

        return this.networkParametersCached;
    }

    public async forceRemoveDevice(ieeeAddr: string): Promise<void> {
        await this.adapter.forceRemoveDevice(ieeeAddr);
        debug.log(`Device leave '${ieeeAddr}'`);

        const device = Device.byIeeeAddr(this.dbInstKey, ieeeAddr);
        if (device) {
            debug.log(`Removing device from database '${ieeeAddr}'`);
            await device.removeFromDatabase();
        }
    }

    public async addVirtualDevice(ieeeAddr: string, nwkAddr: number, linkKey: Buffer, deviceTypeId: number ): Promise<{Status : string, deviceInfo :any , message : string}> {
        await this.adapter.addVirtualDevice(ieeeAddr, nwkAddr, linkKey);
        debug.log(`Device added offline '${ieeeAddr}'`);
        const IsDeviceVirtual = true
        const device = Device.create(
            'Router', ieeeAddr, nwkAddr, 43690,
            undefined, undefined, undefined, true, 
            [{ID: 15, profileID: 1,  deviceID: deviceTypeId, inputClusters:[2849], outputClusters : [2849]}]
            ,this.dbInstKey, true, IsDeviceVirtual
        );
        

        debug.log(`Added device to db '${ieeeAddr}'`);

        const deviceInterviewPayload: Events.DeviceInterviewPayload = { status: 'successful', device };
        this.emit(Events.Events.deviceInterview, deviceInterviewPayload);
        const msg = `Virtual Device with DeviceId ${ieeeAddr} added successfully`
        return {
            Status: 'success',
            deviceInfo : device,
            message: msg
        }
    }

    public async manualBackup() {
        return await this.backup();
    }

    public async manualRestore() {
        return await this.adapter.manualRestore();
    }

    /**
     * Get all devices
     */
    public getDevices(): Device[] {
        return Device.all(this.dbInstKey);
    }

    /**
     * Get all devices with a specific type
     */
    public getDevicesByType(type: DeviceType): Device[] {
        return Device.byType(this.dbInstKey, type);
    }

    /**
     * Get device by ieeeAddr
     */
    public getDeviceByIeeeAddr(ieeeAddr: string): Device {
        return Device.byIeeeAddr(this.dbInstKey, ieeeAddr);
    }

    /**
     * Get device by networkAddress
     */
    public getDeviceByNetworkAddress(networkAddress: number): Device {
        return Device.byNetworkAddress(this.dbInstKey, networkAddress);
    }

    /**
     * Get group by ID
     */
    public getGroupByID(groupID: number): Group {
        return Group.byGroupID(this.dbInstKey, groupID);
    }

    /**
     * Get all groups
     */
    public getGroups(): Group[] {
        return Group.all(this.dbInstKey);
    }

    /**
     * Create a Group
     */
    public createGroup(groupID: number): Group {
        return Group.create(this.dbInstKey, groupID);
    }

    /**
     *  Check if the adapters supports LED
     */
    public async supportsLED(): Promise<boolean> {
        return this.adapter.supportsLED();
    }

    /**
     *  Set transmit power of the adapter
     */
    public async setTransmitPower(value: number): Promise<void> {
        return this.adapter.setTransmitPower(value);
    }

    /**
     *  Enable/Disable the LED
     */
    public async setLED(enabled: boolean): Promise<void> {
        if (!(await this.supportsLED())) throw new Error(`Adapter doesn't support LED`);
        await this.adapter.setLED(enabled);
    }

    private onNetworkAddress(payload: AdapterEvents.NetworkAddressPayload): void {
        debug.log(`Network address '${payload.ieeeAddr}'`);
        const device = Device.byIeeeAddr(this.dbInstKey, payload.ieeeAddr);

        if (!device) {
            debug.log(`Network address is from unknown device '${payload.ieeeAddr}'`);
            return;
        }

        if (device.networkAddress !== payload.networkAddress) {
            debug.log(`Device '${payload.ieeeAddr}' got new networkAddress '${payload.networkAddress}'`);
            device.networkAddress = payload.networkAddress;
            device.save();

            const data: Events.DeviceNetworkAddressChangedPayload = {device};
            this.emit(Events.Events.deviceNetworkAddressChanged, data);
        }
    }

    private onDeviceAnnounce(payload: AdapterEvents.DeviceAnnouncePayload): void {
        debug.log(`Device announce '${payload.ieeeAddr}'`);
        const device = Device.byIeeeAddr(this.dbInstKey, payload.ieeeAddr);

        if (!device) {
            debug.log(`Device announce is from unknown device '${payload.ieeeAddr}'`);
            return;
        }

        device.receivedMessage();

        if (device.networkAddress !== payload.networkAddress) {
            debug.log(`Device '${payload.ieeeAddr}' announced with new networkAddress '${payload.networkAddress}'`);
            device.networkAddress = payload.networkAddress;
            device.save();
        }

        const data: Events.DeviceAnnouncePayload = { device };
        this.emit(Events.Events.deviceAnnounce, data);
    }

    private onDeviceLeave(payload: AdapterEvents.DeviceLeavePayload): void {
        debug.log(`Device leave '${payload.ieeeAddr}'`);

        const device = Device.byIeeeAddr(this.dbInstKey, payload.ieeeAddr);
        if (device) {
            debug.log(`Removing device from database '${payload.ieeeAddr}'`);
            device.removeFromDatabase();
        }

        const data: Events.DeviceLeavePayload = {
            ieeeAddr: payload.ieeeAddr,
            networkAddr: payload.networkAddress,
            rejoin: payload.rejoin
        };
        this.emit(Events.Events.deviceLeave, data);
    }

    private async onAdapterDisconnected(): Promise<void> {
        debug.log(`Adapter disconnected'`);

        try {
            await this.adapter.stop();
        } catch (error) {
        }

        this.emit(Events.Events.adapterDisconnected);
    }

    private async onDeviceJoinedGreenPower(payload: GreenPowerDeviceJoinedPayload): Promise<void> {
        debug.log(`Green power device '${JSON.stringify(payload)}' joined`);

        // Green power devices don't have an ieeeAddr, the sourceID is unique and static so use this.
        let ieeeAddr = payload.sourceID.toString(16);
        ieeeAddr = `0x${'0'.repeat(16 - ieeeAddr.length)}${ieeeAddr}`;

        // Green power devices dont' have a modelID, create a modelID based on the deviceID (=type)
        const modelID = `GreenPower_${payload.deviceID}`;

        let device = Device.byIeeeAddr(this.dbInstKey, ieeeAddr);
        if (!device) {
            debug.log(`New green power device '${ieeeAddr}' joined`);
            debug.log(`Creating device '${ieeeAddr}'`);
            device = Device.create(
                'GreenPower', ieeeAddr, payload.networkAddress, null,
                undefined, undefined, modelID, true, [], this.dbInstKey
            );
            device.save();

            const deviceJoinedPayload: Events.DeviceJoinedPayload = { device };
            this.emit(Events.Events.deviceJoined, deviceJoinedPayload);

            const deviceInterviewPayload: Events.DeviceInterviewPayload = { status: 'successful', device };
            this.emit(Events.Events.deviceInterview, deviceInterviewPayload);
        }
    }

    private async onDeviceJoined(payload: AdapterEvents.DeviceJoinedPayload): Promise<void> {
        debug.log(`Device '${payload.ieeeAddr}' joined`);

        if (this.options.acceptJoiningDeviceHandler) {
            if (!(await this.options.acceptJoiningDeviceHandler(payload.ieeeAddr))) {
                debug.log(`Device '${payload.ieeeAddr}' rejected by handler, removing it`);
                await this.adapter.removeDevice(payload.networkAddress, payload.ieeeAddr);
                return;
            } else {
                debug.log(`Device '${payload.ieeeAddr}' accepted by handler`);
            }
        }

        let device = Device.byIeeeAddr(this.dbInstKey, payload.ieeeAddr);
        if (!device) {
            debug.log(`New device '${payload.ieeeAddr}' joined`);
            debug.log(`Creating device '${payload.ieeeAddr}'`);
            device = Device.create(
                'Unknown', payload.ieeeAddr, payload.networkAddress, undefined,
                undefined, undefined, undefined, false, [], this.dbInstKey
            );

            const eventData: Events.DeviceJoinedPayload = { device };
            this.emit(Events.Events.deviceJoined, eventData);
        }

        device.receivedMessage();

        if (!device.interviewCompleted && !device.interviewing) {
            const payloadStart: Events.DeviceInterviewPayload = { status: 'started', device };
            debug.log(`Interview '${device.ieeeAddr}' start`);
            this.emit(Events.Events.deviceInterview, payloadStart);

            try {
                await device.interview();
                debug.log(`Succesfully interviewed '${device.ieeeAddr}'`);
                const event: Events.DeviceInterviewPayload = { status: 'successful', device };
                this.emit(Events.Events.deviceInterview, event);
            } catch (error) {
                debug.error(`Interview failed for '${device.ieeeAddr} with error '${error}'`);
                const event: Events.DeviceInterviewPayload = { status: 'failed', device };
                this.emit(Events.Events.deviceInterview, event);
            }
        } else {
            debug.log(
                `Not interviewing '${payload.ieeeAddr}', completed '${device.interviewCompleted}', ` +
                `in progress '${device.interviewing}'`
            );

            let networkAddressChanged = false;
            if (device.networkAddress !== payload.networkAddress) {
                debug.log(
                    `Device '${payload.ieeeAddr}' is already in database with different networkAddress, ` +
                    `updating networkAddress`
                );
                device.networkAddress = payload.networkAddress;
                device.save();

                networkAddressChanged = true;
            }

            const eventData: Events.DeviceRejoinedPayload = {device, networkAddressChanged: networkAddressChanged};
            this.emit(Events.Events.deviceRejoined, eventData);
        }
    }

    private isZclDataPayload(
        dataPayload: AdapterEvents.ZclDataPayload | AdapterEvents.RawDataPayload, type: 'zcl' | 'raw'
    ): dataPayload is AdapterEvents.ZclDataPayload {
        return type === 'zcl';
    }

    private async onZclOrRawData(
        dataType: 'zcl' | 'raw', dataPayload: AdapterEvents.ZclDataPayload | AdapterEvents.RawDataPayload
    ): Promise<void> {
        const logDataPayload = JSON.parse(JSON.stringify(dataPayload));
        if (dataType === 'zcl') {
            delete logDataPayload.frame.Cluster;
        }
        debug.log(`Received '${dataType}' data '${JSON.stringify(logDataPayload)}'`);

        if (this.isZclDataPayload(dataPayload, dataType)) {
            if (dataPayload.frame.Cluster.name === 'touchlink') {
                // This is handled by touchlink
                return;
            } else if (dataPayload.frame.Cluster.name === 'greenPower') {
                this.greenPower.onZclGreenPowerData(dataPayload);
            }
        }

        const device = typeof dataPayload.address === 'string' ?
            Device.byIeeeAddr(this.dbInstKey, dataPayload.address) : Device.byNetworkAddress(this.dbInstKey, dataPayload.address);
        if (!device) {
            debug.log(
                `'${dataType}' data is from unknown device with address '${dataPayload.address}', ` +
                `skipping...`
            );
            return;
        }

        device.receivedMessage();
        device.linkquality = dataPayload.linkquality;

        let endpoint = device.getEndpoint(dataPayload.endpoint);
        if (!endpoint) {
            debug.log(
                `'${dataType}' data is from unknown endpoint '${dataPayload.endpoint}' from device with ` +
                `network address '${dataPayload.address}', creating it...`
            );
            endpoint = await device.createEndpoint(dataPayload.endpoint);
        }

        // Parse command for event
        let type: Events.MessagePayloadType = undefined;
        let data: KeyValue;
        let clusterName = undefined;
        const meta: {
            zclTransactionSequenceNumber?: number;
            manufacturerCode?: number;
            frameControl?: FrameControl;
        } = {};

        if (this.isZclDataPayload(dataPayload, dataType)) {
            const frame = dataPayload.frame;
            const command = frame.getCommand();
            clusterName = frame.Cluster.name;
            meta.zclTransactionSequenceNumber = frame.Header.transactionSequenceNumber;
            meta.manufacturerCode = frame.Header.manufacturerCode;
            meta.frameControl = frame.Header.frameControl;

            if (frame.isGlobal()) {
                if (frame.isCommand('report')) {
                    type = 'attributeReport';
                    data = ZclFrameConverter.attributeKeyValue(dataPayload.frame);
                } else if (frame.isCommand('read')) {
                    type = 'read';
                    data = ZclFrameConverter.attributeList(dataPayload.frame);
                } else if (frame.isCommand('write')) {
                    type = 'write';
                    data = ZclFrameConverter.attributeKeyValue(dataPayload.frame);
                } else {
                    /* istanbul ignore else */
                    if (frame.isCommand('readRsp')) {
                        type = 'readResponse';
                        data = ZclFrameConverter.attributeKeyValue(dataPayload.frame);
                    }
                }
            } else {
                /* istanbul ignore else */
                if (frame.isSpecific()) {
                    if (Events.CommandsLookup[command.name]) {
                        type = Events.CommandsLookup[command.name];
                        data = dataPayload.frame.Payload;
                    } else {
                        debug.log(`Skipping command '${command.name}' because it is missing from the lookup`);
                    }
                }
            }

            if (type === 'readResponse' || type === 'attributeReport') {
                // Some device report, e.g. it's modelID through a readResponse or attributeReport
                for (const [key, value] of Object.entries(data)) {
                    const property = Device.ReportablePropertiesMapping[key];
                    if (property && !device[property.key]) {
                        property.set(value, device);
                    }
                }

                endpoint.saveClusterAttributeKeyValue(clusterName, data);
            }
        } else {
            type = 'raw';
            data = dataPayload.data;
            try {
                const cluster = ZclUtils.getCluster(dataPayload.clusterID);
                clusterName = cluster.name;
            } catch (error) {
                clusterName = dataPayload.clusterID;
            }
        }

        if (type && data) {
            const endpoint = device.getEndpoint(dataPayload.endpoint);
            const linkquality = dataPayload.linkquality;
            const groupID = dataPayload.groupID;
            const eventData: Events.MessagePayload = {
                type: type, device, endpoint, data, linkquality, groupID, cluster: clusterName, meta
            };

            this.emit(Events.Events.message, eventData);
        }


        if (this.isZclDataPayload(dataPayload, dataType)) {
            device.onZclData(dataPayload, endpoint);
        }
    }

    public async broadcastToNetwork(
        clusterKey: number | string, commandKey: number | string, payload: KeyValue, endpoint: number, inputOptions?: BroadcastOptions
    ): Promise<void> {
        const options: BroadcastOptions = {
            direction: ZclDirection.CLIENT_TO_SERVER,
            srcEndpoint: null,
            reservedBits: 0,
            manufacturerCode: null,
            transactionSequenceNumber: null,
            ...inputOptions
        };

        const cluster = ZclUtils.getCluster(clusterKey);
        const command = cluster.getCommand(commandKey);

        const log = `Command Broadcast to Network ${cluster.name}.${command.name}(${JSON.stringify(payload)})`;
        debug.log(log);

        try {
            const frame = ZclFrame.create(
                ZclFrameType.SPECIFIC, options.direction, true, options.manufacturerCode,
                options.transactionSequenceNumber || ZclTransactionSequenceNumber.next(),
                command.ID, cluster.ID, payload, options.reservedBits
            );

            await this.adapter.sendZclFrameToAll(endpoint, frame, inputOptions.srcEndpoint);
        } catch (error) {
            const message = `${log} failed (${error})`;
            debug.error(message);
            throw Error(message);
        }
    }
}

export default Controller;
