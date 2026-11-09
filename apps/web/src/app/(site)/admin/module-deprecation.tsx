// A deprecated module's notice (`ModuleDef.deprecated`, ADR 69): the
// registry's sentence and a link to what replaces it. One component, so
// Event's Modules row, the module panel's header and both enable
// confirmations say the same thing and the link is always a real link.

import type { ReactNode } from "react";
import type { ModuleDeprecation as Deprecation } from "@/lib/modules";

export default function ModuleDeprecation({ deprecated }: { deprecated: Deprecation }) {
  return (
    <span>
      {deprecated.note}{" "}
      <a href={deprecated.guide.href} target="_blank" rel="noopener noreferrer" className="ds-link">
        {deprecated.guide.label}
      </a>
    </span>
  );
}

/** `text`, followed by the deprecation notice when there is one. */
export function withDeprecation(text: ReactNode, deprecated: Deprecation | undefined): ReactNode {
  if (!deprecated) return text;
  return (
    <>
      {text ? <>{text} </> : null}
      <ModuleDeprecation deprecated={deprecated} />
    </>
  );
}
