interface AIDrawerButtonProps {
  onClick: () => void;
  badgeCount?: number;
}

export function AIDrawerButton({ onClick, badgeCount = 0 }: AIDrawerButtonProps) {
  return (
    <button type="button" className="ai-fab" onClick={onClick}>
      AI
      {badgeCount > 0 && (
        <span className="ai-fab__badge" aria-label={`${badgeCount} suggestion${badgeCount === 1 ? "" : "s"}`}>
          {badgeCount > 9 ? "9+" : badgeCount}
        </span>
      )}
    </button>
  );
}
