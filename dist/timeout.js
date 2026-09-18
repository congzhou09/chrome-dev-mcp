// Bounding for CDP commands that a wedged or idle renderer may never answer.
//
// Returned in place of the value when `promise` outlives `ms`.
//
// A sentinel rather than a rejection because "this target never answered" is an expected
// state to branch on, not an error: a renderer paused at a breakpoint or spinning in a
// synchronous loop replies to nothing and rejects nothing. The loser of the race is
// abandoned, never awaited — if it does eventually settle, nothing is listening.
export const TIMED_OUT = Symbol('timed-out');
export const withTimeout = async (promise, ms) => {
    let timer;
    const expiry = new Promise((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
        // Never hold the process open just to fire a timeout.
        timer.unref?.();
    });
    try {
        return await Promise.race([promise, expiry]);
    }
    finally {
        clearTimeout(timer);
    }
};
