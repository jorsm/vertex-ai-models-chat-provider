import * as vscode from "vscode";

/** Release the caller immediately even if credential acquisition has not settled yet. */
export function cancellableRequest<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const cancel = () => {
            signal.removeEventListener("abort", cancel);
            reject(new vscode.CancellationError());
        };
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) {
            cancel();
            return;
        }
        Promise.resolve()
            .then(() => {
                if (signal.aborted) {
                    throw new vscode.CancellationError();
                }
                return operation();
            })
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", cancel));
    });
}

export function requestCancellation(token: vscode.CancellationToken, parent?: AbortSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const subscription = token.onCancellationRequested(abort);
    parent?.addEventListener("abort", abort, { once: true });
    if (token.isCancellationRequested || parent?.aborted) {
        abort();
    }
    return {
        signal: controller.signal,
        dispose() {
            subscription.dispose();
            parent?.removeEventListener("abort", abort);
        },
    };
}
