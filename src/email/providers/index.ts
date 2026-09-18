import { PermanentError } from '../../lib/errors';
import { GraphMailProvider } from './graph';
import { SesMailProvider } from './ses';
import type { MailProviderAdapter } from './types';

const registry: Record<string, MailProviderAdapter> = {
  msgraph: new GraphMailProvider(),
  ses: new SesMailProvider(),
};

export function getProvider(name: string): MailProviderAdapter {
  const provider = registry[name];
  if (!provider) {
    throw new PermanentError(`Unknown mail provider "${name}"`, 'UNKNOWN_PROVIDER');
  }
  return provider;
}

export * from './types';
export { pollMailboxReplies } from './graph';
