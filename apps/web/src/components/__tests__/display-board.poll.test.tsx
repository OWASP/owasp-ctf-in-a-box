// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ refresh: () => {} }) }));

import DisplayBoard from "@/components/display-board";

const rows = [{ key: "a", rank: 1, name: "Byte Me", points: 2108 }];

const seedSolves = [
  {
    team: "Red Team",
    title: "Initial Seed Solve",
    module: "classic" as const,
    points: 50,
    at: "2026-08-24T10:00:00.000Z",
  },
];

const freshSolves = [
  {
    team: "Blue Team",
    title: "Fresh Polled Solve",
    module: "ai" as const,
    points: 100,
    at: "2026-08-24T10:01:00.000Z",
  },
];

describe("DisplayBoard — recent solves polling lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("polls every 15s and clears the feed on non-OK response or fetch error", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    // Successful first poll
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ solves: freshSolves }),
    });

    render(
      <DisplayBoard
        rows={rows}
        eventName="Fixture CTF"
        phaseLabel="live"
        recentSolves={seedSolves}
      />,
    );

    // Initially shows server seed
    expect(screen.getByText("Initial Seed Solve")).toBeDefined();
    expect(screen.queryByText("Fresh Polled Solve")).toBeNull();

    // Advance 15s to trigger first poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    // Shows fresh polled solve
    expect(screen.getByText("Fresh Polled Solve")).toBeDefined();
    expect(screen.queryByText("Initial Seed Solve")).toBeNull();

    // Second poll fails (503 response)
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({ error: "unavailable" }),
    });

    // Advance 15s to trigger second poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    // A failed poll clears the feed; it must not restore the server seed.
    expect(screen.queryByText("Initial Seed Solve")).toBeNull();
    expect(screen.queryByText("Fresh Polled Solve")).toBeNull();
    expect(screen.queryByText("Recent solves")).toBeNull();

    // Third poll succeeds again
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ solves: freshSolves }),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByText("Fresh Polled Solve")).toBeDefined();

    // Fourth poll throws network error
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    // Same rule on a network error: clear, never revive the seed.
    expect(screen.queryByText("Initial Seed Solve")).toBeNull();
    expect(screen.queryByText("Fresh Polled Solve")).toBeNull();
    expect(screen.queryByText("Recent solves")).toBeNull();
  });

  it("does not restore a server-seeded title hidden by an earlier successful poll", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock;

    // A later poll has already filtered "Initial Seed Solve" out because the
    // challenge became hidden, so the seed is no longer safe to render.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ solves: freshSolves }),
    });

    render(
      <DisplayBoard
        rows={rows}
        eventName="Fixture CTF"
        phaseLabel="live"
        recentSolves={seedSolves}
      />,
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByText("Fresh Polled Solve")).toBeDefined();
    expect(screen.queryByText("Initial Seed Solve")).toBeNull();

    // A malformed payload takes the same failure path as an HTTP/network error.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ solves: "not-an-array" }),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(screen.queryByText("Initial Seed Solve")).toBeNull();
    expect(screen.queryByText("Fresh Polled Solve")).toBeNull();
    expect(screen.queryByText("Recent solves")).toBeNull();
  });
});
