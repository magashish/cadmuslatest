/**
 * Client-side logic for the Mortgage Calculator block (.mortgage-calculator).
 *
 * Computes the monthly principal & interest payment via the standard
 * amortization formula and (optionally) renders a per-year amortization table.
 * All instances on the page are initialized independently.
 */

const currency0 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

const currency2 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function num(el: HTMLElement | null): number {
  if (!el) return 0;
  const value = parseFloat((el as HTMLInputElement | HTMLSelectElement).value);
  return Number.isFinite(value) ? value : 0;
}

/**
 * Monthly payment via M = P·(r(1+r)^n)/((1+r)^n − 1).
 * r = 0 edge case (no interest): M = P / n.
 */
function monthlyPayment(principal: number, monthlyRate: number, months: number): number {
  if (months <= 0) return 0;
  if (monthlyRate === 0) return principal / months;
  const factor = Math.pow(1 + monthlyRate, months);
  return (principal * (monthlyRate * factor)) / (factor - 1);
}

function initCalculator(root: HTMLElement): void {
  const priceInput = root.querySelector<HTMLInputElement>('[data-field="price"]');
  const downInput = root.querySelector<HTMLInputElement>('[data-field="down"]');
  const rateInput = root.querySelector<HTMLInputElement>('[data-field="rate"]');
  const termInput = root.querySelector<HTMLSelectElement>('[data-field="term"]');
  // Present only when "Include taxes & insurance" is enabled on the block.
  const taxInput = root.querySelector<HTMLInputElement>('[data-field="tax"]');
  const insuranceInput = root.querySelector<HTMLInputElement>('[data-field="insurance"]');

  const monthlyOut = root.querySelector<HTMLElement>('[data-out="monthly"]');
  const loanOut = root.querySelector<HTMLElement>('[data-out="loan"]');
  const interestOut = root.querySelector<HTMLElement>('[data-out="interest"]');
  const amortBody = root.querySelector<HTMLElement>('[data-out="amortization"]');
  const totalOut = root.querySelector<HTMLElement>('[data-out="total"]');
  const monthlyTaxOut = root.querySelector<HTMLElement>('[data-out="monthlyTax"]');
  const monthlyInsuranceOut = root.querySelector<HTMLElement>('[data-out="monthlyInsurance"]');

  function recompute(): void {
    // Guard against NaN / negative inputs.
    const price = Math.max(0, num(priceInput));
    const downPct = Math.min(100, Math.max(0, num(downInput)));
    const ratePct = Math.max(0, num(rateInput));
    const termYears = Math.max(0, num(termInput));

    const principal = price * (1 - downPct / 100);
    const months = Math.round(termYears * 12);
    const monthlyRate = ratePct / 100 / 12;

    const payment = monthlyPayment(principal, monthlyRate, months);
    const totalPaid = payment * months;
    const totalInterest = Math.max(0, totalPaid - principal);

    // Escrow (property tax + insurance), only when those inputs are present.
    const taxPct = Math.max(0, num(taxInput));
    const insuranceYearly = Math.max(0, num(insuranceInput));
    const monthlyTax = (price * taxPct) / 100 / 12;
    const monthlyInsurance = insuranceYearly / 12;
    const total = payment + monthlyTax + monthlyInsurance;

    if (monthlyOut) monthlyOut.textContent = currency2.format(payment || 0);
    if (loanOut) loanOut.textContent = currency0.format(principal || 0);
    if (interestOut) interestOut.textContent = currency0.format(totalInterest || 0);
    if (totalOut) totalOut.textContent = currency2.format(total || 0);
    if (monthlyTaxOut) monthlyTaxOut.textContent = currency2.format(monthlyTax || 0);
    if (monthlyInsuranceOut)
      monthlyInsuranceOut.textContent = currency2.format(monthlyInsurance || 0);

    if (amortBody) {
      amortBody.innerHTML = buildAmortizationRows(principal, monthlyRate, months, payment);
    }
  }

  function buildAmortizationRows(
    principal: number,
    monthlyRate: number,
    months: number,
    payment: number
  ): string {
    if (months <= 0 || principal <= 0) return "";
    let balance = principal;
    const rows: string[] = [];
    const years = Math.ceil(months / 12);

    for (let year = 1; year <= years; year++) {
      let principalPaid = 0;
      let interestPaid = 0;
      const monthsThisYear = Math.min(12, months - (year - 1) * 12);
      for (let m = 0; m < monthsThisYear; m++) {
        const interest = balance * monthlyRate;
        let principalPortion = payment - interest;
        if (principalPortion > balance) principalPortion = balance;
        balance -= principalPortion;
        principalPaid += principalPortion;
        interestPaid += interest;
      }
      if (balance < 0) balance = 0;
      rows.push(
        `<tr><td>${year}</td><td>${currency0.format(principalPaid)}</td><td>${currency0.format(
          interestPaid
        )}</td><td>${currency0.format(balance)}</td></tr>`
      );
    }
    return rows.join("");
  }

  for (const input of [priceInput, downInput, rateInput, termInput, taxInput, insuranceInput]) {
    input?.addEventListener("input", recompute);
    input?.addEventListener("change", recompute);
  }

  recompute();
}

function initAll(): void {
  document
    .querySelectorAll<HTMLElement>(".mortgage-calculator")
    .forEach((el) => initCalculator(el));
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initAll);
} else {
  initAll();
}
