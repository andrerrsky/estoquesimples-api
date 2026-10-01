/**
 * CPF e CNPJ: o Asaas exige um documento válido para criar o pagador.
 * Validar os dígitos aqui devolve o erro na hora, com mensagem nossa, em vez
 * de um 400 do provedor.
 */

export function onlyDigits(value: string): string {
  return value.replace(/\D+/g, '');
}

function allSame(digits: string): boolean {
  return /^(\d)\1+$/.test(digits);
}

export function isValidCpf(value: string): boolean {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11 || allSame(cpf)) return false;
  const digit = (length: number): number => {
    let sum = 0;
    for (let i = 0; i < length; i += 1) sum += Number(cpf[i]) * (length + 1 - i);
    const rest = (sum * 10) % 11;
    return rest === 10 ? 0 : rest;
  };
  return digit(9) === Number(cpf[9]) && digit(10) === Number(cpf[10]);
}

export function isValidCnpj(value: string): boolean {
  const cnpj = onlyDigits(value);
  if (cnpj.length !== 14 || allSame(cnpj)) return false;
  const digit = (length: number): number => {
    const weights = length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < length; i += 1) sum += Number(cnpj[i]) * (weights[i] ?? 0);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return digit(12) === Number(cnpj[12]) && digit(13) === Number(cnpj[13]);
}

export function documentType(value: string): 'CPF' | 'CNPJ' | null {
  const digits = onlyDigits(value);
  if (digits.length === 11 && isValidCpf(digits)) return 'CPF';
  if (digits.length === 14 && isValidCnpj(digits)) return 'CNPJ';
  return null;
}

/** "CPF final 09" / "CNPJ final 0001-91": o suficiente para reconhecer. */
export function documentHint(value: string): string {
  const digits = onlyDigits(value);
  return digits.length === 14 ? `final ${digits.slice(8, 12)}-${digits.slice(12)}` : `final ${digits.slice(-2)}`;
}
