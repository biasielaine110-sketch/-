import { useEffect, useState } from "react";

import { beginElapsed, clearElapsed, elapsedSecondsSince } from "@/hooks/elapsed-seconds-registry";

/**
 * Live elapsed whole seconds while `active`.
 *
 * Canvas nodes are unmounted as soon as they leave the viewport, so a purely
 * component-local timer restarts from 0 every time the user scrolls away and comes
 * back. The start timestamp therefore lives in a module-level registry keyed by `key`
 * (the node id at the call sites), so the counter keeps counting across
 * unmount/remount within the same page session. Without a `key` the hook keeps the old
 * per-mount behaviour.
 *
 * Resets to 0 when `active` turns false, so a new generation always starts from zero.
 */
export function useElapsedSeconds(active: boolean, key?: string | null) {
    // Fallback key unique per mount → keyless callers keep the old reset-on-remount semantics.
    const [mountKey] = useState(() => `__local_${Math.random().toString(36).slice(2)}`);
    const registryKey = key || mountKey;
    const [seconds, setSeconds] = useState(0);

    useEffect(() => {
        if (!active) {
            clearElapsed(registryKey);
            setSeconds(0);
            return;
        }
        const startedAt = beginElapsed(registryKey);
        setSeconds(elapsedSecondsSince(startedAt));
        const timer = window.setInterval(() => {
            setSeconds(elapsedSecondsSince(startedAt));
        }, 1000);
        return () => window.clearInterval(timer);
    }, [active, registryKey]);

    return seconds;
}
