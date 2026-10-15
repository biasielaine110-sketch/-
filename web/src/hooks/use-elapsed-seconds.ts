import { useEffect, useState } from "react";

/** Live elapsed whole seconds while `active`; resets to 0 when inactive. */
export function useElapsedSeconds(active: boolean) {
    const [seconds, setSeconds] = useState(0);
    useEffect(() => {
        if (!active) {
            setSeconds(0);
            return;
        }
        const startedAt = Date.now();
        setSeconds(0);
        const timer = window.setInterval(() => {
            setSeconds(Math.floor((Date.now() - startedAt) / 1000));
        }, 1000);
        return () => window.clearInterval(timer);
    }, [active]);
    return seconds;
}
