/**
 * Retry and recovery policy for unicast sends.
 *
 * Split out from ZStackAdapter so the decisions are pure and testable, and so the
 * reasoning lives in one place instead of being spread through a recursive
 * function.
 *
 * Three things drive the design:
 *
 *  1. The old ladder chose recovery by ATTEMPT NUMBER, not by error. A
 *     NWK_NO_ROUTE - the one case where route discovery is exactly right - got a
 *     flat 2s sleep first and only discovered a route on its second retry, while
 *     congestion errors could trigger route work that made congestion worse.
 *     Recovery is now selected by what actually failed.
 *
 *  2. Retries were unbounded in wall-clock terms. Two nested loops (4 confirm
 *     attempts x 4 response attempts) meant up to 16 sends and well over a minute
 *     for one command, holding an adapter queue slot the whole time. There is now
 *     one attempt budget and one deadline.
 *
 *  3. Fixed 2s waits made many devices retry in lockstep, which is what produces
 *     MAC_CHANNEL_ACCESS_FAILURE in the first place. Backoff is exponential with
 *     jitter.
 */

import * as Constants from '../constants';

const {ZnpCommandStatus} = Constants.COMMON;

/** Not a real status code - the adapter uses it when dataConfirm never arrives. */
export const DATA_CONFIRM_TIMEOUT = 9999;

export enum SendFailure {
    /** local or RF congestion: back off, never touch routes */
    CONGESTION = 'congestion',
    /** no route entry exists: route discovery is the correct response */
    NO_ROUTE = 'no-route',
    /** next hop did not ack; could be the link, could be traffic */
    LINK = 'link',
    /** indirect transmission to a sleepy device expired - a parent problem */
    INDIRECT_EXPIRED = 'indirect-expired',
    /** confirm never arrived at all */
    CONFIRM_TIMEOUT = 'confirm-timeout',
    /** the frame was confirmed but the device never answered */
    RESPONSE_TIMEOUT = 'response-timeout',
    /** anything not worth retrying */
    FATAL = 'fatal',
}

export function classifyConfirmStatus(status: number): SendFailure {
    switch (status) {
        case ZnpCommandStatus.MAC_CHANNEL_ACCESS_FAILURE:
        case ZnpCommandStatus.BUFFER_FULL:
        case ZnpCommandStatus.MAC_NO_RESOURCES:
            return SendFailure.CONGESTION;
        case ZnpCommandStatus.NWK_NO_ROUTE:
            return SendFailure.NO_ROUTE;
        case ZnpCommandStatus.MAC_NO_ACK:
            return SendFailure.LINK;
        case ZnpCommandStatus.MAC_TRANSACTION_EXPIRED:
            return SendFailure.INDIRECT_EXPIRED;
        case DATA_CONFIRM_TIMEOUT:
            return SendFailure.CONFIRM_TIMEOUT;
        default:
            return SendFailure.FATAL;
    }
}

export type RecoveryAction =
    /** wait and send again, touching nothing */
    | 'backoff'
    /** ask the stack to find a route, then send again */
    | 'discover-route'
    /** look up whether the short address moved, then send again */
    | 'check-address'
    /** stop */
    | 'give-up';

export interface RecoveryDecision {
    action: RecoveryAction;
    waitMs: number;
    /** carried into logs so a failure explains itself */
    reason: string;
}

export interface SendPolicyOptions {
    /** total sends allowed for one logical command */
    maxAttempts: number;
    /**
     * Sends allowed when the frame was CONFIRMED but the device did not answer.
     * Deliberately much smaller: a successful dataConfirm means the frame reached
     * the device, so it may already have acted on it and only failed to reply.
     * Every resend is a possible duplicate command.
     */
    maxResponseAttempts: number;
    /** wall-clock ceiling for the whole command */
    deadlineMs: number;
    /** first backoff step; doubles per attempt */
    backoffBaseMs: number;
    backoffMaxMs: number;
    /**
     * Look up the short address on repeated failure. Off by default: it is a ZDO
     * BROADCAST, and in a network where the gateway assigns addresses they do not
     * drift - so it added broadcast load at the worst possible moment to check
     * something that had not changed.
     */
    verifyNetworkAddress: boolean;
    /**
     * Host-driven route discovery. On firmware that maintains its own paths
     * (MTO mitigation, source-route flushing, next-hop invalidation from the
     * Device_annce hook) a forced discovery can churn a route the stack parked on
     * purpose, and it broadcasts while the network is already struggling.
     */
    allowRouteDiscovery: boolean;
}

export const DEFAULT_SEND_POLICY: SendPolicyOptions = {
    maxAttempts: 4,
    maxResponseAttempts: 2,
    deadlineMs: 20000,
    backoffBaseMs: 250,
    backoffMaxMs: 4000,
    verifyNetworkAddress: false,
    allowRouteDiscovery: true,
};

/**
 * Exponential with full jitter. The jitter matters more than the growth: without
 * it, every device that failed in the same congestion burst retries at the same
 * instant and recreates the burst.
 */
export function backoffMs(
    attempt: number, options: SendPolicyOptions, random: () => number = Math.random
): number {
    const exponential = options.backoffBaseMs * Math.pow(2, Math.max(0, attempt));
    const capped = Math.min(exponential, options.backoffMaxMs);
    return Math.round(capped * (0.5 + random() * 0.5));
}

export interface SendAttemptState {
    /** sends already made, 1-based after the first attempt */
    attempt: number;
    routeActionTaken: boolean;
    addressChecked: boolean;
    msRemaining: number;
}

/**
 * What to do about one failure. Pure: no I/O, no clock, no randomness beyond the
 * injected jitter, so the whole table is unit-testable.
 */
export function decideRecovery(
    failure: SendFailure,
    state: SendAttemptState,
    options: SendPolicyOptions,
    random: () => number = Math.random
): RecoveryDecision {
    const wait = backoffMs(state.attempt, options, random);

    if (failure === SendFailure.FATAL) {
        return {action: 'give-up', waitMs: 0, reason: 'status is not retryable'};
    }

    /**
     * A missing dataConfirm is NOT retried, deliberately. The ZNP never told us the
     * outcome, so the frame may well have gone out - resending risks delivering a
     * command twice, which for something like a toggle is worse than failing.
     */
    if (failure === SendFailure.CONFIRM_TIMEOUT) {
        return {
            action: 'give-up', waitMs: 0,
            reason: 'no data confirm - outcome unknown, not retrying to avoid duplicate delivery',
        };
    }

    if (state.attempt >= options.maxAttempts) {
        return {action: 'give-up', waitMs: 0, reason: `attempt budget of ${options.maxAttempts} exhausted`};
    }

    // Leave headroom for one more send plus its recovery wait.
    if (state.msRemaining <= wait) {
        return {action: 'give-up', waitMs: 0, reason: 'send deadline reached'};
    }

    switch (failure) {
        case SendFailure.CONGESTION:
            // Never do route work here: the network is busy, not broken.
            return {action: 'backoff', waitMs: wait, reason: 'congestion, backing off'};

        case SendFailure.NO_ROUTE:
            // The one case where discovery is unambiguously right - and it should
            // happen on the FIRST failure, not the second.
            if (options.allowRouteDiscovery && !state.routeActionTaken) {
                return {action: 'discover-route', waitMs: 0, reason: 'no route, discovering'};
            }
            return {action: 'backoff', waitMs: wait, reason: 'no route, discovery already tried'};

        case SendFailure.RESPONSE_TIMEOUT:
            /**
             * The frame was confirmed, so the route demonstrably works - route
             * discovery here was always illogical, and the old ladder did it
             * anyway. The device simply did not answer.
             *
             * One retry only: the command may already have been executed and only
             * the reply lost, so each resend risks acting twice.
             */
            if (state.attempt >= options.maxResponseAttempts) {
                return {
                    action: 'give-up', waitMs: 0,
                    reason: `device did not answer after ${options.maxResponseAttempts} sends`,
                };
            }
            return {action: 'backoff', waitMs: wait, reason: 'frame delivered but no answer, retrying once'};

        case SendFailure.LINK:
            /**
             * Could be a bad link or just traffic. Back off once before doing
             * anything structural, then try a route action, then let the address
             * check run only if it is enabled.
             */
            if (state.attempt < 2) {
                return {action: 'backoff', waitMs: wait, reason: `${failure}, backing off before route work`};
            }
            if (options.allowRouteDiscovery && !state.routeActionTaken) {
                return {action: 'discover-route', waitMs: 0, reason: `${failure} repeated, discovering route`};
            }
            if (options.verifyNetworkAddress && !state.addressChecked) {
                return {action: 'check-address', waitMs: 0, reason: `${failure} repeated, verifying address`};
            }
            return {action: 'backoff', waitMs: wait, reason: `${failure}, recovery options exhausted`};

        case SendFailure.INDIRECT_EXPIRED:
            /**
             * The device is sleepy and its parent could not hand the frame over.
             * Nothing route-level helps, and the old code's assoc surgery for this
             * case is handled by the firmware now. Back off and let it wake.
             */
            return {action: 'backoff', waitMs: wait, reason: 'indirect transmission expired, waiting for device'};

        default:
            return {action: 'give-up', waitMs: 0, reason: 'unclassified failure'};
    }
}

/**
 * Remembers which devices keep failing, so a powered-off device stops costing a
 * full ladder and an adapter queue slot on every single send.
 */
export class DeviceFailureTracker {
    private failures = new Map<string, {count: number; suspectUntil: number}>();

    constructor(
        private readonly threshold = 3,
        private readonly cooldownMs = 60000,
    ) {}

    public recordSuccess(key: string): void {
        this.failures.delete(key);
    }

    public recordFailure(key: string): number {
        const entry = this.failures.get(key) || {count: 0, suspectUntil: 0};
        entry.count++;

        if (entry.count >= this.threshold) {
            entry.suspectUntil = Date.now() + this.cooldownMs;
        }

        this.failures.set(key, entry);
        return entry.count;
    }

    /** True while the device is in cooldown after repeated full-ladder failures. */
    public isSuspect(key: string, now = Date.now()): boolean {
        const entry = this.failures.get(key);
        return Boolean(entry && entry.suspectUntil > now);
    }

    public suspectFor(key: string, now = Date.now()): number {
        const entry = this.failures.get(key);
        return entry && entry.suspectUntil > now ? entry.suspectUntil - now : 0;
    }

    public clear(): void {
        this.failures.clear();
    }
}
