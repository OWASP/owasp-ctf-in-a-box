// The first-blood line on a board tile and an open story step (#188): who
// solved the challenge first, by login. A Server Component with no state, so
// both server-rendered surfaces share one spelling of it.

export default function FirstBloodLine({ login }: { login: string }) {
  return (
    <span className="truncate font-mono text-[11px] text-[#f87171]" title={`First blood: ${login}`}>
      <span aria-hidden>🩸 </span>First blood: {login}
    </span>
  );
}
