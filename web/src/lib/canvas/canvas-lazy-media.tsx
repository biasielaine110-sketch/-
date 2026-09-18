import { useEffect, useRef, useState, type ReactNode } from "react";

type CanvasLazyMediaProps = {
    children: ReactNode;
    className?: string;
    /** Shown while media is off-screen / not yet mounted. */
    placeholder?: ReactNode;
    /** Keep media mounted briefly after leaving the viewport to avoid edge flicker. */
    leaveDelayMs?: number;
    rootMargin?: string;
};

/**
 * Mount heavy media (img/video) only while near the viewport; unload when scrolled away.
 * Works with canvas CSS transforms because IntersectionObserver uses the post-transform box.
 */
export function CanvasLazyMedia({ children, className, placeholder, leaveDelayMs = 480, rootMargin = "80px" }: CanvasLazyMediaProps) {
    const ref = useRef<HTMLDivElement>(null);
    const [active, setActive] = useState(false);
    const leaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;

        const clearLeave = () => {
            if (leaveTimerRef.current) {
                clearTimeout(leaveTimerRef.current);
                leaveTimerRef.current = null;
            }
        };

        const observer = new IntersectionObserver(
            ([entry]) => {
                if (entry?.isIntersecting) {
                    clearLeave();
                    setActive(true);
                    return;
                }
                clearLeave();
                leaveTimerRef.current = setTimeout(() => setActive(false), leaveDelayMs);
            },
            { root: null, rootMargin, threshold: 0.01 },
        );
        observer.observe(el);
        return () => {
            observer.disconnect();
            clearLeave();
        };
    }, [leaveDelayMs, rootMargin]);

    return (
        <div ref={ref} className={className || "h-full w-full"}>
            {active ? children : placeholder ?? <div className="h-full w-full bg-black/10" aria-hidden />}
        </div>
    );
}
