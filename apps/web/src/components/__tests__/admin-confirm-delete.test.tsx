// The delete confirmation every module admin panel (quiz, classic)
// renders once an organizer clicks Delete: `ConfirmModal` in its destructive,
// type-to-confirm shape, plus the error line a failed DELETE lands on. This
// repo's tests run `renderToStaticMarkup` in vitest's node environment, so the
// type-gating is proven the same way the panels' own tests prove it — the
// Confirm button is `disabled` on first render whenever `requireType` is
// non-empty — and the pending-guarded cancel through a direct call.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ConfirmDelete, { guardedCancel } from "@/components/admin/confirm-delete";

const copy = {
  title: 'Delete "SQL Injection 101"?',
  body: "This removes the challenge (id sql-injection-101-ab12cd) from the board.",
  requireType: "SQL Injection 101",
  confirmLabel: "Delete challenge",
};

const noop = () => {};

describe("ConfirmDelete", () => {
  it("renders the copy and keeps Confirm disabled until the phrase is typed", () => {
    const html = renderToStaticMarkup(<ConfirmDelete copy={copy} error={null} pending={false} onConfirm={noop} onCancel={noop} />);
    expect(html).toContain("Delete &quot;SQL Injection 101&quot;?");
    expect(html).toContain("This removes the challenge (id sql-injection-101-ab12cd) from the board.");
    expect(html).toContain("Type <code");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Delete challenge</);
  });

  it("shows a failed delete's message under the body, in the panel's error colour", () => {
    const html = renderToStaticMarkup(
      <ConfirmDelete copy={copy} error="Store unavailable — try again shortly." pending={false} onConfirm={noop} onCancel={noop} />,
    );
    expect(html).toContain('<span class="mt-2 block text-[#e53e3e]">Store unavailable — try again shortly.</span>');
  });

  it("renders no error line when there is nothing to report", () => {
    const html = renderToStaticMarkup(<ConfirmDelete copy={copy} error={null} pending={false} onConfirm={noop} onCancel={noop} />);
    expect(html).not.toContain('<span class="mt-2 block text-[#e53e3e]">');
  });
});

describe("guardedCancel", () => {
  it("ignores Cancel while the delete is in flight", () => {
    const onCancel = vi.fn();
    guardedCancel(true, onCancel)();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels when nothing is in flight", () => {
    const onCancel = vi.fn();
    guardedCancel(false, onCancel)();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
