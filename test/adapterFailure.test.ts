import "regenerator-runtime/runtime";
import {ZStackAdapter} from '../src/adapter/z-stack/adapter';
import * as Events from '../src/adapter/events';

/**
 * The adapter reports three coordinator-level failures, all seen in the field on
 * 2026-08-27:
 *
 *   ping-failed    the chip stopped answering SYS ping (54 unanswered, 13:47-14:05)
 *   timeout        an MT request got no SRSP at all (20 occurrences, 13:48-13:50)
 *   invalid-param  endpoints gone after an unnoticed restart (12:03-12:04)
 *
 * None can be repaired from inside the adapter, so the host is asked to
 * power-cycle the chip - but only on the SECOND failure. Recovery drops the mesh
 * for ~25s, so one transient stall must not trigger it.
 */
describe('adapter recovery requests', () => {
    const makeAdapter = (initialized = true): any => {
        const adapter: any = new ZStackAdapter(
            {panID: 0x1a62, extendedPanID: [0xdd], channelList: [11], networkKey: [1], networkKeyDistribute: false},
            {path: '/dev/ttyMock'}, 'backup.json', {concurrent: 16}
        );
        adapter.initialized_ = initialized;
        return adapter;
    };

    const capture = (adapter: any): Events.AdapterFailurePayload[] => {
        const seen: Events.AdapterFailurePayload[] = [];
        adapter.on(Events.Events.adapterFailure, (p) => seen.push(p));
        return seen;
    };

    /** Two failures are required, so the first is always absorbed. */
    const failTwice = (adapter: any, error: Error): void => {
        adapter.noteAdapterFailure(error);
        adapter.noteAdapterFailure(error);
    };

    it('absorbs a single failure without asking', () => {
        const adapter = makeAdapter();
        const seen = capture(adapter);

        adapter.noteAdapterFailure(new Error('SRSP - AF - dataRequest after 6000ms'));

        expect(seen).toHaveLength(0);
    });

    it('reports a failed ping, on the second one', async () => {
        const adapter = makeAdapter();
        const seen = capture(adapter);
        adapter.znp = {request: jest.fn().mockRejectedValue(new Error('SRSP - SYS - ping after 6000ms'))};

        await expect(adapter.pingZNPHost()).resolves.toBe(false);
        expect(seen).toHaveLength(0);

        await expect(adapter.pingZNPHost()).resolves.toBe(false);

        expect(seen).toHaveLength(1);
        expect(seen[0].reason).toBe('ping-failed');
        expect(seen[0].failures).toBe(2);
    });

    it('says nothing when the ping succeeds, and forgets the earlier failure', async () => {
        const adapter = makeAdapter();
        const seen = capture(adapter);

        adapter.znp = {request: jest.fn().mockRejectedValue(new Error('SRSP - SYS - ping after 6000ms'))};
        await adapter.pingZNPHost();

        // A healthy ping means the chip is fine; the count must not carry over.
        adapter.znp = {request: jest.fn().mockResolvedValue({payload: {}})};
        await expect(adapter.pingZNPHost()).resolves.toBe(true);

        adapter.znp = {request: jest.fn().mockRejectedValue(new Error('SRSP - SYS - ping after 6000ms'))};
        await adapter.pingZNPHost();

        expect(seen).toHaveLength(0);
    });

    it('reports an unanswered MT request as a timeout', () => {
        const adapter = makeAdapter();
        const seen = capture(adapter);

        failTwice(adapter, new Error('SRSP - AF - dataRequest after 6000ms'));

        expect(seen).toHaveLength(1);
        expect(seen[0].reason).toBe('timeout');
        expect(seen[0].detail).toContain('did not answer');
    });

    it('reports INVALID_PARAM separately', () => {
        const adapter = makeAdapter();
        const seen = capture(adapter);

        failTwice(adapter, new Error(
            `SREQ '--> AF - dataRequest' failed with status '(0x02: INVALID_PARAM)' (expected '(0x00: SUCCESS)')`
        ));

        expect(seen).toHaveLength(1);
        expect(seen[0].reason).toBe('invalid-param');
    });

    it('carries the reason of the failure that crossed the threshold', () => {
        const adapter = makeAdapter();
        const seen = capture(adapter);

        adapter.noteAdapterFailure(new Error('SRSP - AF - dataRequest after 6000ms'));
        adapter.noteAdapterFailure(new Error('(0x02: INVALID_PARAM)'));

        expect(seen).toHaveLength(1);
        expect(seen[0].reason).toBe('invalid-param');
    });

    it('stays silent until the adapter has been initialized', () => {
        const adapter = makeAdapter(false);
        const seen = capture(adapter);

        failTwice(adapter, new Error('SRSP - AF - dataRequest after 6000ms'));
        failTwice(adapter, new Error('(0x02: INVALID_PARAM)'));

        expect(seen).toHaveLength(0);
    });

    it('stays silent while deliberately closing', () => {
        const adapter = makeAdapter();
        adapter.closing = true;
        const seen = capture(adapter);

        failTwice(adapter, new Error('SRSP - AF - dataRequest after 6000ms'));

        expect(seen).toHaveLength(0);
    });

    it('asks once however many failures arrive', () => {
        const adapter = makeAdapter();
        const seen = capture(adapter);

        for (let i = 0; i < 10; i++) {
            adapter.noteAdapterFailure(new Error('SRSP - AF - dataRequest after 6000ms'));
        }

        expect(seen).toHaveLength(1);
    });
});
