import * as TsType from './tstype';
import {ZclDataPayload} from './events';
import events from 'events';
import {ZclFrame, FrameType, Direction} from '../zcl';
import Debug from "debug";
import {LoggerStub} from "../controller/logger-stub";
import * as Models from "../models";

const debug = Debug("zigbee-herdsman:adapter");

abstract class Adapter extends events.EventEmitter {
    public readonly greenPowerGroup = 0x0b84;
    protected networkOptions: TsType.NetworkOptions;
    protected adapterOptions: TsType.AdapterOptions;
    protected serialPortOptions: TsType.SerialPortOptions;
    protected backupPath: string;
    protected logger?: LoggerStub;

    protected constructor(
        networkOptions: TsType.NetworkOptions, serialPortOptions: TsType.SerialPortOptions, backupPath: string,
        adapterOptions: TsType.AdapterOptions, logger?: LoggerStub)
    {
        super();
        this.networkOptions = networkOptions;
        this.adapterOptions = adapterOptions;
        this.serialPortOptions = serialPortOptions;
        this.backupPath = backupPath;
        this.logger = logger;
    }

    public async pingZNPHost(): Promise<boolean> {
        return true;
    }

    public async hasCoordinatorStarted?(): Promise<boolean> {
        return true;
    }

    public getNwkOptions(): TsType.NetworkOptions {
        return {...this.networkOptions};
    }

    /**
     * Utility
     */

    public static async create(
        networkOptions: TsType.NetworkOptions,
        serialPortOptions: TsType.SerialPortOptions,
        backupPath: string,
        adapterOptions: TsType.AdapterOptions,
        logger?: LoggerStub,
    ): Promise<Adapter> {
        const {ZStackAdapter} = await import('./z-stack/adapter');
        const {DeconzAdapter} = await import('./deconz/adapter');
        const {ZiGateAdapter} = await import('./zigate/adapter');
        const {EZSPAdapter} = await import('./ezsp/adapter');
        type AdapterImplementation = (typeof ZStackAdapter | typeof DeconzAdapter | typeof ZiGateAdapter
            | typeof EZSPAdapter);

        let adapters: AdapterImplementation[];
        const adapterLookup = {zstack: ZStackAdapter, deconz: DeconzAdapter, zigate: ZiGateAdapter,
            ezsp: EZSPAdapter};
        if (serialPortOptions.adapter && serialPortOptions.adapter !== 'auto') {
            if (adapterLookup.hasOwnProperty(serialPortOptions.adapter)) {
                adapters = [adapterLookup[serialPortOptions.adapter]];
            } else {
                throw new Error(
                    `Adapter '${serialPortOptions.adapter}' does not exists, possible ` +
                    `options: ${Object.keys(adapterLookup).join(', ')}`
                );
            }
        } else {
            adapters = Object.values(adapterLookup);
        }

        // Use ZStackAdapter by default
        let adapter: AdapterImplementation = ZStackAdapter;
        
        if (!serialPortOptions.path) {
            debug('No path provided, auto detecting path');
            for (const candidate of adapters) {
                const path = await candidate.autoDetectPath();
                if (path) {
                    debug(`Auto detected path '${path}' from adapter '${candidate.name}'`);
                    serialPortOptions.path = path;
                    adapter = candidate;
                    break;
                }
            }

            if (!serialPortOptions.path) {
                throw new Error("No path provided and failed to auto detect path");
            }
        } else {
            try {
                // Determine adapter to use
                for (const candidate of adapters) {
                    if (await candidate.isValidPath(serialPortOptions.path)) {
                        debug(`Path '${serialPortOptions.path}' is valid for '${candidate.name}'`);
                        adapter = candidate;
                        break;
                    }
                }
            } catch (error) {
                debug(`Failed to validate path: '${error}'`);
            }
        }

        return new adapter(networkOptions, serialPortOptions, backupPath, adapterOptions, logger);
    }

    public abstract start(): Promise<TsType.StartResult>;

    public abstract stop(): Promise<void>;

    public abstract getCoordinator(): Promise<TsType.Coordinator>;

    public abstract getCoordinatorVersion(): Promise<TsType.CoordinatorVersion>;

    public abstract reset(type: 'soft' | 'hard'): Promise<void>;

    public async reconfigureAdapter(wipe: boolean, configItems?: {id: number, value: number[]}[]): Promise<void> {}

    public abstract supportsLED(): Promise<boolean>;

    public abstract setLED(enabled: boolean): Promise<void>;

    public abstract supportsBackup(): Promise<boolean>;

    public abstract backup(): Promise<Models.Backup | any>;

    public abstract getNetworkParameters(): Promise<TsType.NetworkParameters>;

    public abstract setTransmitPower(value: number): Promise<void>;

    public abstract waitFor(
        networkAddress: number, endpoint: number, frameType: FrameType, direction: Direction,
        transactionSequenceNumber: number, clusterID: number, commandIdentifier: number, timeout: number,
    ): {promise: Promise<ZclDataPayload>; cancel: () => void};

    /**
     * ZDO
     */

    public abstract permitJoin(seconds: number, networkAddress: number): Promise<void>;

    public abstract lqi(networkAddress: number): Promise<TsType.LQI>;

    public abstract routingTable(networkAddress: number): Promise<TsType.RoutingTable>;

    public abstract nodeDescriptor(networkAddress: number): Promise<TsType.NodeDescriptor>;

    public abstract activeEndpoints(networkAddress: number): Promise<TsType.ActiveEndpoints>;

    public abstract simpleDescriptor(networkAddress: number, endpointID: number): Promise<TsType.SimpleDescriptor>;

    public abstract bind(
        destinationNetworkAddress: number, sourceIeeeAddress: string, sourceEndpoint: number,
        clusterID: number, destinationAddressOrGroup: string | number, type: 'endpoint' | 'group',
        destinationEndpoint?: number
    ): Promise<void>;

    public abstract unbind(
        destinationNetworkAddress: number, sourceIeeeAddress: string, sourceEndpoint: number,
        clusterID: number, destinationAddressOrGroup: string | number, type: 'endpoint' | 'group',
        destinationEndpoint: number
    ): Promise<void>;

    public abstract removeDevice(networkAddress: number, ieeeAddr: string): Promise<any>;

    public abstract forceRemoveDevice(ieeeAddr: string): Promise<void>;


    public async manualRestore(): Promise<void> {}

    /**
     * kz-mesh hook: Keus mesh diagnostics (MT_UTIL 0x65 - 0x6A).
     *
     * Implemented by the Z-Stack adapter (see ./z-stack/kz-mesh) against Keus
     * mesh firmware. Every caller must gate on supportsKzMesh() first; the
     * defaults below fail loudly rather than returning empty data that would
     * read as "nothing wrong".
     */

    public supportsKzMesh(): boolean {
        return false;
    }

    public async kzGetMeshCapabilities(): Promise<TsType.KzMeshCapabilities> {
        return {supportsKzMesh: false, znpVersion: 'unknown', revision: ''};
    }

    public async kzGetDiagCounters(): Promise<TsType.KzDiagCounters> {
        throw new Error('Keus mesh diagnostics are not supported by this adapter');
    }

    public async kzGetNeighborTable(): Promise<TsType.KzNeighborTable> {
        throw new Error('Keus mesh diagnostics are not supported by this adapter');
    }

    public async kzGetRoutingTable(): Promise<TsType.KzRoutingEntry[]> {
        throw new Error('Keus mesh diagnostics are not supported by this adapter');
    }

    public async kzGetSourceRoutes(): Promise<TsType.KzSourceRoute[]> {
        throw new Error('Keus mesh diagnostics are not supported by this adapter');
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async kzProvisionDevice(request: TsType.KzProvisionRequest): Promise<TsType.KzProvisionResult> {
        throw new Error('Keus mesh provisioning is not supported by this adapter');
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public async kzPurgeDevice(ieeeAddr: string): Promise<number> {
        throw new Error('Keus mesh device purge is not supported by this adapter');
    }

    /**
     * ZCL
     */

    public abstract sendZclFrameToEndpoint(
        ieeeAddr: string, networkAddress: number, endpoint: number, zclFrame: ZclFrame, timeout: number,
        disableResponse: boolean, disableRecovery: boolean, sourceEndpoint?: number,
    ): Promise<ZclDataPayload>;

    public abstract sendZclFrameToGroup(groupID: number, zclFrame: ZclFrame, sourceEndpoint?: number): Promise<void>;

    public abstract sendZclFrameToAll(endpoint: number, zclFrame: ZclFrame, sourceEndpoint: number): Promise<void>;

    /**
     * InterPAN
     */

    public abstract setChannelInterPAN(channel: number): Promise<void>;

    public abstract sendZclFrameInterPANToIeeeAddr(zclFrame: ZclFrame, ieeeAddress: string): Promise<void>;

    public abstract sendZclFrameInterPANBroadcast(
        zclFrame: ZclFrame, timeout: number
    ): Promise<ZclDataPayload>;

    public abstract restoreChannelInterPAN(): Promise<void>;

}

export default Adapter;