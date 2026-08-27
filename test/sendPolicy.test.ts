import "regenerator-runtime/runtime";
import * as SendPolicy from '../src/adapter/z-stack/adapter/send-policy';
import * as Constants from '../src/adapter/z-stack/constants';

const {ZnpCommandStatus} = Constants.COMMON;

const options = (over: Partial<SendPolicy.SendPolicyOptions> = {}): SendPolicy.SendPolicyOptions =>
    ({...SendPolicy.DEFAULT_SEND_POLICY, ...over});

const state = (over: Partial<SendPolicy.SendAttemptState> = {}): SendPolicy.SendAttemptState =>
    ({attempt: 1, routeActionTaken: false, addressChecked: false, msRemaining: 20000, ...over});

/** Fixed jitter so decisions are deterministic. */
const noJitter = (): number => 1;

describe('send policy', () => {
    describe('classification', () => {
        it('separates congestion from route and link problems', () => {
            expect(SendPolicy.classifyConfirmStatus(ZnpCommandStatus.MAC_CHANNEL_ACCESS_FAILURE))
                .toBe(SendPolicy.SendFailure.CONGESTION);
            expect(SendPolicy.classifyConfirmStatus(ZnpCommandStatus.BUFFER_FULL))
                .toBe(SendPolicy.SendFailure.CONGESTION);
            expect(SendPolicy.classifyConfirmStatus(ZnpCommandStatus.MAC_NO_RESOURCES))
                .toBe(SendPolicy.SendFailure.CONGESTION);
            expect(SendPolicy.classifyConfirmStatus(ZnpCommandStatus.NWK_NO_ROUTE))
                .toBe(SendPolicy.SendFailure.NO_ROUTE);
            expect(SendPolicy.classifyConfirmStatus(ZnpCommandStatus.MAC_NO_ACK))
                .toBe(SendPolicy.SendFailure.LINK);
            expect(SendPolicy.classifyConfirmStatus(ZnpCommandStatus.MAC_TRANSACTION_EXPIRED))
                .toBe(SendPolicy.SendFailure.INDIRECT_EXPIRED);
            expect(SendPolicy.classifyConfirmStatus(SendPolicy.DATA_CONFIRM_TIMEOUT))
                .toBe(SendPolicy.SendFailure.CONFIRM_TIMEOUT);
        });

        it('treats an unknown status as not retryable', () => {
            expect(SendPolicy.classifyConfirmStatus(0x99)).toBe(SendPolicy.SendFailure.FATAL);
        });
    });

    describe('backoff', () => {
        it('grows exponentially and is capped', () => {
            const o = options({backoffBaseMs: 100, backoffMaxMs: 800});
            expect(SendPolicy.backoffMs(0, o, noJitter)).toBe(100);
            expect(SendPolicy.backoffMs(1, o, noJitter)).toBe(200);
            expect(SendPolicy.backoffMs(2, o, noJitter)).toBe(400);
            expect(SendPolicy.backoffMs(9, o, noJitter)).toBe(800);
        });

        it('applies jitter, so devices failing together do not retry in lockstep', () => {
            const o = options({backoffBaseMs: 1000, backoffMaxMs: 8000});
            // full jitter spans 50%..100% of the exponential value
            expect(SendPolicy.backoffMs(0, o, () => 0)).toBe(500);
            expect(SendPolicy.backoffMs(0, o, () => 1)).toBe(1000);
        });
    });

    describe('congestion', () => {
        it('backs off and never touches routes', () => {
            for (const attempt of [1, 2, 3]) {
                const d = SendPolicy.decideRecovery(
                    SendPolicy.SendFailure.CONGESTION, state({attempt}), options(), noJitter
                );
                expect(d.action).toBe('backoff');
                expect(d.waitMs).toBeGreaterThan(0);
            }
        });
    });

    describe('no route', () => {
        it('discovers immediately on the first failure, not the second', () => {
            const d = SendPolicy.decideRecovery(
                SendPolicy.SendFailure.NO_ROUTE, state({attempt: 1}), options(), noJitter
            );
            expect(d.action).toBe('discover-route');
        });

        it('does not repeat a discovery that already happened', () => {
            const d = SendPolicy.decideRecovery(
                SendPolicy.SendFailure.NO_ROUTE,
                state({attempt: 2, routeActionTaken: true}), options(), noJitter
            );
            expect(d.action).toBe('backoff');
        });

        it('respects allowRouteDiscovery being off', () => {
            const d = SendPolicy.decideRecovery(
                SendPolicy.SendFailure.NO_ROUTE, state(), options({allowRouteDiscovery: false}), noJitter
            );
            expect(d.action).toBe('backoff');
        });
    });

    describe('link failure', () => {
        it('backs off before doing anything structural', () => {
            const d = SendPolicy.decideRecovery(
                SendPolicy.SendFailure.LINK, state({attempt: 1}), options(), noJitter
            );
            expect(d.action).toBe('backoff');
        });

        it('discovers a route once it has repeated', () => {
            const d = SendPolicy.decideRecovery(
                SendPolicy.SendFailure.LINK, state({attempt: 2}), options(), noJitter
            );
            expect(d.action).toBe('discover-route');
        });

        it('only verifies the address when explicitly enabled', () => {
            const off = SendPolicy.decideRecovery(
                SendPolicy.SendFailure.LINK,
                state({attempt: 3, routeActionTaken: true}), options(), noJitter
            );
            expect(off.action).toBe('backoff');

            const on = SendPolicy.decideRecovery(
                SendPolicy.SendFailure.LINK,
                state({attempt: 3, routeActionTaken: true}), options({verifyNetworkAddress: true}), noJitter
            );
            expect(on.action).toBe('check-address');
        });
    });

    describe('indirect expired', () => {
        it('waits for the device instead of touching assoc or route state', () => {
            const d = SendPolicy.decideRecovery(
                SendPolicy.SendFailure.INDIRECT_EXPIRED, state({attempt: 2}), options(), noJitter
            );
            expect(d.action).toBe('backoff');
        });
    });

    describe('unknown outcome', () => {
        it('never retries a missing data confirm - the frame may already have gone out', () => {
            const d = SendPolicy.decideRecovery(
                SendPolicy.SendFailure.CONFIRM_TIMEOUT, state({attempt: 1}), options(), noJitter
            );
            expect(d.action).toBe('give-up');
            expect(d.reason).toMatch(/duplicate/i);
        });

        it('retries a confirmed-but-unanswered frame once, and does no route work', () => {
            const first = SendPolicy.decideRecovery(
                SendPolicy.SendFailure.RESPONSE_TIMEOUT, state({attempt: 1}), options(), noJitter
            );
            expect(first.action).toBe('backoff');

            const second = SendPolicy.decideRecovery(
                SendPolicy.SendFailure.RESPONSE_TIMEOUT, state({attempt: 2}), options(), noJitter
            );
            expect(second.action).toBe('give-up');
        });
    });

    describe('bounds', () => {
        it('gives up once the attempt budget is spent', () => {
            const d = SendPolicy.decideRecovery(
                SendPolicy.SendFailure.LINK, state({attempt: 4}), options({maxAttempts: 4}), noJitter
            );
            expect(d.action).toBe('give-up');
            expect(d.reason).toMatch(/budget/);
        });

        it('gives up when there is no time left for another attempt', () => {
            const d = SendPolicy.decideRecovery(
                SendPolicy.SendFailure.CONGESTION,
                state({attempt: 1, msRemaining: 10}), options({backoffBaseMs: 1000}), noJitter
            );
            expect(d.action).toBe('give-up');
            expect(d.reason).toMatch(/deadline/);
        });

        it('never retries a fatal status', () => {
            const d = SendPolicy.decideRecovery(
                SendPolicy.SendFailure.FATAL, state(), options(), noJitter
            );
            expect(d.action).toBe('give-up');
        });
    });

    describe('failure tracker', () => {
        it('marks a device suspect only after repeated failures', () => {
            const t = new SendPolicy.DeviceFailureTracker(3, 60000);

            t.recordFailure('0x1');
            t.recordFailure('0x1');
            expect(t.isSuspect('0x1')).toBe(false);

            t.recordFailure('0x1');
            expect(t.isSuspect('0x1')).toBe(true);
            expect(t.suspectFor('0x1')).toBeGreaterThan(0);
        });

        it('forgets a device as soon as it answers', () => {
            const t = new SendPolicy.DeviceFailureTracker(2, 60000);
            t.recordFailure('0x1');
            t.recordFailure('0x1');
            expect(t.isSuspect('0x1')).toBe(true);

            t.recordSuccess('0x1');
            expect(t.isSuspect('0x1')).toBe(false);
        });

        it('lets the cooldown expire', () => {
            const t = new SendPolicy.DeviceFailureTracker(1, 1000);
            t.recordFailure('0x1');
            expect(t.isSuspect('0x1', Date.now())).toBe(true);
            expect(t.isSuspect('0x1', Date.now() + 2000)).toBe(false);
        });

        it('tracks devices independently', () => {
            const t = new SendPolicy.DeviceFailureTracker(1, 60000);
            t.recordFailure('0x1');
            expect(t.isSuspect('0x1')).toBe(true);
            expect(t.isSuspect('0x2')).toBe(false);
        });
    });
});
