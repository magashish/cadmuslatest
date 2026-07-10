import { useTranslation } from "react-i18next";

interface AIDrawerButtonProps {
  onClick: () => void;
  badgeCount?: number;
}

export function AIDrawerButton({ onClick, badgeCount = 0 }: AIDrawerButtonProps) {
  const { t } = useTranslation();
  return (
    <button type="button" className="ai-fab" onClick={onClick}>
      {t("aiDrawerButton.label")}
      {badgeCount > 0 && (
        <span className="ai-fab__badge" aria-label={t("aiDrawerButton.badgeAriaLabel", { count: badgeCount })}>
          {badgeCount > 9 ? t("aiDrawerButton.badgeMax") : badgeCount}
        </span>
      )}
    </button>
  );
}
