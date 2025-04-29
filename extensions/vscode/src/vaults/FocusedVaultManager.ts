import { Trace } from "../bindings/Trace";
import { WebSocket } from "ws";
import { VaultHistoryEntry, VaultsManager } from "./VaultsManager";
import * as vscode from 'vscode';
import { getConfig } from "../config";

export class FocusedVaultManager {
    private focusedVault: FocusedVault | null = null;
    private lastVaultFoundTimestamp: number = 0;
    private vaultKeyPollingInterval: NodeJS.Timeout | null = null;
    private vaultsManager: VaultsManager | null = null;
    private focusedVaultSubscribers: Map<string, (vault: FocusedVault | null) => void> = new Map();
    private batchTraceSubscribers: Map<string, (trace: Trace[]) => void> = new Map();

    constructor(vaultsManager: VaultsManager) {
        this.vaultsManager = vaultsManager;
        this.startVaultKeyMonitoring();
    }

    public getFocusedVaultTraces(): Trace[] {
        return this.focusedVault?.tracesData ?? [];
    }

    public getFocusedVault(): FocusedVault | null {
        return this.focusedVault;
    }

    public subscribeToFocusedVaultChange(onChange: (vault: FocusedVault | null) => void): () => void {
        const uuid = crypto.randomUUID();
        this.focusedVaultSubscribers.set(uuid, onChange);
        return () => {
            this.focusedVaultSubscribers.delete(uuid);
        };
    }

    public subscribeToBatchTrace(onChange: (trace: Trace[]) => void): () => void {
        const uuid = crypto.randomUUID();
        this.batchTraceSubscribers.set(uuid, onChange);
        return () => {
            this.batchTraceSubscribers.delete(uuid);
        };
    }

    public startVaultKeyMonitoring() {
        console.log('Starting vault key monitoring...');
        // Stop existing monitoring if any
        this.dispose();
    
        // Check immediately and then at regular intervals
        this.checkVaultKeyAndUpdateConnection();
    
        this.vaultKeyPollingInterval = setInterval(() => this.checkVaultKeyAndUpdateConnection(), 5000); // Check every 5 seconds
    }
    
    public dispose() {
        console.log('Stopping vault key monitoring...');
        if (this.vaultKeyPollingInterval) {
            clearInterval(this.vaultKeyPollingInterval);
            this.vaultKeyPollingInterval = null;
        }
        this.focusedVault?.wsConnection?.close();
        this.focusedVault = null; 
    }

    private async checkVaultKeyAndUpdateConnection() {
        console.log('Checking vault key...');

        // Get all workspace folder URIs
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return;
        }

        let vaults: (VaultHistoryEntry | null)[] = await Promise.all(workspaceFolders.map(async (folder) => {
            return this.vaultsManager?.getCurrentLocalVaultKey(folder.uri.fsPath) ?? null;
        }));
        vaults = vaults.filter((v) => v !== null);

        // sort by recency
        vaults.sort((a, b) => {
            if (!a || !b) {
                return 0;
            }
            return b.createdAt - a.createdAt;
        });

        const mostRecentVault = vaults[0];
        if (mostRecentVault && mostRecentVault.createdAt > this.lastVaultFoundTimestamp) {
            this.lastVaultFoundTimestamp = mostRecentVault.createdAt;
            this.switchFocusedVault(mostRecentVault.key);
        }
    }

    public switchFocusedVault(newFocusKey: string, retries: number = 0) {
        if (this.focusedVault?.key !== newFocusKey) {
            console.log('Actually switching focused vault to: ' + newFocusKey);
            if (this.focusedVault) {
                this.focusedVault.wsConnection?.close();
                this.focusedVault.wsConnection = null;
            }
            this.focusedVault = new FocusedVault(newFocusKey, (traces) => {
                this.batchTraceSubscribers.forEach(subscriber => subscriber(traces));
            }, () => {
                console.log('Failed to connect to WebSocket, retrying...');
                setTimeout(() => {
                    if (this.focusedVault?.key === newFocusKey) {
                        this.switchFocusedVault(newFocusKey, retries + 1);
                    }
                }, Math.pow(2, (retries + 1)) + 100);
            });
        }
        this.focusedVaultSubscribers.forEach(subscriber => subscriber(this.focusedVault));
    }
}

class FocusedVault {
    public key: string;
    public tracesData: Trace[] = [];
    public wsConnection: WebSocket | null = null;
    private onBatchTrace: (trace: Trace[]) => void;
    private onClose: () => void;
    private pendingTraces: Trace[] = [];
    private throttleTimeout: NodeJS.Timeout | null = null;
    private throttleInterval: number = 800; // 800ms throttle interval

    constructor(key: string, onBatchTrace: (trace: Trace[]) => void, onClose: () => void) {
        this.key = key;
        this.onBatchTrace = onBatchTrace;
        this.onClose = onClose;
        this.connectToTraceWebSocket(key);
    }

    private connectToTraceWebSocket(vaultSecretKey: string) {
        console.log('Connecting to WebSocket...');

    
        const wsUrl = getConfig().apiUrl.replace(/^http/, 'ws');
        const fullWsUrl = `${wsUrl}/vaults/traces/${vaultSecretKey}/stream`;
        console.log(`Connecting to WebSocket at ${fullWsUrl}`);
    
        this.wsConnection = new WebSocket(fullWsUrl);
    
        this.wsConnection.on('open', () => {
            console.log('WebSocket connection established');
        });
    
        let isFirst = true;
    
        this.wsConnection.on('message', (data: Buffer) => {
            console.log('Received WebSocket message...');
            try {
                const parsedData: Trace | Trace[] = JSON.parse(data.toString());
                if (Array.isArray(parsedData)) {
                    // Initial batch of traces
                    if (isFirst) {
                        console.log(`Received ${parsedData.length} initial traces from WebSocket`);
                        this.tracesData = parsedData; // HERE
                        this.sendTracesImmediately(parsedData); // Send initial traces immediately
                    } else {
                        console.log(`Received ${parsedData.length} new traces from WebSocket`);
                        parsedData.forEach(pd => this.tracesData.push(pd)); // HERE
                        this.queueTracesForSending(parsedData);
                    }
                } else {
                    // Single new trace
                    console.log('Received exactly one new trace from WebSocket: ', parsedData);
                    this.tracesData.push(parsedData); // HERE
                    this.queueTracesForSending([parsedData]);
                }
                isFirst = false;
            } catch (error) {
                console.error('Error processing WebSocket message:', error);
            }
        });
    
        this.wsConnection.on('error', (error: Error) => {
            console.error('WebSocket error:', error);
        });
    
        this.wsConnection.on('close', (code: number, reason: string) => {
            console.log(`WebSocket connection closed: ${code} ${reason}`);
            this.wsConnection = null;
            this.onClose();
        });
    
    
        return this.wsConnection;
    }

    /**
     * Queues traces for throttled sending
     * @param traces The traces to queue
     */
    private queueTracesForSending(traces: Trace[]): void {
        // Add the new traces to the pending traces
        this.pendingTraces.push(...traces);
        
        // If there's no timeout active, schedule one
        if (!this.throttleTimeout) {
            this.throttleTimeout = setTimeout(() => {
                this.sendPendingTraces();
            }, this.throttleInterval);
        }
        // If there is already a timeout, we'll just wait for it
    }

    /**
     * Sends traces immediately without throttling
     * Used for initial batch of traces
     */
    private sendTracesImmediately(traces: Trace[]): void {
        if (traces.length > 0) {
            this.onBatchTrace(traces);
        }
    }

    /**
     * Sends any pending traces and resets the throttle timeout
     */
    private sendPendingTraces(): void {
        if (this.pendingTraces.length > 0) {
            // Create a copy of the pending traces
            const tracesToSend = [...this.pendingTraces];
            // Clear the pending traces
            this.pendingTraces = [];
            // Send the traces
            this.onBatchTrace(tracesToSend);
        }

        // Reset the timeout
        this.throttleTimeout = null;
    }
}
