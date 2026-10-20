// Blocks before any test registers — the signature of a child pointed at an
// unreachable app. Used to prove the unreachable early-abort fires.
//
// A bare `await new Promise(() => {})` does NOT hold the Node event loop
// open: Node detects the unsettled top-level await and exits on its own after
// ~100ms, printing a duration_ms summary — which would make this fixture
// report instead of hang. A live timer is what actually blocks the process,
// so only the runner's own safety-kill can end it.
await new Promise((resolve) => setTimeout(resolve, 600_000));
