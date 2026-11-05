import "regenerator-runtime/runtime";
import {ZStackAdapter} from '../src/adapter/z-stack/adapter';

// The native serialport bindings are not needed: znp is replaced with a stub below.
jest.mock('serialport', () => jest.fn());

describe('readCoordinatorState', () => {
    const IEEE = '0x00124b0012345678';

    const makeAdapter = (devicestate: number, activeeplist: number[] | null): any => {
        const adapter: any = new ZStackAdapter(
            {panID: 0x1a62, extendedPanID: [0xdd], channelList: [11], networkKey: [1], networkKeyDistribute: false},
            {path: '/dev/ttyMock'}, 'backup.json', {concurrent: 16}
        );
        const replies = {
            ping: {payload: {capabilities: 1}},
            getDeviceInfo: {payload: {ieeeaddr: IEEE, devicestate}},
            extNwkInfo: {payload: {panid: 0x1a62, extendedpanid: IEEE, channel: 11}},
            activeEpReq: {payload: {status: 0}},
        };
        adapter.znp = {
            request: jest.fn((_subsystem, command) => Promise.resolve(replies[command])),
            waitFor: jest.fn(() => ({
                ID: 1,
                start: () => ({
                    promise: activeeplist ? Promise.resolve({payload: {activeeplist}})
                        : Promise.reject(new Error('AREQ - ZDO - activeEpRsp after 6000ms')),
                }),
            })),
        };
        adapter.reportAdapterFailure = jest.fn();
        return adapter;
    };

    it('reads a healthy coordinator', async () => {
        const adapter = makeAdapter(9, [1, 11, 15]);
        const state = await adapter.readCoordinatorState();

        expect(state).toMatchObject({ieeeAddr: IEEE, deviceState: 9, panId: 0x1a62, extendedPanId: IEEE, channel: 11});
        expect(state.missingEndpoints).toEqual([]);
        expect(adapter.znp.request.mock.calls.map((c) => c[1])).toEqual(['ping', 'getDeviceInfo', 'extNwkInfo', 'activeEpReq']);
        expect(adapter.znp.waitFor.mock.calls[0][3]).toEqual({nwkaddr: 0});
    });

    it('reports a reset coordinator: not started, endpoints gone', async () => {
        const state = await makeAdapter(0, [1]).readCoordinatorState();

        expect(state.deviceState).toBe(0);
        expect(state.missingEndpoints).toEqual([11, 15]);
    });

    it('rejects on timeout without counting an adapter failure', async () => {
        const adapter = makeAdapter(9, null);

        await expect(adapter.readCoordinatorState()).rejects.toThrow('activeEpRsp');
        expect(adapter.reportAdapterFailure).not.toHaveBeenCalled();
    });
});
