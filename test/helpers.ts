import type * as acp from '@agentclientprotocol/sdk';

export type SelectConfigOption = Extract<acp.SessionConfigOption, { type: 'select' }>;

export function selectById(
  options: acp.SessionConfigOption[] | null | undefined,
  id: string,
): SelectConfigOption {
  const option = options?.find((o) => o.id === id && o.type === 'select') as SelectConfigOption | undefined;
  if (!option) {
    throw new Error(`No select config option with id "${id}"`);
  }
  return option;
}