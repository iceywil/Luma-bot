// Reads the account's registration status for an event while the user submits the form themselves.
//
// It opens its own background tab in the same Chrome (same session, same fingerprint) and asks Luma's
// API from there, over a raw DevTools connection that only attaches to that tab: the event tab the user
// is on stays unattached.

// Statuses meaning the application went through
export const SUBMITTED_STATUSES = ["approved", "pending_approval", "waitlist", "declined", "invited"];

export interface StatusProbe {
    // Luma's approval_status for the account on this event, or null if not registered (or unknown)
    status: (eventApiId: string) => Promise<string | null>;
    close: () => Promise<void>;
}

export async function openStatusProbe(port: number): Promise<StatusProbe> {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve();
        socket.onerror = () => reject(new Error(`DevTools connection failed on port ${port}`));
    });

    let nextId = 1;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
    };
    const send = (method: string, params: object = {}, sessionId?: string): Promise<any> =>
        new Promise((resolve, reject) => {
            const id = nextId++;
            pending.set(id, { resolve, reject });
            socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        });

    // A light page on luma.com, so the API calls carry the luma.com session like the site's own
    const { targetId } = await send("Target.createTarget", { url: "https://luma.com/robots.txt", background: true });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });

    return {
        status: async (eventApiId) => {
            const expression = `fetch("https://api.luma.com/event/get?event_api_id=${eventApiId}", { credentials: "include" })
                .then((r) => (r.ok ? r.json() : null))
                .then((data) => (data?.guest_data ?? data?.role ?? data?.guest_info)?.approval_status ?? null)
                .catch(() => null)`;
            try {
                const { result } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
                return typeof result?.value === "string" ? result.value.toLowerCase() : null;
            } catch {
                return null;
            }
        },
        close: async () => {
            await send("Target.closeTarget", { targetId }).catch(() => {});
            socket.close();
        },
    };
}
