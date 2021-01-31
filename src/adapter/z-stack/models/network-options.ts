export interface NetworkOptions {
    panId: number;
    extendedPanId: Buffer;
    channelList: number[];
    networkKey: Buffer;
    networkKeyDistribute: boolean;
}
