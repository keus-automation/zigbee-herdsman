import Debug from 'debug';

class ZHGlobalLogs {
    static logsEnabled = true;

    static enableLogs(namespace: string): void {
        Debug.enable(namespace);
    }

    static disableLogs(): void {
        Debug.disable();
    }
}

export {ZHGlobalLogs};