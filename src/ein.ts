export const isValidEin = (s: string): boolean => /^\d{2}-?\d{7}$/v.test(s);
