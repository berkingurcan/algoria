import { assertLeanV0Feature } from '$lib/server/network/policy';

export function parseMppQuote(_header: string): never {
  assertLeanV0Feature('mppPayment');
  throw new Error('MPP payment is outside lean v0');
}
