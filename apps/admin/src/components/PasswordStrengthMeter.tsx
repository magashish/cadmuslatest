interface PasswordStrengthMeterProps {
  password: string;
}

export const REQUIREMENTS = [
  { label: "At least 12 characters", test: (p: string) => p.length >= 12 },
  { label: "Uppercase letter", test: (p: string) => /[A-Z]/.test(p) },
  { label: "Number or symbol", test: (p: string) => /[0-9!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(p) },
];

export function meetsPasswordRequirements(password: string): boolean {
  return REQUIREMENTS.every(({ test }) => test(password));
}

export function PasswordStrengthMeter({ password }: PasswordStrengthMeterProps) {
  if (password.length === 0) return null;

  return (
    <ul style={{ margin: "0.5rem 0 0", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      {REQUIREMENTS.map(({ label, test }) => {
        const met = test(password);
        return (
          <li key={label} style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.8rem", color: met ? "#16a34a" : "#6b7280" }}>
            <span style={{ fontSize: "1em", lineHeight: 1 }}>{met ? "✓" : "○"}</span>
            {label}
          </li>
        );
      })}
    </ul>
  );
}
